import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { Collection, FieldKind } from './collection.schema';
import { CollectionRole } from './collaboration.schema';
import { CollaborationService } from './collaboration.service';
import { Entry } from './entry.schema';
import { EntryRelation, RelationImpact, RelationKind, RelationTotal } from './relation.schema';
import { graphNodes, validateNewEdge } from './relation-graph';
import { decimal, fractionText, multiply, resolveUnit, type Rational } from './unit_math';

@Injectable()
export class RelationService {
  constructor(
    @InjectModel(Collection.name) private readonly collections: Model<Collection>,
    @InjectModel(Entry.name) private readonly entries: Model<Entry>,
    @InjectModel(EntryRelation.name) private readonly relations: Model<EntryRelation>,
    private readonly collaboration: CollaborationService,
  ) {}

  private async context(collectionId: string, userId: string, role = CollectionRole.READER): Promise<Collection> {
    if (!Types.ObjectId.isValid(collectionId)) throw new NotFoundException('Collection not found');
    const collection = await this.collections.findById(collectionId).exec();
    if (!collection) throw new NotFoundException('Collection not found');
    this.collaboration.checkAccess(collection, userId, role);
    return collection;
  }

  private async assertEntries(collectionId: string, ids: string[]): Promise<void> {
    if (ids.some((id) => !Types.ObjectId.isValid(id))) throw new NotFoundException('Entry not found');
    if (await this.entries.countDocuments({ _id: { $in: [...new Set(ids)] }, collectionId, movingOperationId: null }).exec() !== new Set(ids).size) throw new NotFoundException('Entry not found');
  }

  private async edges(collectionId: string, kind?: RelationKind): Promise<EntryRelation[]> {
    return this.relations.find({ collectionId, deletedAt: null, ...(kind ? { kind } : {}) }).lean().exec() as unknown as EntryRelation[];
  }

  private async lock(collectionId: string): Promise<string> {
    const token = randomUUID();
    const staleAt = new Date(Date.now() - 120_000);
    const result = await this.collections.updateOne({ _id: collectionId, $or: [{ relationLockOwner: null }, { relationLockAt: { $lt: staleAt } }] }, { $set: { relationLockOwner: token, relationLockAt: new Date() }, $inc: { relationVersion: 1 } }).exec();
    if (!result.modifiedCount) throw new BadRequestException('Relations are being updated. Try again');
    return token;
  }

  private async unlock(collectionId: string, token: string): Promise<void> {
    await this.collections.updateOne({ _id: collectionId, relationLockOwner: token }, { $unset: { relationLockOwner: '', relationLockAt: '' } }).exec();
  }

  async list(collectionId: string, entryId: string, userId: string): Promise<EntryRelation[]> {
    await this.context(collectionId, userId);
    await this.assertEntries(collectionId, [entryId]);
    return this.relations.find({ collectionId, deletedAt: null, $or: [{ fromEntryId: entryId }, { toEntryId: entryId }] }).sort({ createdAt: -1 }).exec();
  }

  async create(collectionId: string, fromEntryId: string, toEntryId: string, kind: RelationKind, label: string, quantity: string | undefined, unit: string | undefined, userId: string, snapshotFieldId?: string): Promise<EntryRelation> {
    const collection = await this.context(collectionId, userId, CollectionRole.EDITOR);
    await this.assertEntries(collectionId, [fromEntryId, toEntryId]);
    if (!Object.values(RelationKind).includes(kind) || label.length > 120) throw new BadRequestException('Invalid relation');
    if (kind === RelationKind.COMPONENT) {
      if (!quantity || !unit || decimal(quantity).n <= 0n) throw new BadRequestException('Enter a positive quantity and a unit');
      resolveUnit(unit.replace(/^local:/, ''), collection.units ?? []);
    } else if (quantity || unit || snapshotFieldId) throw new BadRequestException('Quantity is only available for components');
    const token = await this.lock(collectionId);
    try {
    await this.assertEntries(collectionId, [fromEntryId, toEntryId]);
    const active = await this.edges(collectionId);
    validateNewEdge(active, { fromEntryId, toEntryId, kind });
    const existing = await this.relations.findOne({ collectionId, kind, fromEntryId, toEntryId }).exec();
    if (existing && !existing.deletedAt) throw new BadRequestException('Relation already exists');
    let snapshot: { snapshotValue?: string; snapshotUnit?: string; snapshotFieldId?: string } = {};
    if (snapshotFieldId) {
      const child = await this.entries.findById(toEntryId).exec();
      const field = collection.formats.find((format) => format.id === child?.formatId)?.fields.find((item) => item.id === snapshotFieldId && [FieldKind.NUMBER, FieldKind.MEASURE].includes(item.kind));
      const value = child?.values.find((item) => item.fieldId === snapshotFieldId);
      if (!field || !value || ['MISSING', 'ABSENT'].includes(value.measureValue?.status ?? '')) throw new BadRequestException('Snapshot field has no numeric value');
      decimal(value.numberValue ?? value.value);
      snapshot = { snapshotFieldId, snapshotValue: value.numberValue ?? value.value, snapshotUnit: value.unitSnapshot?.id ?? field.unit };
    }
    if (existing) return (await this.relations.findByIdAndUpdate(existing.id, { $set: { label, quantity, unit, ...snapshot, createdBy: userId }, $unset: { deletedAt: '' } }, { returnDocument: 'after' }).exec())!;
    return this.relations.create({ collectionId, ownerId: collection.ownerId, fromEntryId, toEntryId, kind, label, quantity, unit, ...snapshot, createdBy: userId });
    } finally { await this.unlock(collectionId, token); }
  }

