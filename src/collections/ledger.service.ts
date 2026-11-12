import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { Collection, CollectionFormat, FieldKind } from './collection.schema.js';
import { CollectionRole } from './collaboration.schema.js';
import { CollaborationService } from './collaboration.service.js';
import { Entry, EntryValue } from './entry.schema.js';
import { ContributionLink } from './contribution.schema.js';
import { LedgerHead, LedgerIntegrity, LedgerRedaction } from './ledger.schema.js';
import { decimal, fractionText } from './unit_math.js';

function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : item && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sort(child)])) : item;
  return JSON.stringify(sort(JSON.parse(JSON.stringify(value))));
}

function hashValue(value: EntryValue): string {
  const plain = (value as EntryValue & { toObject?: () => unknown }).toObject?.() ?? value;
  return createHash('sha256').update(canonical(plain)).digest('hex');
}

function digest(entry: Entry, previous: string, sequence: number): string {
  return createHash('sha256').update(canonical({ version: 1, previous, sequence,
    entryId: entry.id, ownerId: entry.ownerId, collectionId: entry.collectionId, formatId: entry.formatId,
    formatVersion: entry.formatVersion, createdAt: entry.createdAt, updatedAt: entry.updatedAt,
    correctionOf: entry.correctionOf ?? null,
    values: Array.from(entry.values, (value, index) => ({ fieldId: value.fieldId, hash: entry.ledgerValueHashes?.[index] })),
  })).digest('hex');
}

function redactionDigest(item: LedgerRedaction): string {
  return createHash('sha256').update(canonical({ version: 1, ownerId: item.ownerId, collectionId: item.collectionId,
    formatId: item.formatId, entryId: item.entryId, sequence: item.sequence, fieldIds: Array.from(item.fieldIds),
    actorId: item.actorId, reason: item.reason, at: item.at, previousHash: item.previousHash })).digest('hex');
}

export async function verifyLedgerRows(head: LedgerHead | null, entries: AsyncIterable<Entry> | Iterable<Entry>, redactions: AsyncIterable<LedgerRedaction> | Iterable<LedgerRedaction>): Promise<LedgerIntegrity> {
  if (!head) return { valid: false, checked: 0, headHash: '', redactionHash: '', problem: 'Missing register head' };
  let redactionHash = '';
  let redactionCount = 0;
  const redactedByEntry = new Map<string, Set<string>>();
  for await (const item of redactions) {
    redactionCount++;
    if (item.sequence !== redactionCount || item.previousHash !== redactionHash || item.hash !== redactionDigest(item)) {
      return { valid: false, checked: 0, headHash: head.hash, redactionHash: head.redactionHash ?? '', problem: `Invalid redaction at sequence ${redactionCount}` };
    }
    const fields = redactedByEntry.get(item.entryId) ?? new Set<string>();
    item.fieldIds.forEach((fieldId) => fields.add(fieldId));
    redactedByEntry.set(item.entryId, fields);
    redactionHash = item.hash;
  }
  if ((head.redactionCount ?? 0) !== redactionCount || (head.redactionHash ?? '') !== redactionHash) {
    return { valid: false, checked: 0, headHash: head.hash, redactionHash: head.redactionHash ?? '', problem: 'Redaction head differs from traces' };
  }
  let previous = '';
  let checked = 0;
  const seenEntryIds = new Set<string>();
  for await (const entry of entries) {
    checked++;
    seenEntryIds.add(entry.id);
    const redacted = redactedByEntry.get(entry.id) ?? new Set<string>();
    if (entry.values.length !== entry.ledgerValueHashes?.length ||
        new Set(entry.ledgerRedactedFieldIds ?? []).size !== redacted.size ||
        (entry.ledgerRedactedFieldIds ?? []).some((fieldId) => !redacted.has(fieldId)) ||
        entry.values.some((value, index) => redacted.has(value.fieldId)
          ? value.value !== '[redacted]' || !!value.attachmentData || !!value.numberValue
          : hashValue(value) !== entry.ledgerValueHashes?.[index])) {
      return { valid: false, checked, headHash: head.hash, redactionHash, problem: `Writing values differ at sequence ${checked}` };
    }
    if (entry.ledgerSequence !== checked || entry.ledgerPreviousHash !== previous || entry.ledgerHash !== digest(entry, previous, checked)) {
      return { valid: false, checked, headHash: head.hash, redactionHash, problem: `Invalid writing at sequence ${checked}` };
    }
    previous = entry.ledgerHash;
  }
  if (head.count !== checked || head.hash !== previous) return { valid: false, checked, headHash: head.hash, redactionHash, problem: 'Register head differs from writings' };
  for (const entryId of redactedByEntry.keys()) if (!seenEntryIds.has(entryId)) return { valid: false, checked, headHash: head.hash, redactionHash, problem: 'Redaction refers to a missing writing' };
  return { valid: true, checked, headHash: head.hash, redactionHash };
}

