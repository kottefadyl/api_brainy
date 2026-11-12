import { isMediaFile, MEDIA_REFUSED } from '../media-guard.js';
import { isFrozen } from '../platform.js';
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { mongo, Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { WorkspaceBackupPreview } from './workspace-backup.schema.js';
import { Collection } from './collection.schema.js';
import { Entry } from './entry.schema.js';
import { EntryLink } from './entry-link.schema.js';
import { EntryRelation } from './relation.schema.js';
import { StockLedgerHead, StockMovement } from './stock.schema.js';
import { EntryReminder, ReminderDelivery } from './reminder.schema.js';
import { AuditLog } from './collaboration.schema.js';
import { MoveOperation } from './move-operation.schema.js';
import { ContributionLink, ContributionSubmission } from './contribution.schema.js';
import { LedgerHead, LedgerRedaction } from './ledger.schema.js';
import { LedgerService, verifyLedgerRows } from './ledger.service.js';
import { StockLedgerService, verifyStockRows } from './stock-ledger.service.js';
import { hasProtectedData } from './sensitivity.logic.js';
import { CollaborationService } from './collaboration.service.js';
import { LargeFile } from './large-file.schema.js';
import { StoredCode } from './code-list-store.schema.js';

// T44: large files are listed by reference (metadata only); their content stays in object storage.
const largeFileNotice = 'Large files are not inside this backup. Each largeFiles item lists the name, size, type, SHA-256 fingerprint and storage key. Download them from Brainy (entry > attachment > download, a 5-minute signed link) or ask the storage administrator for the listed bucket/key. After a restore, a file absent from storage shows as missing.';

type Kind = 'collections' | 'entries' | 'entryLinks' | 'relations' | 'stockMovements' | 'reminders' | 'deliveries' | 'auditLogs' | 'moves' | 'contributionLinks' | 'contributionSubmissions' | 'ledgerHeads' | 'ledgerRedactions' | 'stockLedgerHeads' | 'storedCodes' | 'largeFiles';
const legacyKinds: Kind[] = ['collections', 'entries', 'entryLinks', 'relations', 'stockMovements', 'reminders', 'deliveries', 'auditLogs', 'moves'];
const kinds: Kind[] = [...legacyKinds, 'contributionLinks', 'contributionSubmissions', 'ledgerHeads', 'ledgerRedactions', 'stockLedgerHeads', 'largeFiles', 'storedCodes'];
const modelName: Record<Kind, string> = { storedCodes: StoredCode.name, collections: Collection.name, entries: Entry.name, entryLinks: EntryLink.name, relations: EntryRelation.name, stockMovements: StockMovement.name, reminders: EntryReminder.name, deliveries: ReminderDelivery.name, auditLogs: AuditLog.name, moves: MoveOperation.name, contributionLinks: ContributionLink.name, contributionSubmissions: ContributionSubmission.name, ledgerHeads: LedgerHead.name, ledgerRedactions: LedgerRedaction.name, stockLedgerHeads: StockLedgerHead.name, largeFiles: LargeFile.name };
type Archive = { brainyWorkspaceVersion: 1; ownerId: string; exportedAt: string; data: Record<Kind, string[]>; checksum: string; largeFileNotice?: string };

function checksum(data: Archive['data']): string { return createHash('sha256').update(JSON.stringify(data)).digest('hex'); }
function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sort(child)])) : item;
  return JSON.stringify(sort(JSON.parse(mongo.BSON.EJSON.stringify(value, { relaxed: false }))));
}

@Injectable()
export class WorkspaceBackupService {
  constructor(@InjectConnection() private readonly connection: Connection, private readonly ledger: LedgerService, private readonly stockLedger: StockLedgerService, private readonly collaboration: CollaborationService) {}
  private collection(kind: Kind) { return this.connection.db!.collection(this.connection.model(modelName[kind]).collection.name); }
  private encode(rows: unknown[]): string[] { return rows.map((row) => mongo.BSON.EJSON.stringify(row, { relaxed: false })); }