  async impact(collectionId: string, entryId: string, replacementId: string | undefined, userId: string): Promise<RelationImpact> {
    await this.context(collectionId, userId, CollectionRole.EDITOR);
    await this.assertEntries(collectionId, [entryId, ...(replacementId ? [replacementId] : [])]);
    const relations = await this.relations.find({ collectionId, deletedAt: null, $or: [{ fromEntryId: entryId }, { toEntryId: entryId }] }).exec();
    const active = await this.edges(collectionId);
    let replacementAllowed = !!replacementId && replacementId !== entryId;
    if (replacementAllowed) {
      try {
        const affected = new Set(relations.map((item) => item.id));
        const remaining = active.filter((edge) => !affected.has(String((edge as EntryRelation & { _id?: unknown })._id ?? edge.id)));
        for (const relation of relations) {
          const edge = { fromEntryId: relation.fromEntryId === entryId ? replacementId! : relation.fromEntryId, toEntryId: relation.toEntryId === entryId ? replacementId! : relation.toEntryId, kind: relation.kind };
          validateNewEdge(remaining, edge); remaining.push(edge as EntryRelation);
        }
      } catch { replacementAllowed = false; }
    }
    return { relations, replacementAllowed };
  }

  async remove(collectionId: string, relationId: string, userId: string): Promise<boolean> {
    const collection = await this.context(collectionId, userId, CollectionRole.EDITOR);
    if (!Types.ObjectId.isValid(relationId)) throw new NotFoundException('Relation not found');
    const relation = await this.relations.findOne({ _id: relationId, collectionId, deletedAt: null }).exec();
    if (!relation) throw new NotFoundException('Relation not found');
    const token = await this.lock(collection.id);
    try { await this.relations.updateOne({ _id: relationId, deletedAt: null }, { $set: { deletedAt: new Date() } }).exec(); }
    finally { await this.unlock(collection.id, token); }
    return true;
  }

  async importRelations(collectionId: string, userId: string, importKey: string, rows: { fromSourceId: string; toSourceId: string; kind: RelationKind; label: string; quantity?: string; unit?: string; snapshotValue?: string; snapshotUnit?: string; snapshotFieldId?: string }[]): Promise<boolean> {
    await this.context(collectionId, userId, CollectionRole.EDITOR);
    if (!/^[\w.-]{1,100}$/.test(importKey) || rows.length > 100) throw new BadRequestException('Invalid relation import batch');
    const sourceIds = [...new Set(rows.flatMap((row) => [row.fromSourceId, row.toSourceId]))];
    const entries = await this.entries.find({ collectionId, importKey, sourceId: { $in: sourceIds } }).select('_id sourceId').exec();
    const bySource = new Map(entries.map((entry) => [entry.sourceId, entry.id]));
    if (bySource.size !== sourceIds.length) throw new BadRequestException('A related entry was not imported');
    for (const row of rows) {
      const fromEntryId = bySource.get(row.fromSourceId)!, toEntryId = bySource.get(row.toSourceId)!;
      const existing = await this.relations.findOne({ collectionId, fromEntryId, toEntryId, kind: row.kind, deletedAt: null }).exec();
      if (existing) continue;
      const relation = await this.create(collectionId, fromEntryId, toEntryId, row.kind, row.label, row.quantity, row.unit, userId);
      if (row.snapshotValue !== undefined) {
        decimal(row.snapshotValue);
        await this.relations.updateOne({ _id: relation.id }, { $set: { snapshotValue: row.snapshotValue, snapshotUnit: row.snapshotUnit, snapshotFieldId: row.snapshotFieldId } }).exec();
      }
    }
    return true;
  }