@Injectable()
export class LedgerService {
  constructor(
    @InjectModel(Collection.name) private readonly collections: Model<Collection>,
    @InjectModel(Entry.name) private readonly entries: Model<Entry>,
    @InjectModel(LedgerHead.name) private readonly heads: Model<LedgerHead>,
    @InjectModel(LedgerRedaction.name) private readonly redactions: Model<LedgerRedaction>,
    @InjectModel(ContributionLink.name) private readonly contributionLinks: Model<ContributionLink>,
    private readonly collaboration: CollaborationService,
  ) {}

  private async context(collectionId: string, formatId: string, actorId: string, role: CollectionRole) {
    if (!Types.ObjectId.isValid(collectionId)) throw new BadRequestException('Invalid collection ID');
    const collection = await this.collections.findOne({ _id: collectionId, $or: [{ ownerId: actorId }, { 'members.userId': actorId }] }).exec();
    if (!collection) throw new NotFoundException('Collection not found');
    this.collaboration.checkAccess(collection, actorId, role);
    const format = collection.formats.find((item) => item.id === formatId);
    if (!format) throw new NotFoundException('Data format not found');
    return { collection, format };
  }

  async enable(collectionId: string, formatId: string, actorId: string): Promise<Collection> {
    const { collection, format } = await this.context(collectionId, formatId, actorId, CollectionRole.OWNER);
    if (format.appendOnly) return collection;
    if (format.objectModel || format.workflow) throw new BadRequestException('Use a regular data format without a workflow for the register');
    if (await this.entries.exists({ collectionId, formatId })) throw new BadRequestException('Enable the register on an empty data format');
    if (await this.contributionLinks.exists({ collectionId, formatId })) throw new BadRequestException('Use a data format without public contribution links for the register');
    await this.heads.updateOne({ ownerId: collection.ownerId, collectionId, formatId }, { $setOnInsert: { count: 0, hash: '', redactionCount: 0, redactionHash: '', lockedUntil: new Date(0) } }, { upsert: true }).exec();
    const updated = await this.collections.findOneAndUpdate({ _id: collectionId, formats: { $elemMatch: { id: formatId, appendOnly: { $ne: true } } } }, { $set: { 'formats.$.appendOnly': true } }, { returnDocument: 'after' }).exec();
    if (!updated) throw new ConflictException('Data format changed. Refresh and try again');
    return updated;
  }

  private async acquire(ownerId: string, collectionId: string, formatId: string): Promise<string> {
    const token = randomUUID();
    const now = new Date();
    const locked = await this.heads.findOneAndUpdate({ ownerId, collectionId, formatId, lockedUntil: { $lte: now } },
      { $set: { token, lockedUntil: new Date(now.getTime() + 60_000) } }, { returnDocument: 'after' }).exec();
    if (!locked) throw new ConflictException('Register is being updated. Try again');
    return token;
  }

  private async release(ownerId: string, collectionId: string, formatId: string, token: string): Promise<void> {
    await this.heads.updateOne({ ownerId, collectionId, formatId, token }, { $set: { lockedUntil: new Date(0) }, $unset: { token: '' } }).exec();
  }