  async export(userId: string, includeSensitive = false): Promise<string> {
    const collections = await this.collection('collections').find({ ownerId: userId }).toArray();
    const protectedCollections = collections.filter((item) => hasProtectedData(item as unknown as Collection));
    if (protectedCollections.length && !includeSensitive) throw new BadRequestException('Choose explicitly to include protected data in a complete workspace backup');
    const ids = collections.map((item) => item._id.toString());
    for (const collection of collections) for (const format of ((collection.formats as { id: string; appendOnly?: boolean }[] | undefined) ?? [])) if (format.appendOnly) {
      const integrity = await this.ledger.verify(collection._id.toString(), format.id, userId);
      if (!integrity.valid) throw new BadRequestException(`Register integrity failed: ${integrity.problem}`);
    }
    const activeMoves = await this.collection('moves').countDocuments({ ownerId: userId, state: { $in: ['PLANNED', 'PREPARED', 'COPIED', 'RECOVERING'] } });
    if (activeMoves) throw new BadRequestException('Wait for active moves to finish before backing up');
    const query = { collectionId: { $in: ids } };
    const [entries, entryLinks, relations, stockMovements, reminders, auditLogs, moves, contributionLinks, contributionSubmissions, ledgerHeads, ledgerRedactions, stockLedgerHeads] = await Promise.all([
      this.collection('entries').find(query).toArray(), this.collection('entryLinks').find(query).toArray(), this.collection('relations').find(query).toArray(), this.collection('stockMovements').find(query).toArray(), this.collection('reminders').find(query).toArray(), this.collection('auditLogs').find(query).toArray(), this.collection('moves').find({ ownerId: userId, sourceCollectionId: { $in: ids }, targetCollectionId: { $in: ids } }).toArray(), this.collection('contributionLinks').find(query).toArray(), this.collection('contributionSubmissions').find(query).toArray(), this.collection('ledgerHeads').find(query).toArray(), this.collection('ledgerRedactions').find(query).toArray(), this.collection('stockLedgerHeads').find(query).toArray(),
    ]);
    const deliveries = await this.collection('deliveries').find({ ownerId: userId, reminderId: { $in: reminders.map((item) => item._id.toString()) } }).toArray();
    for (const head of stockLedgerHeads) {
      const integrity = await this.stockLedger.verify(String(head.collectionId), String(head.productId), userId);
      if (!integrity.valid) throw new BadRequestException(`Stock integrity failed: ${integrity.problem}`);
    }
    // T39/3: codes of large lists, stored apart from their collection.
    const storedCodes = await this.collection('storedCodes').find({ collectionId: { $in: ids } }).toArray();
    const largeFiles = await this.collection('largeFiles').find({ collectionId: { $in: ids }, state: { $in: ['COMPLETE', 'AVAILABLE', 'MISSING', 'CORRUPTED'] } }).project({ uploadId: 0 }).toArray();
    const data: Archive['data'] = { storedCodes: this.encode(storedCodes), collections: this.encode(collections), entries: this.encode(entries), entryLinks: this.encode(entryLinks), relations: this.encode(relations), stockMovements: this.encode(stockMovements), reminders: this.encode(reminders), deliveries: this.encode(deliveries), auditLogs: this.encode(auditLogs), moves: this.encode(moves), contributionLinks: this.encode(contributionLinks), contributionSubmissions: this.encode(contributionSubmissions), ledgerHeads: this.encode(ledgerHeads), ledgerRedactions: this.encode(ledgerRedactions), stockLedgerHeads: this.encode(stockLedgerHeads), largeFiles: this.encode(largeFiles) };
    const result = JSON.stringify({ brainyWorkspaceVersion: 1, ownerId: userId, exportedAt: new Date().toISOString(), data, checksum: checksum(data), ...(largeFiles.length ? { largeFileNotice } : {}) });
    if (result.length > 50_000_000) throw new BadRequestException('Workspace backup exceeds 50 MB. Export collections separately until large backups are available');
    for (const collection of protectedCollections) await this.collaboration.logAction(collection._id.toString(), userId, 'EXPORT_PROTECTED_DATA', 'Complete workspace backup');
    return result;
  }

