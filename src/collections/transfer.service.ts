import { BadRequestException, Injectable, NotFoundException, OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { ClassificationList, Collection, CollectionField, CollectionFormat, CollectionFormula, LinkedFormatUpdatePreview, MoveOperationStatus, SharedObjectGrant, TransferPreview, TransferResult } from './collection.schema.js';
import { Entry, EntryValue, ObjectPropertySnapshot, ObjectReferenceSnapshot } from './entry.schema.js';
import { CollectionUnit, UnitSnapshot } from './unit.schema.js';
import { MoveOperation } from './move-operation.schema.js';
import { EntryReminder } from './reminder.schema.js';
import { StockMovement } from './stock.schema.js';
import { EntryRelation } from './relation.schema.js';
import { CollaborationService } from './collaboration.service.js';
import { protectedFields } from './sensitivity.logic.js';
import { formulaChildKeys } from './formula_nodes.js';

const colors = ['#EEF5FF', '#EDF9F3', '#FFF5EB', '#F4F0FF', '#FFF0F4', '#EAF8FA', '#FBF7E9', '#F1F8ED', '#F8F0FA', '#F1F5FA', '#FFF7F1', '#EFF8FF', '#FDEFF7', '#EDF7FF', '#F7FBEA', '#FFF0E8', '#EFEFFD', '#E9F8F4', '#FBF1E8', '#F0F8F9', '#FFF2EF', '#F4F8E8', '#F1F2FF', '#EFFAF0'];
type CopyPlan = { source: Collection; target: Collection; formats: CollectionFormat[]; units: CollectionUnit[]; codeLists: ClassificationList[]; formulas: CollectionFormula[]; entries: Entry[]; relations: EntryRelation[]; conflicts: string[]; colors: Map<string, string> };

@Injectable()
export class TransferService implements OnApplicationBootstrap {
  constructor(
    @InjectModel(Collection.name) private readonly collections: Model<Collection>,
    @InjectModel(Entry.name) private readonly entries: Model<Entry>,
    @InjectModel(MoveOperation.name) private readonly moves: Model<MoveOperation>,
    @InjectModel(EntryReminder.name) private readonly reminders: Model<EntryReminder>,
    @InjectModel(StockMovement.name) private readonly stockMovements: Model<StockMovement>,
    private readonly collaboration: CollaborationService,
    @InjectModel(EntryRelation.name) private readonly relations: Model<EntryRelation>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const stale = await this.moves.find({ state: { $in: ['PLANNED', 'PREPARED', 'COPIED', 'RECOVERING'] } }).exec();
    for (const operation of stale) {
      try { await this.recoverMove(operation); }
      catch (error) { await this.moves.updateOne({ transferKey: operation.transferKey }, { $set: { state: 'FAILED', failure: error instanceof Error ? error.message : 'Recovery failed' } }).exec(); }
    }
  }

  private async collection(id: string, ownerId: string): Promise<Collection> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Collection not found');
    const collection = await this.collections.findOne({ _id: id, ownerId }).exec();
    if (!collection) throw new NotFoundException('Collection not found');
    return collection;
  }

  private async objectSource(objectId: string, ownerId: string): Promise<{ source: Collection; entry: Entry }> {
    if (!Types.ObjectId.isValid(objectId)) throw new NotFoundException('Object not found');
    const entry = await this.entries.findOne({ _id: objectId, ownerId }).exec();
    if (!entry) throw new NotFoundException('Object not found');
    const source = await this.collection(entry.collectionId, ownerId);
    if (!source.formats.some((format) => format.id === entry.formatId && format.objectModel)) throw new NotFoundException('Object not found');
    return { source, entry };
  }

  private async formatSource(formatId: string, ownerId: string): Promise<{ source: Collection; format: CollectionFormat }> {
    const source = await this.collections.findOne({ ownerId, 'formats.id': formatId }).exec();
    const format = source?.formats.find((item) => item.id === formatId);
    if (!source || !format) throw new NotFoundException('Data format not found');
    return { source, format };
  }

  async shareObject(objectId: string, targetCollectionId: string, propertyFieldIds: string[], mode: string, ownerId: string, includeSensitive = false): Promise<SharedObjectGrant> {
    const { source, entry } = await this.objectSource(objectId, ownerId);
    if (entry.movingOperationId) throw new BadRequestException('This object is being moved');
    const target = await this.collection(targetCollectionId, ownerId);
    if (target.id === source.id) throw new BadRequestException('Choose another collection');
    if (!['CURRENT', 'SNAPSHOT'].includes(mode)) throw new BadRequestException('Choose current values or a snapshot');
    const format = source.formats.find((item) => item.id === entry.formatId)!;
    const sensitiveFieldIds = propertyFieldIds.filter((id) => protectedFields(format).has(id));
    if (sensitiveFieldIds.length && !includeSensitive) throw new BadRequestException('Choose explicitly to share protected object properties');
    const allowed = new Set(propertyFieldIds);
    const title = format.fields.find((field) => field.kind === 'TITLE');
    if (!title || !allowed.has(title.id) || allowed.size < 1 || allowed.size > 30 || allowed.size !== propertyFieldIds.length || propertyFieldIds.some((id) => !format.fields.some((field) => field.id === id && !['OBJECT_REF', 'ATTACHMENT'].includes(field.kind)))) {
      throw new BadRequestException('Choose distinct object properties, including its name');
    }
    if ((target.sharedObjects ?? []).some((grant) => grant.objectId === objectId && !grant.revokedAt)) throw new BadRequestException('This object is already linked to the target collection');
    if ((target.sharedObjects ?? []).length >= 100) throw new BadRequestException('This collection has reached its linked object limit');
    const snapshot: ObjectPropertySnapshot[] = format.fields.flatMap((field) => {
      const value = entry.values.find((item) => item.fieldId === field.id);
      return allowed.has(field.id) && value ? [{ fieldId: field.id, name: field.name, kind: field.kind, value: value.value, unitSnapshot: value.unitSnapshot }] : [];
    });
    const grant: SharedObjectGrant = { id: randomUUID(), sourceCollectionId: source.id, sourceFormatId: format.id, sourceFormatVersion: format.version ?? 1, objectId, sourceName: source.name, objectName: entry.values.find((item) => item.fieldId === title.id)!.value, propertyFieldIds, sensitiveFieldIds, mode, snapshot, createdAt: new Date() };
    const result = await this.collections.updateOne({ _id: target.id, ownerId, 'sharedObjects.99': { $exists: false }, sharedObjects: { $not: { $elemMatch: { objectId, revokedAt: null } } } }, { $push: { sharedObjects: grant } }).exec();
    if (!result.modifiedCount) throw new BadRequestException('The target collection changed. Review the link again');
    if (sensitiveFieldIds.length) await this.collaboration.logAction(source.id, ownerId, 'SHARE_PROTECTED_FIELDS', `Object ${objectId}; target ${target.id}; fields ${sensitiveFieldIds.join(',')}`);
    return grant;
  }

  async revokeObjectShare(targetCollectionId: string, grantId: string, ownerId: string): Promise<boolean> {
    const target = await this.collection(targetCollectionId, ownerId);
    const grant = (target.sharedObjects ?? []).find((item) => item.id === grantId && !item.revokedAt);
    if (!grant) throw new NotFoundException('Active object link not found');
    const result = await this.collections.updateOne({ _id: targetCollectionId, ownerId, sharedObjects: { $elemMatch: { id: grantId, revokedAt: null } } }, { $set: { 'sharedObjects.$.revokedAt': new Date() } }).exec();
    if (!result.modifiedCount) throw new BadRequestException('Object link changed. Refresh and try again');
    return true;
  }

  private async plan(source: Collection, target: Collection, rootFormatIds: string[], initialEntries: Entry[], ownerId: string): Promise<CopyPlan> {
    if (source.id === target.id) throw new BadRequestException('Choose another collection');
    const formatIds = new Set(rootFormatIds);
    const entryMap = new Map(initialEntries.map((entry) => [entry.id, entry]));
    const unitIds = new Set<string>();
    const conflicts: string[] = [];
    const sourceRelations = initialEntries.length ? await this.relations.find({ collectionId: source.id, deletedAt: null }).exec() : [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const relation of sourceRelations) {
        const from = entryMap.has(relation.fromEntryId), to = entryMap.has(relation.toEntryId);
        if ((from || to) && relation.unit?.startsWith('local:') && !unitIds.has(relation.unit.slice(6))) { unitIds.add(relation.unit.slice(6)); changed = true; }
        if (from === to) continue;
        const id = from ? relation.toEntryId : relation.fromEntryId;
        const dependency = await this.entries.findOne({ _id: id, ownerId, collectionId: source.id }).exec();
        if (!dependency) { conflicts.push('A related entry is missing'); continue; }
        entryMap.set(id, dependency); formatIds.add(dependency.formatId!); changed = true;
      }
      for (const entry of [...entryMap.values()]) {
        const dependencies = [...entry.values.flatMap((value) => value.objectIds ?? []), ...(entry.sourceObjectId ? [entry.sourceObjectId] : [])];
        for (const id of dependencies) {
          if (entryMap.has(id)) continue;
          const dependency = await this.entries.findOne({ _id: id, ownerId, collectionId: source.id }).exec();
          if (!dependency || !source.formats.some((format) => format.id === dependency.formatId && format.objectModel)) {
            conflicts.push('A referenced object is missing or outside the source collection');
            continue;
          }
          entryMap.set(id, dependency);
          formatIds.add(dependency.formatId!);
          changed = true;
        }
      }
      for (const id of [...formatIds]) {
        const format = source.formats.find((item) => item.id === id);
        if (!format) { conflicts.push('A required data format is missing'); continue; }
        for (const field of format.fields) {
          if (field.targetObjectFormatId && !formatIds.has(field.targetObjectFormatId)) { formatIds.add(field.targetObjectFormatId); changed = true; }
          if (field.unit?.startsWith('local:') && !unitIds.has(field.unit.slice(6))) { unitIds.add(field.unit.slice(6)); changed = true; }
        }
      }
      for (const formula of source.formulas ?? []) {
        if (!formatIds.has(formula.formatId)) continue;
        const scan = (node: unknown): void => {
          if (!node || typeof node !== 'object' || Array.isArray(node)) return;
          const value = node as Record<string, unknown>;
          if (typeof value.unit === 'string' && value.unit.startsWith('local:') && !unitIds.has(value.unit.slice(6))) { unitIds.add(value.unit.slice(6)); changed = true; }
          if (Array.isArray(value.args)) value.args.forEach(scan);
          for (const key of formulaChildKeys) if (value[key] && typeof value[key] === 'object') scan(value[key]);
        };
        try { scan(JSON.parse(formula.expression)); }
        catch { conflicts.push(`Formula expression is invalid: ${formula.name}`); }
      }
      for (const id of [...unitIds]) {
        const unit = source.units.find((item) => item.id === id);
        if (!unit) { conflicts.push('A required local unit is missing'); continue; }
        if (unit.baseUnitId && source.units.some((item) => item.id === unit.baseUnitId) && !unitIds.has(unit.baseUnitId)) { unitIds.add(unit.baseUnitId); changed = true; }
        if (unit.objectFormatId && !formatIds.has(unit.objectFormatId)) { formatIds.add(unit.objectFormatId); changed = true; }
      }
    }
    const formats = source.formats.filter((item) => formatIds.has(item.id));
    if (formats.some((item) => item.appendOnly)) conflicts.push('A register cannot be copied or moved as a data format');
    const requiredListIds = new Set(formats.flatMap((format) => format.fields.map((field) => field.codeListId).filter((id): id is string => !!id)));
    const codeLists = (source.codeLists ?? []).filter((item) => requiredListIds.has(item.id));
    if (codeLists.length !== requiredListIds.size) conflicts.push('A required code list is missing');
    if (codeLists.some((item) => item.external)) conflicts.push('Large code lists cannot be copied to another collection yet');
    const units = source.units.filter((item) => unitIds.has(item.id));
    const formulas = (source.formulas ?? []).filter((item) => formatIds.has(item.formatId));
    for (const formula of formulas) if (formula.dependencies.some((id) => !formulas.some((candidate) => candidate.id === id))) conflicts.push(`Formula dependency is missing: ${formula.name}`);
    if (target.formats.length + formats.length > 24) conflicts.push('The target collection has no room for these data formats');
    if (target.units.length + units.length > 100) conflicts.push('The target collection has no room for these units');
    if ((target.codeLists?.length ?? 0) + codeLists.length > 100) conflicts.push('The target collection has no room for these code lists');
    if ((target.formulas?.length ?? 0) + formulas.length > 100) conflicts.push('The target collection has no room for these formulas');
    for (const format of formats) if (target.formats.some((item) => item.name.toLocaleLowerCase() === format.name.toLocaleLowerCase())) conflicts.push(`Data format name already exists: ${format.name}`);
    for (const unit of units) if (target.units.some((item) => item.name.toLocaleLowerCase() === unit.name.toLocaleLowerCase() || item.symbol.toLocaleLowerCase() === unit.symbol.toLocaleLowerCase())) conflicts.push(`Unit already exists: ${unit.name}`);
    for (const list of codeLists) if ((target.codeLists ?? []).some((item) => item.name.toLocaleLowerCase() === list.name.toLocaleLowerCase())) conflicts.push(`Code list already exists: ${list.name}`);
    if (entryMap.size > 500) conflicts.push('Copy at most 500 entries at a time');
    const usedColors = new Set(target.formats.map((item) => item.color));
    const chosenColors = new Map<string, string>();
    for (const format of formats) {
      const color = !usedColors.has(format.color) ? format.color : colors.find((candidate) => !usedColors.has(candidate));
      if (!color) { conflicts.push('No pastel color is available in the target collection'); continue; }
      usedColors.add(color);
      chosenColors.set(format.id, color);
    }
    return { source, target, formats, units, codeLists, formulas, entries: [...entryMap.values()], relations: sourceRelations.filter((edge) => entryMap.has(edge.fromEntryId) && entryMap.has(edge.toEntryId)), conflicts: [...new Set(conflicts)], colors: chosenColors };
  }

  private summary(plan: CopyPlan): TransferPreview {
    return { sourceName: plan.source.name, targetName: plan.target.name, dataFormats: plan.formats.map((item) => item.name), units: plan.units.map((item) => item.name), codeLists: plan.codeLists.map((item) => item.name), formulas: plan.formulas.map((item) => item.name), objects: plan.entries.filter((entry) => plan.source.formats.some((format) => format.id === entry.formatId && format.objectModel)).length, entries: plan.entries.length, relations: plan.relations.length, conflicts: plan.conflicts, allowed: plan.conflicts.length === 0, stockMovementCount: 0 };
  }

  async objectPreview(objectId: string, targetCollectionId: string, ownerId: string): Promise<TransferPreview> {
    const { source, entry } = await this.objectSource(objectId, ownerId);
    const plan = await this.plan(source, await this.collection(targetCollectionId, ownerId), [entry.formatId!], [entry], ownerId);
    return { ...this.summary(plan), stockMovementCount: await this.stockMovements.countDocuments({ ownerId, collectionId: source.id, productId: { $in: plan.entries.map((item) => item.id) } }).exec() };
  }

  private async inbound(objectId: string, ownerId: string): Promise<{ references: number; shares: number; reminders: number }> {
    const [references, linked, reminders] = await Promise.all([
      this.entries.countDocuments({ ownerId, $or: [{ sourceObjectId: objectId }, { 'values.objectIds': objectId }] }).exec(),
      this.collections.find({ ownerId, sharedObjects: { $elemMatch: { objectId, revokedAt: null } } }).select('sharedObjects').exec(),
      this.reminders.countDocuments({ ownerId, entryId: objectId, state: 'ACTIVE' }).exec(),
    ]);
    return { references, shares: linked.reduce((count, collection) => count + (collection.sharedObjects ?? []).filter((grant) => grant.objectId === objectId && !grant.revokedAt).length, 0), reminders };
  }

  async movePreview(objectId: string, targetCollectionId: string, ownerId: string): Promise<TransferPreview> {
    const { source, entry } = await this.objectSource(objectId, ownerId);
    const plan = await this.plan(source, await this.collection(targetCollectionId, ownerId), [entry.formatId!], [entry], ownerId);
    const inbound = await this.inbound(objectId, ownerId);
    if (entry.movingOperationId) plan.conflicts.push('This object is already being moved');
    if (inbound.references) plan.conflicts.push(`${inbound.references} entries reference this object. Remove or replace these links first`);
    if (inbound.shares) plan.conflicts.push(`${inbound.shares} active object links must be revoked first`);
    if (inbound.reminders) plan.conflicts.push(`${inbound.reminders} active reminders must be cancelled before moving this object`);
    if (await this.relations.exists({ collectionId: source.id, deletedAt: null, $or: [{ fromEntryId: objectId }, { toEntryId: objectId }] })) plan.conflicts.push('Detach or replace this object’s relations before moving it');
    const stockMovementCount = await this.stockMovements.countDocuments({ ownerId, collectionId: source.id, productId: objectId }).exec();
    if (stockMovementCount) plan.conflicts.push('This object has stock history. Copy it to the target; stock movements remain in the source collection');
    return { ...this.summary(plan), allowed: plan.conflicts.length === 0, inboundReferences: inbound.references, activeShares: inbound.shares, stockMovementCount };
  }

  async formatPreview(formatId: string, targetCollectionId: string, withEntries: boolean, ownerId: string): Promise<TransferPreview> {
    const { source } = await this.formatSource(formatId, ownerId);
    const entries = withEntries ? await this.entries.find({ ownerId, collectionId: source.id, formatId }).limit(501).exec() : [];
    const plan = await this.plan(source, await this.collection(targetCollectionId, ownerId), [formatId], entries, ownerId);
    return { ...this.summary(plan), stockMovementCount: withEntries ? await this.stockMovements.countDocuments({ ownerId, collectionId: source.id, productId: { $in: plan.entries.map((item) => item.id) } }).exec() : 0 };
  }

  private remapSnapshot(snapshot: UnitSnapshot | undefined, unitIds: Map<string, string>, formatIds: Map<string, string>): UnitSnapshot | undefined {
    if (!snapshot) return undefined;
    return { id: unitIds.get(snapshot.id) ?? snapshot.id, version: snapshot.version, symbol: snapshot.symbol, dimension: snapshot.dimension, factor: snapshot.factor, root: snapshot.root, objectFormatId: snapshot.objectFormatId ? formatIds.get(snapshot.objectFormatId) ?? snapshot.objectFormatId : undefined };
  }

  private remapValue(value: EntryValue, fieldIds: Map<string, string>, entryIds: Map<string, string>, unitIds: Map<string, string>, formatIds: Map<string, string>): EntryValue {
    const objectIds = value.objectIds?.map((id) => entryIds.get(id) ?? id);
    const objectSnapshots = value.objectSnapshots?.map((snapshot): ObjectReferenceSnapshot => ({
      objectId: entryIds.get(snapshot.objectId) ?? snapshot.objectId,
      formatId: formatIds.get(snapshot.formatId) ?? snapshot.formatId,
      formatVersion: snapshot.formatVersion,
      capturedAt: snapshot.capturedAt,
      properties: snapshot.properties.map((property) => ({ fieldId: fieldIds.get(property.fieldId) ?? property.fieldId, name: property.name, kind: property.kind, value: property.value, unitSnapshot: this.remapSnapshot(property.unitSnapshot, unitIds, formatIds) })),
    }));
    return { fieldId: fieldIds.get(value.fieldId) ?? value.fieldId, value: objectIds ? JSON.stringify(objectIds) : value.value, numberValue: value.numberValue, booleanValue: value.booleanValue, selectedValues: value.selectedValues, durationSeconds: value.durationSeconds, dateTimeValue: value.dateTimeValue, dateValue: value.dateValue, attachmentSize: value.attachmentSize, attachmentMimeType: value.attachmentMimeType, attachmentData: value.attachmentData, unitSnapshot: this.remapSnapshot(value.unitSnapshot, unitIds, formatIds), objectIds, objectSnapshots };
  }

  private async execute(plan: CopyPlan, rootObjectId?: string, rootFormatId?: string, move?: { transferKey: string; prepared: (targetObjectId: string, formatIds: string[], unitIds: string[]) => Promise<void> }, linkedRootFormatId?: string): Promise<TransferResult> {
    if (plan.conflicts.length) throw new BadRequestException(plan.conflicts.join('; '));
    const formatIds = new Map(plan.formats.map((format) => [format.id, randomUUID()]));
    const fieldIds = new Map(plan.formats.flatMap((format) => format.fields.map((field) => [field.id, randomUUID()] as const)));
    const unitIds = new Map(plan.units.map((unit) => [unit.id, randomUUID()]));
    const codeListIds = new Map(plan.codeLists.map((list) => [list.id, randomUUID()]));
    const formulaIds = new Map(plan.formulas.map((formula) => [formula.id, randomUUID()]));
    const entryIds = new Map(plan.entries.map((entry) => [entry.id, new Types.ObjectId().toString()]));
    const copiedFormats = plan.formats.map((format): CollectionFormat => ({ id: formatIds.get(format.id)!, name: format.name, color: plan.colors.get(format.id)!, version: 1, objectModel: format.objectModel, copiedFromFormatId: format.id, ...(format.id === linkedRootFormatId ? { linkedSource: { sourceCollectionId: plan.source.id, sourceFormatId: format.id, acceptedVersion: format.version ?? 1, targetVersion: 1 } } : {}), workflow: format.workflow ? { stateFieldId: fieldIds.get(format.workflow.stateFieldId)!, initialState: format.workflow.initialState, transitions: format.workflow.transitions.map((item) => ({ from: item.from, to: item.to, minimumRole: item.minimumRole })), requirements: format.workflow.requirements.map((item) => ({ state: item.state, fieldIds: item.fieldIds.map((id) => fieldIds.get(id)!) })) } : undefined, fields: format.fields.map((field): CollectionField => ({ id: fieldIds.get(field.id)!, name: field.name, kind: field.kind, unit: field.unit?.startsWith('local:') ? `local:${unitIds.get(field.unit.slice(6))}` : field.unit, options: field.options, codeListId: field.codeListId ? codeListIds.get(field.codeListId) : undefined, targetObjectFormatId: field.targetObjectFormatId ? formatIds.get(field.targetObjectFormatId) : undefined, multiple: field.multiple, variableName: field.variableName, referenceMode: field.referenceMode, ...(format.id === linkedRootFormatId ? { sourceFieldId: field.id } : {}) })) }));
    const copiedUnits = plan.units.map((unit): CollectionUnit => ({ id: unitIds.get(unit.id)!, name: unit.name, symbol: unit.symbol, dimension: unit.dimension, factor: unit.factor, version: 1, copiedFromUnitId: unit.id, baseUnitId: unit.baseUnitId ? unitIds.get(unit.baseUnitId) ?? unit.baseUnitId : undefined, objectFormatId: unit.objectFormatId ? formatIds.get(unit.objectFormatId) : undefined }));
    const copiedCodeLists: ClassificationList[] = plan.codeLists.map((list) => ({ id: codeListIds.get(list.id)!, name: list.name, version: 1, codes: list.codes.map((item) => ({ ...item })), copiedFromListId: list.id }));
    const transferKey = move?.transferKey ?? randomUUID();
    const remapExpression = (node: Record<string, unknown>): Record<string, unknown> => {
      const mapped = { ...node };
      for (const key of ['fieldId', 'referenceFieldId', 'propertyFieldId', 'fromFieldId', 'toFieldId']) if (typeof mapped[key] === 'string') mapped[key] = fieldIds.get(mapped[key] as string) ?? mapped[key];
      if (Array.isArray(mapped.through)) mapped.through = mapped.through.map((step) => fieldIds.get(step as string) ?? step);
      if (typeof mapped.formulaId === 'string') mapped.formulaId =formulaIds.get(mapped.formulaId) ?? mapped.formulaId;
      if (typeof mapped.unit === 'string' && mapped.unit.startsWith('local:')) mapped.unit = `local:${unitIds.get(mapped.unit.slice(6)) ?? mapped.unit.slice(6)}`;
      if (Array.isArray(mapped.args)) mapped.args = mapped.args.map((arg) => remapExpression(arg as Record<string, unknown>));
      for (const key of formulaChildKeys) if (mapped[key] && typeof mapped[key] === 'object' && !Array.isArray(mapped[key])) mapped[key] = remapExpression(mapped[key] as Record<string, unknown>);
      return mapped;
    };
    const copiedFormulas: CollectionFormula[] = plan.formulas.map((formula) => ({ id: formulaIds.get(formula.id)!, name: formula.name, formatId: formatIds.get(formula.formatId)!, expression: JSON.stringify(remapExpression(JSON.parse(formula.expression) as Record<string, unknown>)), version: 1, dependencies: formula.dependencies.map((id) => formulaIds.get(id)!), transferKey, copiedFromFormulaId: formula.id }));
    if (move) await move.prepared(rootObjectId ? entryIds.get(rootObjectId)! : '', [...formatIds.values()], [...unitIds.values()]);
    const targetId = plan.target.id;
    const targetUpdatedAt = (plan.target as Collection & { updatedAt?: Date }).updatedAt;
    const target = await this.collections.findOneAndUpdate({ _id: targetId, ownerId: (plan.target as Collection & { ownerId: string }).ownerId, ...(targetUpdatedAt ? { updatedAt: targetUpdatedAt } : {}) }, { $push: { formats: { $each: copiedFormats }, units: { $each: copiedUnits }, codeLists: { $each: copiedCodeLists }, formulas: { $each: copiedFormulas } } }, { returnDocument: 'after', runValidators: true }).exec();
    if (!target) throw new BadRequestException('Target collection changed. Review the copy again');
    try {
      const documents = plan.entries.map((entry) => ({ _id: new Types.ObjectId(entryIds.get(entry.id)!), ownerId: entry.ownerId, collectionId: targetId, formatId: formatIds.get(entry.formatId!), formatVersion: 1, values: entry.values.map((value) => this.remapValue(value, fieldIds, entryIds, unitIds, formatIds)), workflow: entry.workflow ? { history: entry.workflow.history } : undefined, recurrence: entry.recurrence ? { startFieldId: fieldIds.get(entry.recurrence.startFieldId), endFieldId: fieldIds.get(entry.recurrence.endFieldId), timeZone: entry.recurrence.timeZone, frequency: entry.recurrence.frequency, interval: entry.recurrence.interval, untilDate: entry.recurrence.untilDate, excludedDates: entry.recurrence.excludedDates } : undefined, revisions: entry.revisions.map((revision) => ({ at: revision.at, formatVersion: revision.formatVersion, values: revision.values.map((value) => this.remapValue(value, fieldIds, entryIds, unitIds, formatIds)) })), sourceObjectId: entry.sourceObjectId ? entryIds.get(entry.sourceObjectId) : undefined, copiedFromCollectionId: plan.source.id, copiedFromEntryId: entry.id, transferKey, createdAt: entry.createdAt, updatedAt: entry.updatedAt }));
      if (documents.length) await this.entries.insertMany(documents, { ordered: true });
      if (plan.relations.length) await this.relations.insertMany(plan.relations.map((edge) => ({ ownerId: edge.ownerId, collectionId: targetId, fromEntryId: entryIds.get(edge.fromEntryId)!, toEntryId: entryIds.get(edge.toEntryId)!, kind: edge.kind, label: edge.label, quantity: edge.quantity, unit: edge.unit?.startsWith('local:') ? `local:${unitIds.get(edge.unit.slice(6)) ?? edge.unit.slice(6)}` : edge.unit, snapshotValue: edge.snapshotValue, snapshotUnit: edge.snapshotUnit?.startsWith('local:') ? `local:${unitIds.get(edge.snapshotUnit.slice(6)) ?? edge.snapshotUnit.slice(6)}` : edge.snapshotUnit, snapshotFieldId: edge.snapshotFieldId ? fieldIds.get(edge.snapshotFieldId) : undefined, createdBy: edge.createdBy, transferKey })), { ordered: true });
      return { targetCollectionId: targetId, objectId: rootObjectId ? entryIds.get(rootObjectId) : undefined, dataFormatId: rootFormatId ? formatIds.get(rootFormatId) : undefined, copiedObjects: plan.entries.filter((entry) => plan.source.formats.some((format) => format.id === entry.formatId && format.objectModel)).length, copiedEntries: plan.entries.length, copiedRelations: plan.relations.length };
    } catch (error) {
      await this.entries.deleteMany({ transferKey, collectionId: targetId }).exec();
      await this.relations.deleteMany({ transferKey, collectionId: targetId }).exec();
      await this.collections.updateOne({ _id: targetId }, { $pull: { formats: { id: { $in: copiedFormats.map((item) => item.id) } }, units: { id: { $in: copiedUnits.map((item) => item.id) } }, codeLists: { id: { $in: copiedCodeLists.map((item) => item.id) } }, formulas: { transferKey } } }).exec();
      throw error;
    }
  }

  async copyObject(objectId: string, targetCollectionId: string, ownerId: string): Promise<TransferResult> {
    const { source, entry } = await this.objectSource(objectId, ownerId);
    if (entry.movingOperationId) throw new BadRequestException('This object is being moved');
    const plan = await this.plan(source, await this.collection(targetCollectionId, ownerId), [entry.formatId!], [entry], ownerId);
    return this.execute(plan, objectId);
  }

  async copyFormat(formatId: string, targetCollectionId: string, withEntries: boolean, ownerId: string): Promise<TransferResult> {
    const { source } = await this.formatSource(formatId, ownerId);
    const entries = withEntries ? await this.entries.find({ ownerId, collectionId: source.id, formatId }).limit(501).exec() : [];
    const plan = await this.plan(source, await this.collection(targetCollectionId, ownerId), [formatId], entries, ownerId);
    return this.execute(plan, undefined, formatId);
  }

  async linkFormat(formatId: string, targetCollectionId: string, ownerId: string): Promise<TransferResult> {
    const { source } = await this.formatSource(formatId, ownerId);
    const plan = await this.plan(source, await this.collection(targetCollectionId, ownerId), [formatId], [], ownerId);
    return this.execute(plan, undefined, formatId, undefined, formatId);
  }

  private async linkedUpdate(targetCollectionId: string, targetFormatId: string, ownerId: string): Promise<{ target: Collection; current: CollectionFormat; source: CollectionFormat; preview: LinkedFormatUpdatePreview; fields: CollectionField[] }> {
    const target = await this.collection(targetCollectionId, ownerId);
    const current = target.formats.find((format) => format.id === targetFormatId);
    if (!current?.linkedSource) throw new NotFoundException('Linked data format not found');
    const sourceCollection = await this.collection(current.linkedSource.sourceCollectionId, ownerId);
    const source = sourceCollection.formats.find((format) => format.id === current.linkedSource!.sourceFormatId);
    if (!source) throw new NotFoundException('Source data format not found');
    const conflicts: string[] = [];
    const addedFields: string[] = [];
    const changedFields: string[] = [];
    const removedFields: string[] = [];
    if ((current.version ?? 1) !== current.linkedSource.targetVersion) conflicts.push('This linked data format was changed locally. Keep its current version or resolve local edits before accepting the source');
    if ((source.version ?? 1) <= current.linkedSource.acceptedVersion) conflicts.push('The source has no newer version');
    if (target.formats.some((format) => format.id !== current.id && format.name.toLocaleLowerCase() === source.name.toLocaleLowerCase())) conflicts.push(`Data format name already exists: ${source.name}`);
    if (source.fields.length > 30) conflicts.push('The source has too many fields');
    const fields: CollectionField[] = [];
    for (const field of source.fields) {
      const prior = current.fields.find((item) => item.sourceFieldId === field.id);
      const unit = field.unit?.startsWith('local:') ? target.units.find((item) => item.copiedFromUnitId === field.unit!.slice(6)) : undefined;
      if (field.unit?.startsWith('local:') && !unit) conflicts.push(`Copy the required unit before accepting ${field.name}`);
      const sourceUnit = field.unit?.startsWith('local:') ? sourceCollection.units.find((item) => item.id === field.unit!.slice(6)) : undefined;
      if (unit && sourceUnit && (unit.dimension !== sourceUnit.dimension || unit.factor !== sourceUnit.factor || unit.symbol !== sourceUnit.symbol)) conflicts.push(`Review the changed unit for ${field.name} before accepting`);
      const objectFormat = field.targetObjectFormatId ? target.formats.find((item) => item.copiedFromFormatId === field.targetObjectFormatId) : undefined;
      if (field.targetObjectFormatId && !objectFormat) conflicts.push(`Copy the referenced object model before accepting ${field.name}`);
      const codeList = field.codeListId ? target.codeLists?.find((item) => item.copiedFromListId === field.codeListId) : undefined;
      if (field.codeListId && !codeList) conflicts.push(`Copy the required code list before accepting ${field.name}`);
      const mapped: CollectionField = { id: prior?.id ?? randomUUID(), sourceFieldId: field.id, name: field.name, kind: field.kind, unit: unit ? `local:${unit.id}` : field.unit, options: field.options, codeListId: codeList?.id, targetObjectFormatId: objectFormat?.id, multiple: field.multiple, variableName: field.variableName, referenceMode: field.referenceMode };
      if (!prior) addedFields.push(field.name);
      else if (prior.name !== mapped.name || prior.kind !== mapped.kind || prior.unit !== mapped.unit || prior.codeListId !== mapped.codeListId || JSON.stringify(prior.options ?? []) !== JSON.stringify(mapped.options ?? []) || prior.targetObjectFormatId !== mapped.targetObjectFormatId || prior.multiple !== mapped.multiple || prior.referenceMode !== mapped.referenceMode || prior.variableName !== mapped.variableName) {
        changedFields.push(field.name);
        if ((prior.kind !== mapped.kind || prior.unit !== mapped.unit || prior.targetObjectFormatId !== mapped.targetObjectFormatId || prior.referenceMode !== mapped.referenceMode) && (target.formulas ?? []).some((formula) => formula.formatId === current.id && formula.expression.includes(`"${prior.id}"`))) conflicts.push(`Formula uses ${field.name}; review it before accepting this change`);
        const populated = await this.entries.exists({ ownerId, collectionId: target.id, formatId: current.id, 'values.fieldId': prior.id });
        if (populated && (prior.kind !== mapped.kind || prior.unit !== mapped.unit || prior.codeListId !== mapped.codeListId || prior.targetObjectFormatId !== mapped.targetObjectFormatId || prior.multiple !== mapped.multiple || prior.referenceMode !== mapped.referenceMode || (prior.options ?? []).some((option) => !mapped.options?.includes(option)))) conflicts.push(`Field ${field.name} has saved values and cannot change incompatibly`);
      }
      fields.push(mapped);
    }
    for (const prior of current.fields) if (!source.fields.some((field) => field.id === prior.sourceFieldId)) {
      removedFields.push(prior.name);
      if ((target.formulas ?? []).some((formula) => formula.formatId === current.id && formula.expression.includes(`"${prior.id}"`))) conflicts.push(`Formula uses ${prior.name}; keep or remove the formula before accepting this change`);
      if (await this.entries.exists({ ownerId, collectionId: target.id, formatId: current.id, 'values.fieldId': prior.id })) conflicts.push(`Field ${prior.name} has saved values and cannot be removed`);
    }
    if (source.objectModel !== current.objectModel && await this.entries.exists({ ownerId, collectionId: target.id, formatId: current.id })) conflicts.push('Move target entries before changing its object model status');
    const preview: LinkedFormatUpdatePreview = { targetFormatId, sourceVersion: source.version ?? 1, acceptedVersion: current.linkedSource.acceptedVersion, addedFields, changedFields, removedFields, conflicts: [...new Set(conflicts)], allowed: conflicts.length === 0 };
    return { target, current, source, preview, fields };
  }

  async linkedFormatUpdatePreview(targetCollectionId: string, targetFormatId: string, ownerId: string): Promise<LinkedFormatUpdatePreview> {
    return (await this.linkedUpdate(targetCollectionId, targetFormatId, ownerId)).preview;
  }

  async acceptLinkedFormat(targetCollectionId: string, targetFormatId: string, expectedSourceVersion: number, ownerId: string): Promise<Collection> {
    const { target, current, source, preview, fields } = await this.linkedUpdate(targetCollectionId, targetFormatId, ownerId);
    if (!preview.allowed || preview.sourceVersion !== expectedSourceVersion) throw new BadRequestException(preview.conflicts.join('; ') || 'Source data format changed. Review its new version');
    const targetVersion = (current.version ?? 1) + 1;
    const changes: Record<string, unknown> = { 'formats.$.name': source.name, 'formats.$.fields': fields, 'formats.$.version': targetVersion, 'formats.$.objectModel': source.objectModel, 'formats.$.linkedSource.acceptedVersion': preview.sourceVersion, 'formats.$.linkedSource.targetVersion': targetVersion };
    if (target.formats[0].id === targetFormatId) changes.fields = fields;
    const updated = await this.collections.findOneAndUpdate({ _id: targetCollectionId, ownerId, formats: { $elemMatch: { id: targetFormatId, version: current.version ?? 1 } } }, { $set: changes }, { returnDocument: 'after', runValidators: true }).exec();
    if (!updated) throw new BadRequestException('Target data format changed. Review again');
    return updated;
  }

  async detachLinkedFormat(targetCollectionId: string, targetFormatId: string, ownerId: string): Promise<Collection> {
    const target = await this.collection(targetCollectionId, ownerId);
    const format = target.formats.find((item) => item.id === targetFormatId && item.linkedSource);
    if (!format) throw new NotFoundException('Linked data format not found');
    const updated = await this.collections.findOneAndUpdate({ _id: targetCollectionId, ownerId, formats: { $elemMatch: { id: targetFormatId, version: format.version ?? 1 } } }, { $unset: { 'formats.$.linkedSource': '' } }, { returnDocument: 'after', runValidators: true }).exec();
    if (!updated) throw new BadRequestException('Data format changed. Refresh and try again');
    return updated;
  }

  private async recoverMove(operation: MoveOperation): Promise<void> {
    const sourceExists = await this.entries.exists({ _id: operation.sourceObjectId, ownerId: operation.ownerId, collectionId: operation.sourceCollectionId });
    if (!sourceExists) {
      const targetExists = operation.targetObjectId && await this.entries.exists({ _id: operation.targetObjectId, ownerId: operation.ownerId, collectionId: operation.targetCollectionId });
      await this.moves.updateOne({ transferKey: operation.transferKey }, { $set: { state: targetExists ? 'COMPLETE' : 'FAILED', ...(targetExists ? {} : { failure: 'Source and copied target are both unavailable; manual recovery is required' }) } }).exec();
      return;
    }
    await this.moves.updateOne({ transferKey: operation.transferKey }, { $set: { state: 'RECOVERING' } }).exec();
    await this.entries.deleteMany({ ownerId: operation.ownerId, collectionId: operation.targetCollectionId, transferKey: operation.transferKey }).exec();
    await this.relations.deleteMany({ collectionId: operation.targetCollectionId, transferKey: operation.transferKey }).exec();
    await this.collections.updateOne({ _id: operation.targetCollectionId, ownerId: operation.ownerId }, { $pull: { formats: { id: { $in: operation.targetFormatIds ?? [] } }, units: { id: { $in: operation.targetUnitIds ?? [] } }, formulas: { transferKey: operation.transferKey } } }).exec();
    await this.entries.updateOne({ _id: operation.sourceObjectId, ownerId: operation.ownerId, movingOperationId: operation.transferKey }, { $unset: { movingOperationId: '' } }).exec();
    await this.moves.updateOne({ transferKey: operation.transferKey }, { $set: { state: 'ROLLED_BACK' } }).exec();
  }

  async moveStatus(operationId: string, ownerId: string): Promise<MoveOperationStatus> {
    if (!Types.ObjectId.isValid(operationId)) throw new NotFoundException('Move operation not found');
    const operation = await this.moves.findOne({ _id: operationId, ownerId }).exec();
    if (!operation) throw new NotFoundException('Move operation not found');
    return { id: operationId, state: operation.state, sourceObjectId: operation.sourceObjectId, targetCollectionId: operation.targetCollectionId, targetObjectId: operation.targetObjectId, failure: operation.failure };
  }

  async recoverStaleMove(operationId: string, ownerId: string): Promise<MoveOperationStatus> {
    if (!Types.ObjectId.isValid(operationId)) throw new NotFoundException('Move operation not found');
    const operation = await this.moves.findOne({ _id: operationId, ownerId }).exec();
    if (!operation) throw new NotFoundException('Move operation not found');
    if (['PLANNED', 'PREPARED', 'COPIED', 'RECOVERING'].includes(operation.state)) {
      if (operation.updatedAt.getTime() > Date.now() - 60_000) throw new BadRequestException('The move is still active. Try recovery after one minute');
      await this.recoverMove(operation);
    }
    return this.moveStatus(operationId, ownerId);
  }

  async moveObject(objectId: string, targetCollectionId: string, ownerId: string): Promise<TransferResult> {
    const preview = await this.movePreview(objectId, targetCollectionId, ownerId);
    if (!preview.allowed) throw new BadRequestException(preview.conflicts.join('; '));
    const { source } = await this.objectSource(objectId, ownerId);
    const transferKey = randomUUID();
    const operationId = new Types.ObjectId();
    await this.moves.create({ _id: operationId, ownerId, sourceCollectionId: source.id, targetCollectionId, sourceObjectId: objectId, transferKey, state: 'PLANNED', targetFormatIds: [], targetUnitIds: [] });
    let result: TransferResult | undefined;
    try {
      const lock = await this.entries.updateOne({ _id: objectId, ownerId, collectionId: source.id, movingOperationId: null }, { $set: { movingOperationId: transferKey } }).exec();
      if (!lock.modifiedCount) throw new BadRequestException('This object changed during the transfer');
      if (await this.stockMovements.exists({ ownerId, collectionId: source.id, productId: objectId })) throw new BadRequestException('This object has stock history. Copy it instead; stock remains in the source collection');
      const fresh = await this.objectSource(objectId, ownerId);
      const inbound = await this.inbound(objectId, ownerId);
      if (inbound.references || inbound.shares || inbound.reminders) throw new BadRequestException('New references, object links or reminders appeared. Review the move again');
      if (await this.relations.exists({ collectionId: source.id, deletedAt: null, $or: [{ fromEntryId: objectId }, { toEntryId: objectId }] })) throw new BadRequestException('New relations appeared. Review the move again');
      const plan = await this.plan(fresh.source, await this.collection(targetCollectionId, ownerId), [fresh.entry.formatId!], [fresh.entry], ownerId);
      result = await this.execute(plan, objectId, undefined, { transferKey, prepared: async (targetObjectId, formatIds, unitIds) => {
        await this.moves.updateOne({ transferKey, state: 'PLANNED' }, { $set: { state: 'PREPARED', targetObjectId, targetFormatIds: formatIds, targetUnitIds: unitIds } }).exec();
      } });
      await this.moves.updateOne({ transferKey }, { $set: { state: 'COPIED' } }).exec();
      if (await this.entries.exists({ ownerId, $or: [{ sourceObjectId: objectId }, { 'values.objectIds': objectId }] })) throw new BadRequestException('A new reference appeared during the move');
      if (await this.reminders.exists({ ownerId, entryId: objectId, state: 'ACTIVE' })) throw new BadRequestException('A new reminder appeared during the move');
      const removed = await this.entries.deleteOne({ _id: objectId, ownerId, collectionId: source.id, movingOperationId: transferKey }).exec();
      if (!removed.deletedCount) throw new BadRequestException('Source object changed during the move');
      await this.moves.updateOne({ transferKey }, { $set: { state: 'COMPLETE' } }).exec();
      return { ...result, operationId: operationId.toString() };
    } catch (error) {
      const operation = await this.moves.findOne({ transferKey }).exec();
      if (operation) await this.recoverMove(operation);
      if (result && !(await this.entries.exists({ _id: objectId, ownerId, collectionId: source.id }))) return { ...result, operationId: operationId.toString() };
      throw error;
    }
  }
}
