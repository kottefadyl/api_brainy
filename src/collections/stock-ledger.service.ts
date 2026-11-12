import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomUUID } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { Collection } from './collection.schema.js';
import { CollectionRole } from './collaboration.schema.js';
import { CollaborationService } from './collaboration.service.js';
import { LedgerIntegrity } from './ledger.schema.js';
import { StockLedgerHead, StockMovement } from './stock.schema.js';

function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => Array.isArray(item) ? item.map(sort) : item && typeof item === 'object'
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sort(child)])) : item;
  return JSON.stringify(sort(JSON.parse(JSON.stringify(value))));
}
function digest(item: StockMovement, sequence: number, previousHash: string): string {
  const { id, ownerId, collectionId, productId, productName, kind, quantity, packageFactor, baseQuantity,
    fromLocation, toLocation, lot, occurredAt, createdAt, priceSnapshot, priceUnit, reason, sourceEntryId,
    sourceEntryUpdatedAt, ruleId, reversalOf, actorId, idempotencyKey } = item;
  return createHash('sha256').update(canonical({ version: 1, sequence, previousHash, id, ownerId, collectionId, productId,
    productName, kind, quantity, packageFactor, baseQuantity, fromLocation, toLocation, lot, occurredAt, createdAt,
    priceSnapshot, priceUnit, reason, sourceEntryId, sourceEntryUpdatedAt, ruleId, reversalOf, actorId, idempotencyKey })).digest('hex');
}

export async function verifyStockRows(head: StockLedgerHead | null, movements: AsyncIterable<StockMovement> | Iterable<StockMovement>): Promise<LedgerIntegrity> {
  if (!head) return { valid: false, checked: 0, headHash: '', redactionHash: '', problem: 'Stock history has no integrity head' };
  let previous = '';
  let checked = 0;
  for await (const item of movements) {
    checked++;
    if (item.ledgerSequence !== checked || item.ledgerPreviousHash !== previous || item.ledgerHash !== digest(item, checked, previous)) {
      return { valid: false, checked, headHash: head.hash, redactionHash: '', problem: `Invalid stock movement at sequence ${checked}` };
    }
    previous = item.ledgerHash;
  }
  if (head.count !== checked || head.hash !== previous) return { valid: false, checked, headHash: head.hash, redactionHash: '', problem: 'Stock head differs from movements' };
  return { valid: true, checked, headHash: head.hash, redactionHash: '' };
}

@Injectable()
export class StockLedgerService {
  constructor(
    @InjectModel(Collection.name) private readonly collections: Model<Collection>,
    @InjectModel(StockMovement.name) private readonly movements: Model<StockMovement>,
    @InjectModel(StockLedgerHead.name) private readonly heads: Model<StockLedgerHead>,
    private readonly collaboration: CollaborationService,
  ) {}

  private async access(collectionId: string, productId: string, actorId: string, role: CollectionRole): Promise<Collection> {
    if (!Types.ObjectId.isValid(collectionId) || !Types.ObjectId.isValid(productId)) throw new BadRequestException('Invalid collection or product ID');
    const collection = await this.collections.findOne({ _id: collectionId, $or: [{ ownerId: actorId }, { 'members.userId': actorId }] }).exec();
    if (!collection) throw new NotFoundException('Collection not found');
    this.collaboration.checkAccess(collection, actorId, role);
    return collection;
  }

  private async check(ownerId: string, collectionId: string, productId: string): Promise<LedgerIntegrity> {
    const head = await this.heads.findOne({ ownerId, collectionId, productId }).exec();
    return verifyStockRows(head, this.movements.find({ ownerId, collectionId, productId }).sort({ createdAt: 1, _id: 1 }).cursor());
  }

  async verify(collectionId: string, productId: string, actorId: string): Promise<LedgerIntegrity> {
    const collection = await this.access(collectionId, productId, actorId, CollectionRole.READER);
    return this.check(collection.ownerId, collectionId, productId);
  }

  async sealHistory(collectionId: string, productId: string, actorId: string): Promise<LedgerIntegrity> {
    const collection = await this.access(collectionId, productId, actorId, CollectionRole.OWNER);
    return this.sealExisting(collection.ownerId, collectionId, productId);
  }

  async sealExisting(ownerId: string, collectionId: string, productId: string): Promise<LedgerIntegrity> {
    const key = { ownerId, collectionId, productId };
    try { await this.heads.updateOne(key, { $setOnInsert: { count: 0, hash: '', lockedUntil: new Date(0) } }, { upsert: true }).exec(); }
    catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
    const token = randomUUID();
    const now = new Date();
    const head = await this.heads.findOneAndUpdate({ ...key, lockedUntil: { $lte: now } },
      { $set: { token, lockedUntil: new Date(now.getTime() + 60_000) } }, { returnDocument: 'after' }).exec();
    if (!head) throw new ConflictException('Stock history is being sealed. Try again');
    try {
      let previous = '';
      let sequence = 0;
      for await (const item of this.movements.find(key).sort({ createdAt: 1, _id: 1 }).cursor()) {
        sequence++;
        const hash = digest(item, sequence, previous);
        if (sequence <= head.count) {
          if (item.ledgerSequence !== sequence || item.ledgerPreviousHash !== previous || item.ledgerHash !== hash) throw new ConflictException(`Stock integrity failed at movement ${sequence}`);
        } else {
          if (item.ledgerHash) throw new ConflictException('Stock movement has an unexpected hash');
          const updated = await this.movements.updateOne({ _id: item.id, ledgerHash: null }, { $set: { ledgerSequence: sequence, ledgerPreviousHash: previous, ledgerHash: hash } }, { timestamps: false }).exec();
          if (updated.modifiedCount !== 1) throw new ConflictException('Stock movement changed while sealing');
          await this.heads.updateOne({ _id: head.id, token, count: sequence - 1 }, { $set: { count: sequence, hash } }).exec();
        }
        previous = hash;
      }
      if (head.count > sequence) throw new ConflictException('Stock movement is missing from sealed history');
      return this.check(ownerId, collectionId, productId);
    } finally { await this.heads.updateOne({ ...key, token }, { $set: { lockedUntil: new Date(0) }, $unset: { token: '' } }).exec(); }
  }

  async proof(collectionId: string, productId: string, actorId: string): Promise<string> {
    const status = await this.verify(collectionId, productId, actorId);
    const rows = await this.movements.find({ collectionId, productId }).sort({ createdAt: 1, _id: 1 }).select('ledgerSequence ledgerPreviousHash ledgerHash kind baseQuantity reversalOf createdAt').exec();
    return JSON.stringify({ kind: 'Brainy stock proof', version: 1, collectionId, productId, verifiedAt: new Date().toISOString(), ...status,
      movements: rows.map((item) => ({ sequence: item.ledgerSequence, id: item.id, kind: item.kind, quantity: item.baseQuantity,
        reversalOf: item.reversalOf ?? null, previousHash: item.ledgerPreviousHash, hash: item.ledgerHash, createdAt: item.createdAt.toISOString() })),
      notice: 'Integrity evidence only. This is not accounting, medical or regulatory certification.' }, null, 2);
  }
}