  private parse(raw: string, userId: string): { archive: Archive; docs: Record<Kind, Record<string, unknown>[]> } {
    if (raw.length > 50_000_000) throw new BadRequestException('Backup file exceeds 50 MB');
    let archive: Archive;
    try { archive = JSON.parse(raw) as Archive; } catch { throw new BadRequestException('Invalid backup file'); }
    if (archive.brainyWorkspaceVersion !== 1 || archive.ownerId !== userId || !archive.data || typeof archive.checksum !== 'string' || checksum(archive.data) !== archive.checksum || legacyKinds.some((kind) => !Array.isArray(archive.data[kind]))) throw new BadRequestException('Backup version, owner or checksum is invalid');
    for (const kind of ['contributionLinks', 'contributionSubmissions', 'ledgerHeads', 'ledgerRedactions', 'stockLedgerHeads', 'largeFiles', 'storedCodes'] as const) {
      if (archive.data[kind] !== undefined && !Array.isArray(archive.data[kind])) throw new BadRequestException('Backup version, owner or checksum is invalid');
      archive.data[kind] ??= [];
    }
    const docs = Object.fromEntries(kinds.map((kind) => [kind, archive.data[kind].map((row) => { try { return mongo.BSON.EJSON.parse(row) as Record<string, unknown>; } catch { throw new BadRequestException(`Invalid ${kind} document`); } })])) as Record<Kind, Record<string, unknown>[]>;
    for (const kind of kinds) for (const doc of docs[kind]) if (!doc._id || !Types.ObjectId.isValid(doc._id.toString())) throw new BadRequestException(`Invalid ${kind} ID`);
    return { archive, docs };
  }

