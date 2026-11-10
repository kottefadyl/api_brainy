import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { Collection, CollectionField, FieldKind } from './collection.schema';
import { Entry } from './entry.schema';
import { StockDailyRow, StockMovementInput, StockPosition, StockPreview, StockRuleInput } from './stock.input';
import { StockLock, StockMovement, StockRule } from './stock.schema';
import { decimal, fractionText, multiply, Rational, resolveUnit } from './unit_math';
import { localDate, localTime, validTimeZone } from './time_math';
import { StockLedgerService } from './stock-ledger.service';

type Prepared = {
  input: StockMovementInput;
  productName: string;
  baseQuantity: string;
  occurredAt: Date;
  sourceEntryId?: string;
  sourceEntryUpdatedAt?: Date;
  ruleId?: string;
};
type Balance = Map<string, Rational>;
const zero = (): Rational => ({ n: 0n, d: 1n });
const add = (left: Rational, right: Rational): Rational => ({ n: left.n * right.d + right.n * left.d, d: left.d * right.d });
const neg = (value: Rational): Rational => ({ n: -value.n, d: value.d });
const positionKey = (location: string, lot: string): string => JSON.stringify([location, lot]);
const positive = (value: string): boolean => decimal(value).n > 0n;

@Injectable()
export class StockService {
  constructor(
    @InjectModel(Collection.name) private readonly collections: Model<Collection>,
    @InjectModel(Entry.name) private readonly entries: Model<Entry>,
    @InjectModel(StockMovement.name) private readonly movements: Model<StockMovement>,
    @InjectModel(StockLock.name) private readonly locks: Model<StockLock>,
    private readonly stockLedger: StockLedgerService,
  ) {}

  private async collection(collectionId: string, ownerId: string): Promise<Collection> {
    if (!Types.ObjectId.isValid(collectionId)) throw new BadRequestException('Invalid collection ID');
    const collection = await this.collections.findOne({ _id: collectionId, ownerId }).exec();
    if (!collection) throw new NotFoundException('Collection not found');
    return collection;
  }

  private async product(collection: Collection, productId: string, ownerId: string): Promise<{ entry: Entry; name: string }> {
    if (!Types.ObjectId.isValid(productId)) throw new BadRequestException('Choose a product object');
    const entry = await this.entries.findOne({ _id: productId, collectionId: collection.id, ownerId }).exec();
    const format = collection.formats.find((item) => item.id === entry?.formatId && item.objectModel);
    if (!entry || !format || entry.movingOperationId) throw new BadRequestException('Choose an object in this collection');
    const titleId = format.fields.find((field) => field.kind === FieldKind.TITLE)?.id;
    const name = entry.values.find((value) => value.fieldId === titleId)?.value;
    if (!name) throw new BadRequestException('Product object needs a name');
    return { entry, name };
  }

  private label(value: string | undefined, name: string): string {
    const result = (value ?? '').trim();
    if (result.length > 80 || /[\x00-\x1f\x7f]/.test(result)) throw new BadRequestException(`${name} is too long or contains a control character`);
    return result;
  }