  async detach(collectionId: string, entryId: string, replacementId: string | undefined, userId: string): Promise<boolean> {
    const collection = await this.context(collectionId, userId, CollectionRole.EDITOR);
    const token = await this.lock(collectionId);
    try {
    const preview = await this.impact(collectionId, entryId, replacementId, userId);
    if (replacementId && !preview.replacementAllowed) throw new BadRequestException('Replacement would create a cycle or duplicate parent');
    if (replacementId) {
      for (const relation of preview.relations) {
        const fromEntryId = relation.fromEntryId === entryId ? replacementId : relation.fromEntryId;
        const toEntryId = relation.toEntryId === entryId ? replacementId : relation.toEntryId;
        await this.relations.updateOne({ _id: relation.id, deletedAt: null }, { $set: { deletedAt: new Date() } }).exec();
        await this.relations.updateOne({ collectionId, kind: relation.kind, fromEntryId, toEntryId }, { $setOnInsert: { ownerId: collection.ownerId, label: relation.label, quantity: relation.quantity, unit: relation.unit, snapshotValue: relation.snapshotValue, snapshotUnit: relation.snapshotUnit, snapshotFieldId: relation.snapshotFieldId, createdBy: userId, createdAt: new Date() }, $unset: { deletedAt: '' } }, { upsert: true }).exec();
      }
    } else await this.relations.updateMany({ collectionId, deletedAt: null, $or: [{ fromEntryId: entryId }, { toEntryId: entryId }] }, { $set: { deletedAt: new Date() } }).exec();
    return true;
    } finally { await this.unlock(collectionId, token); }
  }

  async assertDetached(entryId: string, userId: string): Promise<void> {
    const entry = await this.entries.findById(entryId).exec();
    if (!entry) return;
    await this.context(entry.collectionId, userId, CollectionRole.EDITOR);
    if (await this.relations.exists({ collectionId: entry.collectionId, deletedAt: null, $or: [{ fromEntryId: entryId }, { toEntryId: entryId }] })) throw new BadRequestException('Review and detach or replace this entry’s relations before deleting it');
  }

  async deleteEntry<T>(entryId: string, userId: string, remove: () => Promise<T>): Promise<T> {
    const entry = await this.entries.findById(entryId).exec();
    if (!entry) throw new NotFoundException('Entry not found');
    await this.context(entry.collectionId, userId, CollectionRole.EDITOR);
    const token = await this.lock(entry.collectionId);
    try { await this.assertDetached(entryId, userId); return await remove(); }
    finally { await this.unlock(entry.collectionId, token); }
  }

  async purgeCollection(collectionId: string): Promise<void> {
    await this.relations.deleteMany({ collectionId }).exec();
  }

  async purgeContributionEntry(collectionId: string, entryId: string, ownerId: string): Promise<void> {
    await this.context(collectionId, ownerId, CollectionRole.OWNER);
    await this.relations.deleteMany({ collectionId, $or: [{ fromEntryId: entryId }, { toEntryId: entryId }] }).exec();
  }

