import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { Connection, mongo, Types } from 'mongoose';
import { WorkspaceBackupPreview } from './workspace-backup.schema';
import { Collection } from './collection.schema';
import { Entry } from './entry.schema';
import { EntryLink } from './entry-link.schema';
import { EntryRelation } from './relation.schema';
import { StockMovement } from './stock.schema';
import { EntryReminder, ReminderDelivery } from './reminder.schema';
import { AuditLog } from './collaboration.schema';
import { MoveOperation } from './move-operation.schema';
import { ContributionLink, ContributionSubmission } from './contribution.schema';

type Kind = 'collections' | 'entries' | 'entryLinks' | 'relations' | 'stockMovements' | 'reminders' | 'deliveries' | 'auditLogs' | 'moves' | 'contributionLinks' | 'contributionSubmissions';
const legacyKinds: Kind[] = ['collections', 'entries', 'entryLinks', 'relations', 'stockMovements', 'reminders', 'deliveries', 'auditLogs', 'moves'];
const kinds: Kind[] = [...legacyKinds, 'contributionLinks', 'contributionSubmissions'];
const modelName: Record<Kind, string> = { collections: Collection.name, entries: Entry.name, entryLinks: EntryLink.name, relations: EntryRelation.name, stockMovements: StockMovement.name, reminders: EntryReminder.name, deliveries: ReminderDelivery.name, auditLogs: AuditLog.name, moves: MoveOperation.name, contributionLinks: ContributionLink.name, contributionSubmissions: ContributionSubmission.name };
type Archive = { brainyWorkspaceVersion: 1; ownerId: string; exportedAt: string; data: Record<Kind, string[]>; checksum: string };

function checksum(data: Archive['data']): string { return createHash('sha256').update(JSON.stringify(data)).digest('hex'); }
function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sort(child)])) : item;
  return JSON.stringify(sort(JSON.parse(mongo.BSON.EJSON.stringify(value, { relaxed: false }))));
}

@Injectable()
export class WorkspaceBackupService {
  constructor(@InjectConnection() private readonly connection: Connection) {}
  private collection(kind: Kind) { return this.connection.db!.collection(this.connection.model(modelName[kind]).collection.name); }
  private encode(rows: unknown[]): string[] { return rows.map((row) => mongo.BSON.EJSON.stringify(row, { relaxed: false })); }

  async export(userId: string): Promise<string> {
    const collections = await this.collection('collections').find({ ownerId: userId }).toArray();
    const ids = collections.map((item) => item._id.toString());
    const activeMoves = await this.collection('moves').countDocuments({ ownerId: userId, state: { $in: ['PLANNED', 'PREPARED', 'COPIED', 'RECOVERING'] } });
    if (activeMoves) throw new BadRequestException('Wait for active moves to finish before backing up');
    const query = { collectionId: { $in: ids } };
    const [entries, entryLinks, relations, stockMovements, reminders, auditLogs, moves, contributionLinks, contributionSubmissions] = await Promise.all([
      this.collection('entries').find(query).toArray(), this.collection('entryLinks').find(query).toArray(), this.collection('relations').find(query).toArray(), this.collection('stockMovements').find(query).toArray(), this.collection('reminders').find(query).toArray(), this.collection('auditLogs').find(query).toArray(), this.collection('moves').find({ ownerId: userId, sourceCollectionId: { $in: ids }, targetCollectionId: { $in: ids } }).toArray(), this.collection('contributionLinks').find(query).toArray(), this.collection('contributionSubmissions').find(query).toArray(),
    ]);
    const deliveries = await this.collection('deliveries').find({ ownerId: userId, reminderId: { $in: reminders.map((item) => item._id.toString()) } }).toArray();
    const data: Archive['data'] = { collections: this.encode(collections), entries: this.encode(entries), entryLinks: this.encode(entryLinks), relations: this.encode(relations), stockMovements: this.encode(stockMovements), reminders: this.encode(reminders), deliveries: this.encode(deliveries), auditLogs: this.encode(auditLogs), moves: this.encode(moves), contributionLinks: this.encode(contributionLinks), contributionSubmissions: this.encode(contributionSubmissions) };
    const result = JSON.stringify({ brainyWorkspaceVersion: 1, ownerId: userId, exportedAt: new Date().toISOString(), data, checksum: checksum(data) });
    if (result.length > 50_000_000) throw new BadRequestException('Workspace backup exceeds 50 MB. Export collections separately until large backups are available');
    return result;
  }

  private parse(raw: string, userId: string): { archive: Archive; docs: Record<Kind, Record<string, unknown>[]> } {
    if (raw.length > 50_000_000) throw new BadRequestException('Backup file exceeds 50 MB');
    let archive: Archive;
    try { archive = JSON.parse(raw) as Archive; } catch { throw new BadRequestException('Invalid backup file'); }
    if (archive.brainyWorkspaceVersion !== 1 || archive.ownerId !== userId || !archive.data || typeof archive.checksum !== 'string' || checksum(archive.data) !== archive.checksum || legacyKinds.some((kind) => !Array.isArray(archive.data[kind]))) throw new BadRequestException('Backup version, owner or checksum is invalid');
    for (const kind of ['contributionLinks', 'contributionSubmissions'] as const) {
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
    const linkIds = new Set(docs.contributionLinks.map((item) => item._id!.toString()));
    for (const link of docs.contributionLinks) if (!collectionIds.has(String(link.collectionId)) || !docs.collections.some((item) => item._id!.toString() === String(link.collectionId) && ((item.formats as { id: string }[] | undefined) ?? []).some((format) => format.id === link.formatId))) conflicts.push('A contribution link is outside this workspace or has no data format');
    for (const submission of docs.contributionSubmissions) if (!collectionIds.has(String(submission.collectionId)) || !linkIds.has(String(submission.linkId)) || (submission.acceptedEntryId && !entryIds.has(String(submission.acceptedEntryId)))) conflicts.push('A contribution submission has a missing link or accepted entry');
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