  private factDate(value: string): Date {
    const date = new Date(value);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !/(Z|[+-]\d\d:\d\d)$/.test(value) || Number.isNaN(date.getTime())) throw new BadRequestException('Use a date and time with a time zone');
    return date;
  }

  private async prepare(collection: Collection, ownerId: string, raw: StockMovementInput, source?: Pick<Prepared, 'sourceEntryId' | 'sourceEntryUpdatedAt' | 'ruleId'>): Promise<Prepared> {
    const kind = raw.kind;
    if (!['IN', 'OUT', 'TRANSFER', 'CORRECTION', 'RETURN'].includes(kind)) throw new BadRequestException('Choose a stock movement type');
    const product = await this.product(collection, raw.productId, ownerId);
    const quantity = fractionText(decimal(raw.quantity));
    const packageFactor = fractionText(decimal(raw.packageFactor ?? '1', true));
    const baseQuantity = fractionText(multiply(decimal(quantity), decimal(packageFactor)));
    if (decimal(baseQuantity).n === 0n || (kind !== 'CORRECTION' && !positive(baseQuantity))) throw new BadRequestException('Use a positive quantity; corrections can be negative');
    const fromLocation = this.label(raw.fromLocation, 'Source location');
    const toLocation = this.label(raw.toLocation, 'Destination location');
    const lot = this.label(raw.lot, 'Lot');
    const reason = this.label(raw.reason, 'Reason') || undefined;
    if (kind === 'TRANSFER' && fromLocation === toLocation) throw new BadRequestException('Choose two different locations for a transfer');
    if (kind === 'RETURN' && !raw.reversalOf) throw new BadRequestException('Choose the sale movement being returned');
    if (kind !== 'RETURN' && raw.reversalOf) throw new BadRequestException('Only a return can refer to a sale movement');
    if (kind === 'CORRECTION' && !reason) throw new BadRequestException('Explain the stock correction');
    const idempotencyKey = this.label(raw.idempotencyKey, 'Operation key');
    if (!/^[A-Za-z0-9:_-]{8,120}$/.test(idempotencyKey)) throw new BadRequestException('Use a stable operation key');
    let priceSnapshot: string | undefined;
    if (raw.priceSnapshot != null && raw.priceSnapshot !== '') {
      priceSnapshot = fractionText(decimal(raw.priceSnapshot));
      if (decimal(priceSnapshot).n < 0n) throw new BadRequestException('Price cannot be negative');
    }
    const priceUnit = this.label(raw.priceUnit, 'Price unit') || undefined;
    if (priceUnit && !priceSnapshot) throw new BadRequestException('Add a price before choosing its unit');
    if (priceUnit && resolveUnit(priceUnit.replace(/^local:/, ''), collection.units ?? []).dimension !== 'CURRENCY') throw new BadRequestException('Price needs a currency unit');
    const input: StockMovementInput = { kind, productId: product.entry.id, quantity, packageFactor, fromLocation, toLocation, lot, occurredAt: raw.occurredAt, priceSnapshot, priceUnit, reason, reversalOf: raw.reversalOf, idempotencyKey };
    return { input, productName: product.name, baseQuantity, occurredAt: this.factDate(raw.occurredAt), ...source };
  }

  private deltas(movement: Pick<StockMovement, 'kind' | 'baseQuantity' | 'fromLocation' | 'toLocation' | 'lot'>): { key: string; amount: Rational }[] {
    const quantity = decimal(movement.baseQuantity);
    const from = positionKey(movement.fromLocation, movement.lot);
    const to = positionKey(movement.toLocation, movement.lot);
    if (movement.kind === 'TRANSFER') return [{ key: from, amount: neg(quantity) }, { key: to, amount: quantity }];
    if (movement.kind === 'OUT') return [{ key: from, amount: neg(quantity) }];
    return [{ key: to, amount: quantity }];
  }

  private async balances(collectionId: string, ownerId: string, productId: string): Promise<Balance> {
    const result: Balance = new Map();
    for await (const movement of this.movements.find({ collectionId, ownerId, productId }).cursor()) {
      for (const delta of this.deltas(movement)) result.set(delta.key, add(result.get(delta.key) ?? zero(), delta.amount));
    }
    return result;
  }

  private async returnProblem(collectionId: string, ownerId: string, prepared: Prepared): Promise<string | undefined> {
    if (prepared.input.kind !== 'RETURN') return;
    const original = await this.movements.findOne({ _id: prepared.input.reversalOf, collectionId, ownerId, kind: 'OUT', productId: prepared.input.productId }).exec();
    if (!original) return 'The sale movement was not found';
    if (original.fromLocation !== prepared.input.toLocation || original.lot !== prepared.input.lot) return 'Return to the sale location and lot';
    let returned = zero();
    for await (const item of this.movements.find({ collectionId, ownerId, reversalOf: original.id, kind: 'RETURN' }).cursor()) returned = add(returned, decimal(item.baseQuantity));
    if (add(returned, decimal(prepared.baseQuantity)).n * decimal(original.baseQuantity).d > decimal(original.baseQuantity).n * add(returned, decimal(prepared.baseQuantity)).d) return 'Return quantity exceeds the sale';
    return;
  }

  private async previewPrepared(collection: Collection, ownerId: string, prepared: Prepared): Promise<StockPreview> {
    const current = await this.balances(collection.id, ownerId, prepared.input.productId);
    const fromKey = positionKey(prepared.input.fromLocation ?? '', prepared.input.lot ?? '');
    const toKey = positionKey(prepared.input.toLocation ?? '', prepared.input.lot ?? '');
    const beforeFrom = current.get(fromKey) ?? zero();
    const beforeTo = current.get(toKey) ?? zero();
    const after = new Map(current);
    for (const delta of this.deltas({ kind: prepared.input.kind, baseQuantity: prepared.baseQuantity, fromLocation: prepared.input.fromLocation ?? '', toLocation: prepared.input.toLocation ?? '', lot: prepared.input.lot ?? '' })) after.set(delta.key, add(after.get(delta.key) ?? zero(), delta.amount));
    const touched = this.deltas({ kind: prepared.input.kind, baseQuantity: prepared.baseQuantity, fromLocation: prepared.input.fromLocation ?? '', toLocation: prepared.input.toLocation ?? '', lot: prepared.input.lot ?? '' }).map((delta) => delta.key);
    const negative = !collection.allowNegativeStock && touched.some((key) => (after.get(key) ?? zero()).n < 0n);
    const returnProblem = await this.returnProblem(collection.id, ownerId, prepared);
    const existing = await this.movements.findOne({ collectionId: collection.id, ownerId, idempotencyKey: prepared.input.idempotencyKey }).exec();
    return {
      kind: prepared.input.kind, productId: prepared.input.productId, productName: prepared.productName, baseQuantity: prepared.baseQuantity,
      fromLocation: prepared.input.fromLocation ?? '', toLocation: prepared.input.toLocation ?? '', lot: prepared.input.lot ?? '',
      beforeFrom: fractionText(beforeFrom), afterFrom: fractionText(after.get(fromKey) ?? zero()),
      beforeTo: fractionText(beforeTo), afterTo: fractionText(after.get(toKey) ?? zero()),
      allowed: !negative && !returnProblem,
      reason: negative ? 'Stock would become negative' : returnProblem,
      existingMovementId: existing?.id,
    };
  }

  async preview(collectionId: string, ownerId: string, input: StockMovementInput): Promise<StockPreview> {
    const collection = await this.collection(collectionId, ownerId);
    return this.previewPrepared(collection, ownerId, await this.prepare(collection, ownerId, input));
  }

  private same(existing: StockMovement, prepared: Prepared): boolean {
    const input = prepared.input;
    return existing.kind === input.kind && existing.productId === input.productId && existing.quantity === input.quantity && existing.packageFactor === input.packageFactor && existing.baseQuantity === prepared.baseQuantity && existing.fromLocation === (input.fromLocation ?? '') && existing.toLocation === (input.toLocation ?? '') && existing.lot === (input.lot ?? '') && existing.occurredAt.getTime() === prepared.occurredAt.getTime() && (existing.reason ?? '') === (input.reason ?? '') && (existing.priceSnapshot ?? '') === (input.priceSnapshot ?? '') && (existing.priceUnit ?? '') === (input.priceUnit ?? '') && (existing.reversalOf ?? '') === (input.reversalOf ?? '') && (existing.sourceEntryId ?? '') === (prepared.sourceEntryId ?? '') && (existing.ruleId ?? '') === (prepared.ruleId ?? '');
  }

  private async existingOrConflict(collectionId: string, ownerId: string, prepared: Prepared): Promise<StockMovement | undefined> {
    const existing = await this.movements.findOne({ collectionId, ownerId, idempotencyKey: prepared.input.idempotencyKey }).exec();
    if (existing && !this.same(existing, prepared)) throw new ConflictException('Operation key was already used for another movement');
    return existing ?? undefined;
  }

  private async acquire(collectionId: string, ownerId: string, productId: string): Promise<string> {
    const key = { collectionId, ownerId, productId };
    try { await this.locks.updateOne(key, { $setOnInsert: { lockedUntil: new Date(0) } }, { upsert: true }).exec(); }
    catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
    const token = randomUUID();
    const now = new Date();
    const lock = await this.locks.findOneAndUpdate({ ...key, lockedUntil: { $lte: now } }, { $set: { token, lockedUntil: new Date(now.getTime() + 60_000) } }, { returnDocument: 'after' }).exec();
    if (!lock) throw new ConflictException('Stock is being updated. Try again');
    return token;
  }

  private async release(collectionId: string, ownerId: string, productId: string, token: string): Promise<void> {
    try { await this.locks.updateOne({ collectionId, ownerId, productId, token }, { $set: { lockedUntil: new Date(0) }, $unset: { token: '' } }).exec(); }
    catch { /* The lease expires and the movement remains the source of truth. */ }
  }

  private async commitPrepared(collection: Collection, ownerId: string, prepared: Prepared): Promise<StockMovement> {
    const prior = await this.existingOrConflict(collection.id, ownerId, prepared);
    if (prior) { await this.stockLedger.sealExisting(ownerId, collection.id, prepared.input.productId); return prior; }
    const token = await this.acquire(collection.id, ownerId, prepared.input.productId);
    try {
      const again = await this.existingOrConflict(collection.id, ownerId, prepared);
      if (again) { await this.stockLedger.sealExisting(ownerId, collection.id, prepared.input.productId); return again; }
      await this.stockLedger.sealExisting(ownerId, collection.id, prepared.input.productId);
      const freshCollection = await this.collection(collection.id, ownerId);
      const preview = await this.previewPrepared(freshCollection, ownerId, prepared);
      if (!preview.allowed) throw new BadRequestException(preview.reason);
      try {
        const movement = await this.movements.create({
          collectionId: collection.id, ownerId, actorId: ownerId, productId: prepared.input.productId, productName: prepared.productName,
          kind: prepared.input.kind, quantity: prepared.input.quantity, packageFactor: prepared.input.packageFactor, baseQuantity: prepared.baseQuantity,
          fromLocation: prepared.input.fromLocation ?? '', toLocation: prepared.input.toLocation ?? '', lot: prepared.input.lot ?? '',
          occurredAt: prepared.occurredAt, priceSnapshot: prepared.input.priceSnapshot, priceUnit: prepared.input.priceUnit,
          reason: prepared.input.reason, reversalOf: prepared.input.reversalOf, idempotencyKey: prepared.input.idempotencyKey,
          sourceEntryId: prepared.sourceEntryId, sourceEntryUpdatedAt: prepared.sourceEntryUpdatedAt, ruleId: prepared.ruleId,
        });
        await this.stockLedger.sealExisting(ownerId, collection.id, prepared.input.productId);
        return (await this.movements.findById(movement.id).exec())!;
      } catch (error) {
        if ((error as { code?: number }).code === 11000) {
          const duplicate = await this.existingOrConflict(collection.id, ownerId, prepared);
          if (duplicate) return duplicate;
        }
        throw error;
      }
    } finally { await this.release(collection.id, ownerId, prepared.input.productId, token); }
  }

  async commit(collectionId: string, ownerId: string, input: StockMovementInput): Promise<StockMovement> {
    const collection = await this.collection(collectionId, ownerId);
    return this.commitPrepared(collection, ownerId, await this.prepare(collection, ownerId, input));
  }

  async setNegativePolicy(collectionId: string, ownerId: string, allowNegative: boolean): Promise<Collection> {
    const updated = await this.collections.findOneAndUpdate({ _id: collectionId, ownerId }, { $set: { allowNegativeStock: allowNegative } }, { returnDocument: 'after' }).exec();
    if (!updated) throw new NotFoundException('Collection not found');
    return updated;
  }

  async saveRule(collectionId: string, ownerId: string, input: StockRuleInput, ruleId?: string): Promise<Collection> {
    const collection = await this.collection(collectionId, ownerId);
    const format = collection.formats.find((item) => item.id === input.formatId && !item.objectModel);
    if (!format) throw new BadRequestException('Choose an ordinary data format');
    const field = (id: string | undefined, kinds: FieldKind[], label: string): CollectionField | undefined => {
      if (!id) return;
      const candidate = format.fields.find((item) => item.id === id && kinds.includes(item.kind));
      if (!candidate) throw new BadRequestException(`Choose a compatible ${label} field`);
      return candidate;
    };
    const product = field(input.productFieldId, [FieldKind.OBJECT_REF], 'product');
    if (!product || product.multiple || !collection.formats.some((item) => item.id === product.targetObjectFormatId && item.objectModel)) throw new BadRequestException('Choose one local product reference');
    const quantity = field(input.quantityFieldId, [FieldKind.NUMBER], 'quantity');
    if (!quantity) throw new BadRequestException('Choose a quantity field');
    if (quantity.unit) {
      const unit = resolveUnit(quantity.unit.replace(/^local:/, ''), collection.units ?? []);
      if (unit.dimension !== 'COUNT' || (unit.objectFormatId && unit.objectFormatId !== product.targetObjectFormatId)) throw new BadRequestException('Quantity must be a compatible count');
    }
    if (!['IN', 'OUT', 'TRANSFER', 'CORRECTION'].includes(input.kind)) throw new BadRequestException('Choose a stock effect');
    field(input.dateFieldId, [FieldKind.DATE, FieldKind.DATETIME], 'date');
    field(input.priceFieldId, [FieldKind.NUMBER], 'price');
    field(input.reasonFieldId, [FieldKind.TEXT, FieldKind.LONG_TEXT, FieldKind.TITLE], 'reason');
    field(input.fromLocationFieldId, [FieldKind.TEXT, FieldKind.SELECT], 'source location');
    field(input.toLocationFieldId, [FieldKind.TEXT, FieldKind.SELECT], 'destination location');
    field(input.lotFieldId, [FieldKind.TEXT, FieldKind.SELECT], 'lot');
    if (input.kind === 'TRANSFER' && (!input.fromLocationFieldId || !input.toLocationFieldId || input.fromLocationFieldId === input.toLocationFieldId)) throw new BadRequestException('Transfer needs two location fields');
    const name = this.label(input.name, 'Rule name');
    if (!name) throw new BadRequestException('Name the stock rule');
    const existing = (collection.stockRules ?? []).find((item) => item.id === ruleId);
    if (ruleId && (!existing || existing.version !== input.expectedVersion)) throw new ConflictException('Stock rule changed. Refresh and try again');
    if ((collection.stockRules ?? []).some((item) => item.id !== ruleId && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new BadRequestException('Stock rule names must be unique');
    const packageFactor = fractionText(decimal(input.packageFactor ?? '1', true));
    const rule: StockRule = { id: ruleId ?? randomUUID(), name, formatId: input.formatId, productFieldId: input.productFieldId, quantityFieldId: input.quantityFieldId, kind: input.kind, dateFieldId: input.dateFieldId, priceFieldId: input.priceFieldId, reasonFieldId: input.reasonFieldId, fromLocationFieldId: input.fromLocationFieldId, toLocationFieldId: input.toLocationFieldId, lotFieldId: input.lotFieldId, packageFactor, version: (existing?.version ?? 0) + 1 };
    const stockRules = [...(collection.stockRules ?? []).filter((item) => item.id !== rule.id), rule];
    if (stockRules.length > 50) throw new BadRequestException('This collection has 50 stock rules');
    const updated = await this.collections.findOneAndUpdate({ _id: collectionId, ownerId, ...(ruleId ? { stockRules: { $elemMatch: { id: ruleId, version: input.expectedVersion } } } : {}) }, { $set: { stockRules } }, { returnDocument: 'after' }).exec();
    if (!updated) throw new ConflictException('Stock rules changed. Refresh and try again');
    return updated;
  }

  async deleteRule(collectionId: string, ownerId: string, ruleId: string): Promise<Collection> {
    const updated = await this.collections.findOneAndUpdate({ _id: collectionId, ownerId, 'stockRules.id': ruleId }, { $pull: { stockRules: { id: ruleId } } }, { returnDocument: 'after' }).exec();
    if (!updated) throw new NotFoundException('Stock rule not found');
    return updated;
  }

  private async preparedEntry(collection: Collection, ownerId: string, entryId: string, ruleId: string, expectedUpdatedAt?: string): Promise<Prepared> {
    if (!Types.ObjectId.isValid(entryId)) throw new BadRequestException('Invalid entry ID');
    const entry = await this.entries.findOne({ _id: entryId, collectionId: collection.id, ownerId }).exec();
    if (!entry) throw new NotFoundException('Entry not found');
    if (entry.contributionLinkId) throw new BadRequestException('Public contributions cannot create stock movements');
    if (expectedUpdatedAt && entry.updatedAt.toISOString() !== expectedUpdatedAt) throw new ConflictException('Entry changed. Refresh and try again');
    const rule = (collection.stockRules ?? []).find((item) => item.id === ruleId && item.formatId === entry.formatId);
    if (!rule) throw new BadRequestException('Choose a stock rule for this entry');
    const format = collection.formats.find((item) => item.id === rule.formatId)!;
    const value = (fieldId?: string) => entry.values.find((item) => item.fieldId === fieldId);
    const objectIds = value(rule.productFieldId)?.objectIds ?? [];
    if (objectIds.length !== 1) throw new BadRequestException('Entry needs one product object');
    const quantityField = format.fields.find((field) => field.id === rule.quantityFieldId)!;
    const countFactor = quantityField.unit ? resolveUnit(quantityField.unit.replace(/^local:/, ''), collection.units ?? []).factor : decimal('1');
    const quantity = value(rule.quantityFieldId)?.numberValue ?? value(rule.quantityFieldId)?.value;
    if (!quantity) throw new BadRequestException('Entry needs a quantity');
    const packageFactor = fractionText(multiply(decimal(rule.packageFactor, true), countFactor));
    const dateValue = value(rule.dateFieldId)?.dateTimeValue ?? value(rule.dateFieldId)?.dateValue ?? value(rule.dateFieldId)?.value;
    const occurredAt = dateValue ? (dateValue.length === 10 ? `${dateValue}T00:00:00.000Z` : dateValue) : entry.createdAt.toISOString();
    const priceField = format.fields.find((field) => field.id === rule.priceFieldId);
    const raw: StockMovementInput = {
      kind: rule.kind, productId: objectIds[0], quantity, packageFactor, occurredAt,
      fromLocation: value(rule.fromLocationFieldId)?.value, toLocation: value(rule.toLocationFieldId)?.value, lot: value(rule.lotFieldId)?.value,
      priceSnapshot: value(rule.priceFieldId)?.numberValue ?? value(rule.priceFieldId)?.value, priceUnit: priceField?.unit,
      reason: value(rule.reasonFieldId)?.value,
      idempotencyKey: `entry:${entry.id}:${rule.id}`,
    };
    return this.prepare(collection, ownerId, raw, { sourceEntryId: entry.id, sourceEntryUpdatedAt: entry.updatedAt, ruleId: rule.id });
  }

  async previewEntry(collectionId: string, ownerId: string, entryId: string, ruleId: string): Promise<StockPreview> {
    const collection = await this.collection(collectionId, ownerId);
    return this.previewPrepared(collection, ownerId, await this.preparedEntry(collection, ownerId, entryId, ruleId));
  }

  async commitEntry(collectionId: string, ownerId: string, entryId: string, ruleId: string, expectedUpdatedAt: string): Promise<StockMovement> {
    const collection = await this.collection(collectionId, ownerId);
    const prepared = await this.preparedEntry(collection, ownerId, entryId, ruleId, expectedUpdatedAt);
    return this.commitPrepared(collection, ownerId, prepared);
  }

  async positions(collectionId: string, ownerId: string): Promise<StockPosition[]> {
    await this.collection(collectionId, ownerId);
    const balances = new Map<string, Rational>();
    const names = new Map<string, string>();
    for await (const movement of this.movements.find({ collectionId, ownerId }).sort({ occurredAt: 1, _id: 1 }).cursor()) {
      names.set(movement.productId, movement.productName);
      for (const delta of this.deltas(movement)) {
        const key = JSON.stringify([movement.productId, delta.key]);
        balances.set(key, add(balances.get(key) ?? zero(), delta.amount));
      }
    }
    return [...balances.entries()].filter(([, amount]) => amount.n !== 0n).map(([key, amount]) => {
      const [productId, position] = JSON.parse(key) as [string, string];
      const [location, lot] = JSON.parse(position) as [string, string];
      return { productId, productName: names.get(productId) ?? productId, location, lot, quantity: fractionText(amount) };
    }).sort((a, b) => a.productName.localeCompare(b.productName) || a.location.localeCompare(b.location) || a.lot.localeCompare(b.lot));
  }

  async listMovements(collectionId: string, ownerId: string, productId?: string, before?: string, limit = 50): Promise<StockMovement[]> {
    await this.collection(collectionId, ownerId);
    if (productId && !Types.ObjectId.isValid(productId)) throw new BadRequestException('Invalid product ID');
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new BadRequestException('Choose 1 to 200 movements');
    const beforeDate = before ? this.factDate(before) : undefined;
    return this.movements.find({ collectionId, ownerId, ...(productId ? { productId } : {}), ...(beforeDate ? { createdAt: { $lt: beforeDate } } : {}) }).sort({ createdAt: -1, _id: -1 }).limit(limit).exec();
  }

  async dailyReport(collectionId: string, ownerId: string, productId: string, from: string, to: string, timeZone: string, location?: string, lot?: string): Promise<StockDailyRow[]> {
    const collection = await this.collection(collectionId, ownerId);
    await this.product(collection, productId, ownerId);
    if (!validTimeZone(timeZone)) throw new BadRequestException('Choose a valid time zone');
    const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    if (!validDate(from) || !validDate(to)) throw new BadRequestException('Choose valid report dates');
    const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
    if (span < 0 || span > 30) throw new BadRequestException('Choose up to 31 days');
    const chosenLocation = location == null ? undefined : this.label(location, 'Location');
    const chosenLot = lot == null ? undefined : this.label(lot, 'Lot');
    const byDay = new Map<string, { opening: Rational; incoming: Rational; outgoing: Rational; closing: Rational; movements: StockMovement[] }>();
    let balance = zero();
    let opening = zero();
    let reachedRange = false;
    for await (const movement of this.movements.find({ collectionId, ownerId, productId }).sort({ occurredAt: 1, _id: 1 }).cursor()) {
      const date = localDate(localTime(movement.occurredAt, timeZone));
      const net = this.deltas(movement).filter((delta) => {
        const [deltaLocation, deltaLot] = JSON.parse(delta.key) as [string, string];
        return (chosenLocation === undefined || deltaLocation === chosenLocation) && (chosenLot === undefined || deltaLot === chosenLot);
      }).reduce((sum, delta) => add(sum, delta.amount), zero());
      if (date < from) { balance = add(balance, net); continue; }
      if (!reachedRange) { opening = balance; reachedRange = true; }
      if (date > to) break;
      let row = byDay.get(date);
      if (!row) { row = { opening: balance, incoming: zero(), outgoing: zero(), closing: balance, movements: [] }; byDay.set(date, row); }
      row.movements.push(movement);
      if (net.n >= 0n) row.incoming = add(row.incoming, net);
      else row.outgoing = add(row.outgoing, neg(net));
      balance = add(balance, net);
      row.closing = balance;
    }
    if (!reachedRange) opening = balance;
    const result: StockDailyRow[] = [];
    let current = opening;
    for (let index = 0; index <= span; index++) {
      const date = new Date(Date.parse(`${from}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10);
      const row = byDay.get(date);
      result.push({ date, opening: fractionText(current), incoming: fractionText(row?.incoming ?? zero()), outgoing: fractionText(row?.outgoing ?? zero()), closing: fractionText(row?.closing ?? current), movements: row?.movements ?? [] });
      current = row?.closing ?? current;
    }
    return result;
  }
}