  async restore(raw: string, userId: string, dryRun: boolean): Promise<WorkspaceBackupPreview> {
    const { docs } = this.parse(raw, userId);
    const collectionIds = new Set(docs.collections.map((item) => item._id!.toString()));
    const entryIds = new Set(docs.entries.map((item) => item._id!.toString()));
    const reminderIds = new Set(docs.reminders.map((item) => item._id!.toString()));
    const conflicts: string[] = [];
    if (collectionIds.size !== docs.collections.length || entryIds.size !== docs.entries.length) conflicts.push('Duplicate collection or entry IDs in backup');
    for (const collection of docs.collections) if (collection.ownerId !== userId) conflicts.push('A collection belongs to another account');
    // On Vercel's free plan a backup holding pictures, videos or PDF files cannot be restored as is.
    if (isFrozen('mediaFiles') && docs.entries.some((entry) => ((entry.values as { value?: string; attachmentMimeType?: string; attachmentData?: unknown }[] | undefined) ?? []).some((value) => value.attachmentData && isMediaFile(value.value ?? '', value.attachmentMimeType)))) conflicts.push(MEDIA_REFUSED);
    for (const collection of docs.collections) {
      const lists = (collection.codeLists as { id: string; codes: { code: string }[] }[] | undefined) ?? [];
      const listIds = new Set(lists.map((list) => list.id));
      for (const format of ((collection.formats as { fields: { kind: string; codeListId?: string }[] }[] | undefined) ?? [])) for (const field of format.fields) {
        if (field.kind === 'CODE' && !listIds.has(field.codeListId ?? '')) conflicts.push('A code field has no local code list');
      }
    }
    for (const entry of docs.entries) {
      if (!collectionIds.has(String(entry.collectionId)) || entry.ownerId !== userId) conflicts.push('An entry is outside the workspace');
      const collection = docs.collections.find((item) => item._id!.toString() === entry.collectionId);
      if (!((collection?.formats as { id: string }[] | undefined) ?? []).some((format) => format.id === entry.formatId)) conflicts.push('An entry has no data format');
    }
    for (const kind of ['entryLinks', 'relations'] as const) for (const edge of docs[kind]) if (!collectionIds.has(String(edge.collectionId)) || (!edge.deletedAt && (!entryIds.has(String(edge.fromEntryId)) || !entryIds.has(String(edge.toEntryId))))) conflicts.push('An active relation has a missing endpoint');
    for (const movement of docs.stockMovements) if (!collectionIds.has(String(movement.collectionId)) || !entryIds.has(String(movement.productId)) || movement.ownerId !== userId) conflicts.push('A stock movement has a missing product');
    for (const reminder of docs.reminders) if (!entryIds.has(String(reminder.entryId)) || reminder.ownerId !== userId) conflicts.push('A reminder has a missing entry');
    for (const delivery of docs.deliveries) if (!reminderIds.has(String(delivery.reminderId)) || delivery.ownerId !== userId) conflicts.push('A reminder delivery has no reminder');
    for (const move of docs.moves) if (move.ownerId !== userId || !collectionIds.has(String(move.sourceCollectionId)) || !collectionIds.has(String(move.targetCollectionId)) || ['PLANNED', 'PREPARED', 'COPIED', 'RECOVERING'].includes(String(move.state))) conflicts.push('A move is incomplete or outside the workspace');
    for (const kind of ['entryLinks', 'relations', 'stockMovements', 'reminders', 'deliveries'] as const) for (const doc of docs[kind]) if (doc.ownerId !== userId || (kind !== 'deliveries' && !collectionIds.has(String(doc.collectionId)))) conflicts.push(`${kind} contains data outside this account`);
    for (const audit of docs.auditLogs) if (!collectionIds.has(String(audit.collectionId))) conflicts.push('An audit event is outside this workspace');
    for (const code of docs.storedCodes) if (!collectionIds.has(String(code.collectionId))) conflicts.push('A code of a large list is outside this workspace');
    for (const file of docs.largeFiles) if (file.ownerId !== userId || !collectionIds.has(String(file.collectionId)) || file.state === 'UPLOADING') conflicts.push('A large file reference is outside this workspace');
    const linkIds = new Set(docs.contributionLinks.map((item) => item._id!.toString()));
    for (const link of docs.contributionLinks) if (!collectionIds.has(String(link.collectionId)) || !docs.collections.some((item) => item._id!.toString() === String(link.collectionId) && ((item.formats as { id: string }[] | undefined) ?? []).some((format) => format.id === link.formatId))) conflicts.push('A contribution link is outside this workspace or has no data format');
    for (const submission of docs.contributionSubmissions) if (!collectionIds.has(String(submission.collectionId)) || !linkIds.has(String(submission.linkId)) || (submission.acceptedEntryId && !entryIds.has(String(submission.acceptedEntryId)))) conflicts.push('A contribution submission has a missing link or accepted entry');
    for (const head of docs.ledgerHeads) if (!collectionIds.has(String(head.collectionId)) || head.ownerId !== userId || !docs.collections.some((item) => item._id!.toString() === String(head.collectionId) && ((item.formats as { id: string; appendOnly?: boolean }[] | undefined) ?? []).some((format) => format.id === head.formatId && format.appendOnly))) conflicts.push('A register head is outside this workspace or has no register');
    for (const redaction of docs.ledgerRedactions) if (!collectionIds.has(String(redaction.collectionId)) || !entryIds.has(String(redaction.entryId)) || redaction.ownerId !== userId) conflicts.push('A register redaction has a missing writing');
    for (const head of docs.stockLedgerHeads) if (!collectionIds.has(String(head.collectionId)) || !entryIds.has(String(head.productId)) || head.ownerId !== userId) conflicts.push('A stock integrity head has a missing product');
    for (const collection of docs.collections) for (const format of ((collection.formats as { id: string; appendOnly?: boolean }[] | undefined) ?? [])) if (format.appendOnly && !docs.ledgerHeads.some((head) => String(head.collectionId) === collection._id!.toString() && head.formatId === format.id)) conflicts.push('A register has no head');
    const hydrate = <T>(kind: Kind, row: Record<string, unknown>): T => this.connection.model(modelName[kind]).hydrate(row) as T;
    for (const collection of docs.collections) for (const format of ((collection.formats as { id: string; appendOnly?: boolean }[] | undefined) ?? [])) if (format.appendOnly) {
      const collectionId = String(collection._id);
      const head = docs.ledgerHeads.find((item) => String(item.collectionId) === collectionId && item.formatId === format.id);
      const rows = docs.entries.filter((item) => item.collectionId === collectionId && item.formatId === format.id).sort((a, b) => Number(a.ledgerSequence) - Number(b.ledgerSequence) || String(a._id).localeCompare(String(b._id)));
      const redactions = docs.ledgerRedactions.filter((item) => item.collectionId === collectionId && item.formatId === format.id).sort((a, b) => Number(a.sequence) - Number(b.sequence));
      const integrity = await verifyLedgerRows(head ? hydrate<LedgerHead>('ledgerHeads', head) : null, rows.map((item) => hydrate<Entry>('entries', item)), redactions.map((item) => hydrate<LedgerRedaction>('ledgerRedactions', item)));
      if (!integrity.valid) conflicts.push(`Register ${format.id}: ${integrity.problem}`);
    }
    for (const head of docs.stockLedgerHeads) {
      const rows = docs.stockMovements.filter((item) => item.collectionId === head.collectionId && item.productId === head.productId).sort((a, b) => new Date(String(a.createdAt)).getTime() - new Date(String(b.createdAt)).getTime() || String(a._id).localeCompare(String(b._id)));
      const integrity = await verifyStockRows(hydrate<StockLedgerHead>('stockLedgerHeads', head), rows.map((item) => hydrate<StockMovement>('stockMovements', item)));
      if (!integrity.valid) conflicts.push(`Stock ${head.productId}: ${integrity.problem}`);
    }
    for (const kind of kinds) {
      const native = this.collection(kind);
      const existing = await native.find({ _id: { $in: docs[kind].map((doc) => doc._id as Types.ObjectId) } }).toArray();
      const byId = new Map(existing.map((doc) => [doc._id.toString(), canonical(doc)]));
      for (const doc of docs[kind]) if (byId.has(doc._id!.toString()) && byId.get(doc._id!.toString()) !== canonical(doc)) conflicts.push(`${kind}: ${doc._id} already exists with different content`);
    }
    const preview: WorkspaceBackupPreview = { version: 1, collections: docs.collections.length, entries: docs.entries.length, relations: docs.relations.length, stockMovements: docs.stockMovements.length, conflicts: [...new Set(conflicts)].slice(0, 100), allowed: conflicts.length === 0, restored: false };
    if (dryRun || !preview.allowed) return preview;
    for (const kind of kinds) for (let start = 0; start < docs[kind].length; start += 100) {
      const native = this.collection(kind);
      const batch = docs[kind].slice(start, start + 100);
      const existing = await native.find({ _id: { $in: batch.map((doc) => doc._id as Types.ObjectId) } }).toArray();
      const found = new Set(existing.map((doc) => doc._id.toString()));
      const missing = batch.filter((doc) => !found.has(doc._id!.toString()));
      if (missing.length) try { await native.insertMany(missing as never[], { ordered: false }); } catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
      const after = await native.find({ _id: { $in: batch.map((doc) => doc._id as Types.ObjectId) } }).toArray();
      const byId = new Map(after.map((doc) => [doc._id.toString(), canonical(doc)]));
      if (batch.some((doc) => byId.get(doc._id!.toString()) !== canonical(doc))) throw new BadRequestException(`Restore conflict in ${kind}`);
    }
    return { ...preview, restored: true };
  }
}