  async total(collectionId: string, rootId: string, kind: RelationKind, fieldName: string, userId: string): Promise<RelationTotal> {
    const collection = await this.context(collectionId, userId);
    await this.assertEntries(collectionId, [rootId]);
    if (![RelationKind.PARENT, RelationKind.COMPONENT].includes(kind) || !fieldName.trim() || fieldName.length > 120) throw new BadRequestException('Choose a numeric field and relation type');
    const { member } = this.collaboration.checkAccess(collection, userId);
    const edges = await this.edges(collectionId, kind);
    const children = new Map<string, EntryRelation[]>();
    const incoming = new Map<string, EntryRelation[]>();
    for (const edge of edges) {
      const parent = kind === RelationKind.PARENT ? edge.toEntryId : edge.fromEntryId;
      const child = kind === RelationKind.PARENT ? edge.fromEntryId : edge.toEntryId;
      children.set(parent, [...(children.get(parent) ?? []), edge]);
      incoming.set(child, [...(incoming.get(child) ?? []), edge]);
    }
    const ids = graphNodes(edges, rootId, kind);
    const reachable = new Set(ids);
    if (ids.length > 10000) throw new BadRequestException('Relation graph is too large');
    const entries = await this.entries.find({ _id: { $in: ids }, collectionId }).lean().exec() as unknown as Entry[];
    const byId = new Map(entries.map((entry) => [String((entry as Entry & { _id?: unknown })._id ?? entry.id), entry]));
    const fieldByFormat = new Map(collection.formats.map((format) => [format.id, format.fields.find((field) => field.name.toLocaleLowerCase() === fieldName.trim().toLocaleLowerCase() && [FieldKind.NUMBER, FieldKind.MEASURE].includes(field.kind))]));
    let unit: string | undefined;
    let sum: Rational = { n: 0n, d: 1n };
    let count = 0;
    const factor = new Map<string, Rational>([[rootId, { n: 1n, d: 1n }]]);
    const addValue = (raw: string, itemUnit: string | undefined, weight: Rational): void => {
      const number = decimal(raw);
      let value = number;
      if (count && itemUnit !== unit) {
        if (!itemUnit || !unit) throw new BadRequestException('Incompatible units in relation total');
        const left = resolveUnit(unit.replace(/^local:/, ''), collection.units ?? []);
        const right = resolveUnit(itemUnit.replace(/^local:/, ''), collection.units ?? []);
        if (left.root !== right.root || left.dimension === 'CURRENCY') throw new BadRequestException('Incompatible units in relation total');
        value = { n: number.n * right.factor.n * left.factor.d, d: number.d * right.factor.d * left.factor.n };
      } else if (!count) unit = itemUnit;
      const weighted = multiply(value, weight);
      sum = { n: sum.n * weighted.d + weighted.n * sum.d, d: sum.d * weighted.d };
      count++;
    };
    for (const id of ids) {
      const entry = byId.get(id);
      if (!entry) throw new BadRequestException('A related entry is missing');
      const field = fieldByFormat.get(entry.formatId!);
      if (field && member?.sharedFieldIds?.length && !member.sharedFieldIds.includes(field.id)) throw new BadRequestException('This field is not shared with you');
      const stored = field ? entry.values.find((item) => item.fieldId === field.id) : undefined;
      const current = stored && !['MISSING', 'ABSENT'].includes(stored.measureValue?.status ?? '') ? stored.numberValue ?? stored.value : undefined;
      const currentUnit = stored?.unitSnapshot?.id ?? field?.unit;
      if (id === rootId && current !== undefined) addValue(current, currentUnit, { n: 1n, d: 1n });
      for (const edge of incoming.get(id) ?? []) {
        const parent = kind === RelationKind.PARENT ? edge.toEntryId : edge.fromEntryId;
        if (!reachable.has(parent)) continue;
        const quantityUnit = kind === RelationKind.COMPONENT ? resolveUnit(edge.unit!.replace(/^local:/, ''), collection.units ?? []) : undefined;
        if (quantityUnit && quantityUnit.dimension !== 'COUNT') throw new BadRequestException('Composition totals require count units');
        const weight = quantityUnit ? multiply(factor.get(parent) ?? { n: 1n, d: 1n }, multiply(decimal(edge.quantity!), quantityUnit.factor)) : { n: 1n, d: 1n };
        const snapshot = edge.snapshotFieldId === field?.id ? edge.snapshotValue : undefined;
        if (snapshot !== undefined) addValue(snapshot, edge.snapshotUnit ?? currentUnit, weight);
        else if (current !== undefined) addValue(current, currentUnit, weight);
      }
      if (kind === RelationKind.COMPONENT) for (const edge of children.get(id) ?? []) {
        const quantityUnit = resolveUnit(edge.unit!.replace(/^local:/, ''), collection.units ?? []);
        if (quantityUnit.dimension !== 'COUNT') throw new BadRequestException('Composition totals require count units');
        const contribution = multiply(factor.get(id) ?? { n: 1n, d: 1n }, multiply(decimal(edge.quantity!), quantityUnit.factor));
        const previous = factor.get(edge.toEntryId) ?? { n: 0n, d: 1n };
        factor.set(edge.toEntryId, { n: previous.n * contribution.d + contribution.n * previous.d, d: previous.d * contribution.d });
      }
    }
    if (!count) throw new BadRequestException('No numeric values found in the related entries');
    return { value: fractionText(sum), unit, nodes: ids.length };
  }
}