  private async check(ownerId: string, collectionId: string, formatId: string): Promise<LedgerIntegrity> {
    const head = await this.heads.findOne({ ownerId, collectionId, formatId }).exec();
    return verifyLedgerRows(head,
      this.entries.find({ ownerId, collectionId, formatId }).sort({ ledgerSequence: 1, _id: 1 }).cursor(),
      this.redactions.find({ ownerId, collectionId, formatId }).sort({ sequence: 1 }).cursor());
  }

  async verify(collectionId: string, formatId: string, actorId: string): Promise<LedgerIntegrity> {
    const { collection, format } = await this.context(collectionId, formatId, actorId, CollectionRole.READER);
    if (!format.appendOnly) throw new BadRequestException('This data format is not a register');
    return this.check(collection.ownerId, collectionId, formatId);
  }

  async append(collection: Collection, format: CollectionFormat, values: EntryValue[], actorId: string, clientMutationId?: string, correctionOf?: string): Promise<Entry> {
    const token = await this.acquire(collection.ownerId, collection.id, format.id);
    try {
      const integrity = await this.check(collection.ownerId, collection.id, format.id);
      if (!integrity.valid) throw new ConflictException(`Register integrity failed: ${integrity.problem}`);
      const head = await this.heads.findOne({ ownerId: collection.ownerId, collectionId: collection.id, formatId: format.id, token }).exec();
      if (!head) throw new ConflictException('Register lock expired');
      const entry = await this.entries.create({ ownerId: collection.ownerId, createdBy: actorId, updatedBy: actorId, collectionId: collection.id, formatId: format.id,
        formatVersion: format.version ?? 1, values, clientMutationId, correctionOf,
        ledgerSequence: head.count + 1, ledgerPreviousHash: head.hash });
      entry.ledgerValueHashes = Array.from(entry.values, hashValue);
      const hash = digest(entry, head.hash, head.count + 1);
      await this.entries.updateOne({ _id: entry.id, ledgerHash: null }, { $set: { ledgerHash: hash, ledgerValueHashes: entry.ledgerValueHashes } }, { timestamps: false }).exec();
      entry.ledgerHash = hash;
      const updated = await this.heads.updateOne({ _id: head.id, token, count: head.count, hash: head.hash }, { $set: { count: head.count + 1, hash } }).exec();
      if (updated.modifiedCount !== 1) throw new ConflictException('Register head changed during append');
      return entry;
    } finally { await this.release(collection.ownerId, collection.id, format.id, token); }
  }

  async proof(collectionId: string, formatId: string, actorId: string): Promise<string> {
    const result = await this.verify(collectionId, formatId, actorId);
    const rows = await this.entries.find({ collectionId, formatId }).sort({ ledgerSequence: 1 }).select('ledgerSequence ledgerHash ledgerPreviousHash correctionOf createdAt').exec();
    const redactions = await this.redactions.find({ collectionId, formatId }).sort({ sequence: 1 }).exec();
    return JSON.stringify({ kind: 'Brainy register proof', version: 1, collectionId, formatId,
      verifiedAt: new Date().toISOString(), ...result,
      writings: rows.map((entry) => ({ sequence: entry.ledgerSequence, entryId: entry.id, previousHash: entry.ledgerPreviousHash,
        hash: entry.ledgerHash, correctionOf: entry.correctionOf ?? null, createdAt: entry.createdAt.toISOString() })),
      redactions: redactions.map((item) => ({ sequence: item.sequence, entryId: item.entryId, fieldIds: item.fieldIds,
        at: item.at.toISOString(), reason: item.reason, previousHash: item.previousHash, hash: item.hash })),
      notice: 'Integrity evidence only. This is not accounting, medical or regulatory certification.' }, null, 2);
  }

  async redact(collectionId: string, formatId: string, entryId: string, fieldIds: string[], reason: string, actorId: string): Promise<LedgerIntegrity> {
    const { collection, format } = await this.context(collectionId, formatId, actorId, CollectionRole.OWNER);
    if (!format.appendOnly) throw new BadRequestException('This data format is not a register');
    if (!Types.ObjectId.isValid(entryId) || !fieldIds.length || fieldIds.length > 30 || new Set(fieldIds).size !== fieldIds.length) throw new BadRequestException('Choose fields to mask');
    if (!reason.trim() || reason.trim().length > 500) throw new BadRequestException('Give a reason of at most 500 characters');
    const token = await this.acquire(collection.ownerId, collectionId, formatId);
    try {
      const integrity = await this.check(collection.ownerId, collectionId, formatId);
      if (!integrity.valid) throw new ConflictException(`Register integrity failed: ${integrity.problem}`);
      const head = await this.heads.findOne({ ownerId: collection.ownerId, collectionId, formatId, token }).exec();
      const entry = await this.entries.findOne({ _id: entryId, ownerId: collection.ownerId, collectionId, formatId }).exec();
      if (!head || !entry) throw new NotFoundException('Register writing not found');
      for (const fieldId of fieldIds) {
        const field = format.fields.find((item) => item.id === fieldId);
        if (!field || !entry.values.some((item) => item.fieldId === fieldId) || (entry.ledgerRedactedFieldIds ?? []).includes(fieldId)) throw new BadRequestException('Choose populated fields that are not already masked');
        if (field.kind === FieldKind.NUMBER || field.kind === FieldKind.MEASURE) throw new BadRequestException('Amounts and measurements must remain in the register');
      }
      const nextValues = entry.values.map((value) => fieldIds.includes(value.fieldId) ? { fieldId: value.fieldId, value: '[redacted]' } : value);
      const nextRedacted = [...(entry.ledgerRedactedFieldIds ?? []), ...fieldIds];
      const updated = await this.entries.updateOne({ _id: entryId, ledgerHash: entry.ledgerHash }, { $set: { values: nextValues, ledgerRedactedFieldIds: nextRedacted } }, { timestamps: false }).exec();
      if (updated.modifiedCount !== 1) throw new ConflictException('Writing changed during masking');
      const trace = new this.redactions({ ownerId: collection.ownerId, collectionId, formatId, entryId,
        sequence: (head.redactionCount ?? 0) + 1, fieldIds, actorId, reason: reason.trim(), at: new Date(), previousHash: head.redactionHash ?? '' });
      trace.hash = redactionDigest(trace);
      await trace.save();
      const saved = await this.heads.updateOne({ _id: head.id, token, redactionCount: head.redactionCount ?? 0 }, { $set: { redactionCount: trace.sequence, redactionHash: trace.hash } }).exec();
      if (saved.modifiedCount !== 1) throw new ConflictException('Register redaction head changed');
      return this.check(collection.ownerId, collectionId, formatId);
    } finally { await this.release(collection.ownerId, collectionId, formatId, token); }
  }

  async balance(collectionId: string, formatId: string, fieldId: string, actorId: string): Promise<string> {
    const { collection, format } = await this.context(collectionId, formatId, actorId, CollectionRole.OWNER);
    if (!format.appendOnly || !format.fields.some((field) => field.id === fieldId && field.kind === FieldKind.NUMBER)) throw new BadRequestException('Choose a number field in a register');
    const integrity = await this.check(collection.ownerId, collectionId, formatId);
    if (!integrity.valid) throw new ConflictException(`Register integrity failed: ${integrity.problem}`);
    let total = decimal('0');
    for await (const entry of this.entries.find({ ownerId: collection.ownerId, collectionId, formatId }).cursor()) {
      const value = entry.values.find((item) => item.fieldId === fieldId);
      if (!value) continue;
      const amount = decimal(value.numberValue ?? value.value);
      total = { n: total.n * amount.d + amount.n * total.d, d: total.d * amount.d };
    }
    return fractionText(total);
  }
}
