import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model, QueryFilter, Types } from 'mongoose';
import { CollectionExchangeRateInput, CollectionFieldInput, CollectionFormatInput, CollectionUnitInput, CreateCollectionInput, EntryFieldFilterInput, EntryFilterOperator, EntryRecurrenceInput, EntryValueInput, ImportEntriesInput, ImportObjectLinkInput, SavedCollectionViewInput, UpdateCollectionFieldInput, UpdateCollectionFormatInput } from './collection.input';
import { validateClassificationCodes } from './classification.logic';
import { Collection, CollectionField, CollectionFormat, CollectionFormatImpact, FieldKind, ObjectModelTemplate, SavedCollectionView, SensitivityLevel } from './collection.schema';
import { CalendarOccurrence, Entry, EntryAttachment, EntryPage, EntryValue, ImportEntriesResult, ObjectPropertySnapshot, ObjectReferenceSnapshot, ResolvedObjectReference, ResolvedObjectVariable } from './entry.schema';
import { ContributionLink, ContributionSubmission } from './contribution.schema';
import { addLocalDays, addLocalMonths, localDate, localTime, localToInstant, validTimeZone } from './time_math';
import { builtInUnits, decimal, divide, fractionText, multiply, resolveUnit } from './unit_math';
import { CollectionUnit, QuantityConversion, UnitSnapshot } from './unit.schema';
import { StockLedgerHead, StockMovement } from './stock.schema';
import { MeasurementService } from './measurement.service';
import { CollaborationService } from './collaboration.service';
import { LedgerService } from './ledger.service';
import { CollectionRole } from './collaboration.schema';
import { parsePosition, parseZone } from './geo.logic';
import { assertWorkflowEdit, importedWorkflowHistory, prepareWorkflowCreate, prepareWorkflowImport } from './workflow.rules';
import { protectedFields, validSensitivity } from './sensitivity.logic';

export const formatColors = [
  '#EEF5FF', '#EDF9F3', '#FFF5EB', '#F4F0FF',
  '#FFF0F4', '#EAF8FA', '#FBF7E9', '#F1F8ED',
  '#F8F0FA', '#F1F5FA', '#FFF7F1', '#EFF8FF',
  '#FDEFF7', '#EDF7FF', '#F7FBEA', '#FFF0E8',
  '#EFEFFD', '#E9F8F4', '#FBF1E8', '#F0F8F9',
  '#FFF2EF', '#F4F8E8', '#F1F2FF', '#EFFAF0',
];

const objectTemplates: ObjectModelTemplate[] = [
  { id: 'product', name: 'Product', description: 'A product with measurable characteristics', fields: [
    { id: 'product-name', name: 'Name', kind: FieldKind.TITLE }, { id: 'product-weight', name: 'Weight', kind: FieldKind.NUMBER, unit: 'kg' },
    { id: 'product-price', name: 'Price', kind: FieldKind.NUMBER, unit: 'USD' }, { id: 'product-density', name: 'Density', kind: FieldKind.NUMBER, unit: 'kg/L' },
    { id: 'product-length', name: 'Length', kind: FieldKind.NUMBER, unit: 'cm' }, { id: 'product-width', name: 'Width', kind: FieldKind.NUMBER, unit: 'cm' }, { id: 'product-height', name: 'Height', kind: FieldKind.NUMBER, unit: 'cm' },
  ] },
  { id: 'book', name: 'Book', description: 'Books with authors, pages and links', fields: [
    { id: 'book-title', name: 'Title', kind: FieldKind.TITLE }, { id: 'book-author', name: 'Author', kind: FieldKind.TEXT },
    { id: 'book-pages', name: 'Pages', kind: FieldKind.NUMBER }, { id: 'book-link', name: 'Link', kind: FieldKind.LINK },
  ] },
  { id: 'research-sample', name: 'Research sample', description: 'A sample with its own measurements', fields: [
    { id: 'sample-name', name: 'Name', kind: FieldKind.TITLE }, { id: 'sample-mass', name: 'Mass', kind: FieldKind.NUMBER, unit: 'g' },
    { id: 'sample-volume', name: 'Volume', kind: FieldKind.NUMBER, unit: 'mL' }, { id: 'sample-notes', name: 'Notes', kind: FieldKind.LONG_TEXT },
  ] },
];
const frenchObjectTemplates: Record<string, { name: string; description: string; fields: string[] }> = {
  product: { name: 'Produit', description: 'Un produit et ses caractéristiques mesurables', fields: ['Nom', 'Poids', 'Prix', 'Densité', 'Longueur', 'Largeur', 'Hauteur'] },
  book: { name: 'Livre', description: 'Un livre avec auteur, pages et lien', fields: ['Titre', 'Auteur', 'Pages', 'Lien'] },
  'research-sample': { name: 'Échantillon de recherche', description: 'Un échantillon et ses mesures', fields: ['Nom', 'Masse', 'Volume', 'Notes'] },
};

@Injectable()
export class CollectionsService {
  private readonly measurements = new MeasurementService();

  constructor(
    @InjectModel(Collection.name) private readonly collections: Model<Collection>,
    @InjectModel(Entry.name) private readonly entries: Model<Entry>,
    @InjectModel(ContributionLink.name) private readonly contributionLinks: Model<ContributionLink>,
    @InjectModel(ContributionSubmission.name) private readonly contributionSubmissions: Model<ContributionSubmission>,
    @InjectModel(StockMovement.name) private readonly stockMovements: Model<StockMovement>,
    @InjectModel(StockLedgerHead.name) private readonly stockLedgerHeads: Model<StockLedgerHead>,
    private readonly collaboration: CollaborationService,
    private readonly ledger: LedgerService,
  ) {}

  private validId(id: string): void {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Invalid ID');
  }

  async list(ownerId: string): Promise<Collection[]> {
    const collections = await this.collections.find({
      $or: [{ ownerId }, { 'members.userId': ownerId }],
    }).sort({ createdAt: -1 }).exec();
    return Promise.all(collections.map((collection) => this.ensureFormats(collection)));
  }

  async one(id: string, ownerId: string): Promise<Collection> {
    this.validId(id);
    const collection = await this.collections.findOne({
      _id: id,
      $or: [{ ownerId }, { 'members.userId': ownerId }],
    }).exec();
    if (!collection) throw new NotFoundException('Collection not found');
    return this.ensureFormats(collection);
  }

  private async ensureFormats(collection: Collection): Promise<Collection> {
    collection.units ??= [];
    collection.codeLists ??= [];
    collection.exchangeRates ??= [];
    collection.fields = (collection.fields ?? []).map((f) => {
      f.sensitivity ??= SensitivityLevel.ORDINARY;
      return f;
    });
    collection.formats = (collection.formats ?? []).map((format) => {
      format.sensitivity ??= SensitivityLevel.ORDINARY;
      format.fields = (format.fields ?? []).map((field) => {
        field.sensitivity ??= SensitivityLevel.ORDINARY;
        return field;
      });
      return format;
    });
    if (collection.formats?.length) return collection;
    const formatId = `legacy-${collection.id}`;
    const updated = await this.collections.findOneAndUpdate(
      { _id: collection.id, ownerId: collection.ownerId, 'formats.0': { $exists: false } },
      { $set: { formats: [{ id: formatId, name: 'General', color: formatColors[0], fields: collection.fields }] } },
      { new: true },
    ).exec() ?? await this.collections.findById(collection.id).exec();
    if (!updated) throw new NotFoundException('Collection not found');
    await this.entries.updateMany(
      { collectionId: collection.id, ownerId: collection.ownerId, formatId: { $exists: false } },
      { $set: { formatId } },
    ).exec();
    updated.units ??= [];
    updated.codeLists ??= [];
    updated.exchangeRates ??= [];
    updated.fields = (updated.fields ?? []).map((f) => {
      f.sensitivity ??= SensitivityLevel.ORDINARY;
      return f;
    });
    updated.formats = (updated.formats ?? []).map((format) => {
      format.sensitivity ??= SensitivityLevel.ORDINARY;
      format.fields = (format.fields ?? []).map((field) => {
        field.sensitivity ??= SensitivityLevel.ORDINARY;
        return field;
      });
      return format;
    });
    return updated;
  }

  private assertFieldUnits(formats: CollectionFormat[], units: CollectionUnit[]): void {
    for (const format of formats) for (const field of format.fields) {
      if (field.unit?.startsWith('local:')) resolveUnit(field.unit.slice(6), units);
    }
  }

  private normalizedUnit(input: CollectionUnitInput, id: string, version: number): CollectionUnit {
    const name = input.name.trim();
    const symbol = input.symbol.trim();
    const dimension = input.dimension.trim().toUpperCase();
    const baseUnitId = input.baseUnitId?.trim() || undefined;
    const objectFormatId = input.objectFormatId?.trim() || undefined;
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id) || builtInUnits.some((unit) => unit.id === id)) throw new BadRequestException('Invalid local unit ID');
    if (!name || name.length > 80 || !symbol || symbol.length > 24 || /[\x00-\x1f\x7f]/.test(name + symbol)) throw new BadRequestException('Unit needs a name and a short symbol');
    if (!/^[A-Z][A-Z0-9_]{0,39}$/.test(dimension)) throw new BadRequestException('Invalid unit dimension');
    decimal(input.factor, true);
    if (!baseUnitId && input.factor !== '1') throw new BadRequestException('A base unit must have factor 1');
    if (objectFormatId && dimension !== 'COUNT') throw new BadRequestException('Only count units can name an object model');
    if (dimension === 'CURRENCY' && baseUnitId) throw new BadRequestException('Currencies use dated exchange rates, not fixed factors');
    return { id, name, symbol, dimension, baseUnitId, factor: input.factor, objectFormatId, version };
  }

  private checkUnit(unit: CollectionUnit, units: CollectionUnit[], formats: CollectionFormat[]): void {
    if (unit.objectFormatId && !formats.some((format) => format.id === unit.objectFormatId)) throw new BadRequestException('Unit object model must belong to this collection');
    if (units.some((other) => other.id !== unit.id && (other.name.toLocaleLowerCase() === unit.name.toLocaleLowerCase() || other.symbol === unit.symbol))) throw new BadRequestException('Unit name and symbol must be unique in a collection');
    resolveUnit(unit.id, units);
  }

  private numberSnapshot(unitCode: string | undefined, units: CollectionUnit[], previous?: UnitSnapshot): UnitSnapshot | undefined {
    if (!unitCode) return undefined;
    const id = unitCode.startsWith('local:') ? unitCode.slice(6) : unitCode;
    if (!unitCode.startsWith('local:') && !builtInUnits.some((unit) => unit.id === id)) return undefined;
    const resolved = resolveUnit(id, units);
    if (previous) {
      if (previous.id !== id || !Number.isInteger(previous.version) || previous.version < 1 || previous.symbol.length > 24 || previous.dimension !== resolved.dimension || previous.root !== resolved.root) throw new BadRequestException('Invalid historical unit snapshot');
      decimal(previous.factor, true);
      return previous;
    }
    return { id, version: resolved.unit.version, symbol: resolved.unit.symbol, dimension: resolved.dimension, factor: fractionText(resolved.factor), root: resolved.root, objectFormatId: resolved.objectFormatId };
  }

  async availableUnits(collectionId: string, ownerId: string): Promise<CollectionUnit[]> {
    const collection = await this.one(collectionId, ownerId);
    return [...builtInUnits, ...collection.units];
  }

  async saveUnit(collectionId: string, input: CollectionUnitInput, ownerId: string, unitId?: string): Promise<Collection> {
    const collection = await this.one(collectionId, ownerId);
    this.collaboration.checkAccess(collection, ownerId, CollectionRole.OWNER);
    if (!unitId && collection.units.length >= 100) throw new BadRequestException('A collection can have at most 100 local units');
    const current = unitId ? collection.units.find((unit) => unit.id === unitId) : undefined;
    if (unitId && !current) throw new NotFoundException('Local unit not found');
    if (current && input.expectedVersion !== current.version) throw new BadRequestException('Unit changed. Refresh and try again');
    const unit = this.normalizedUnit(input, current?.id ?? randomUUID(), current ? current.version + 1 : 1);
    const units = current ? collection.units.map((item) => item.id === current.id ? unit : item) : [...collection.units, unit];
    this.checkUnit(unit, units, collection.formats);
    for (const item of units) resolveUnit(item.id, units);
    const updated = current
      ? await this.collections.findOneAndUpdate({ _id: collectionId, units: { $elemMatch: { id: current.id, version: current.version } } }, { $set: { 'units.$': unit } }, { new: true, runValidators: true }).exec()
      : await this.collections.findOneAndUpdate({ _id: collectionId }, { $push: { units: unit } }, { new: true, runValidators: true }).exec();
    if (!updated) throw new BadRequestException('Unit changed. Refresh and try again');
    return updated;
  }

  async recordExchangeRate(collectionId: string, input: CollectionExchangeRateInput, ownerId: string): Promise<Collection> {
    const collection = await this.one(collectionId, ownerId);
    this.collaboration.checkAccess(collection, ownerId, CollectionRole.OWNER);
    if (collection.exchangeRates.length >= 1000) throw new BadRequestException('Too many exchange rates in this collection');
    const from = resolveUnit(input.from, collection.units);
    const to = resolveUnit(input.to, collection.units);
    if (from.dimension !== 'CURRENCY' || to.dimension !== 'CURRENCY' || input.from === input.to) throw new BadRequestException('Choose two different currencies');
    decimal(input.rate, true);
    const effectiveAt = new Date(input.effectiveAt);
    if (Number.isNaN(effectiveAt.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(input.effectiveAt)) throw new BadRequestException('Use a valid exchange rate date');
    const updated = await this.collections.findOneAndUpdate({ _id: collectionId }, { $push: { exchangeRates: { id: randomUUID(), from: input.from, to: input.to, rate: input.rate, effectiveAt } } }, { new: true, runValidators: true }).exec();
    if (!updated) throw new NotFoundException('Collection not found');
    return updated;
  }

  async convertQuantity(collectionId: string, amount: string, fromId: string, toId: string, ownerId: string, asOf?: string): Promise<QuantityConversion> {
    const collection = await this.one(collectionId, ownerId);
    const from = resolveUnit(fromId, collection.units);
    const to = resolveUnit(toId, collection.units);
    if (from.dimension !== to.dimension || (from.objectFormatId || to.objectFormatId) && from.objectFormatId !== to.objectFormatId) throw new BadRequestException('These units are not compatible');
    let value = decimal(amount);
    if (from.dimension === 'CURRENCY') {
      if (fromId === toId) return { value: fractionText(value), fromSymbol: from.unit.symbol, toSymbol: to.unit.symbol };
      const date = new Date(asOf ?? '');
      if (Number.isNaN(date.getTime())) throw new BadRequestException('Currency conversion needs a date');
      const direct = collection.exchangeRates.filter((rate) => rate.from === fromId && rate.to === toId && rate.effectiveAt <= date).sort((a, b) => b.effectiveAt.getTime() - a.effectiveAt.getTime())[0];
      const reverse = collection.exchangeRates.filter((rate) => rate.from === toId && rate.to === fromId && rate.effectiveAt <= date).sort((a, b) => b.effectiveAt.getTime() - a.effectiveAt.getTime())[0];
      const rate = direct && reverse ? (direct.effectiveAt >= reverse.effectiveAt ? direct : reverse) : direct ?? reverse;
      if (!rate) throw new BadRequestException('No exchange rate is available for this date');
      value = rate.from === fromId ? multiply(value, decimal(rate.rate, true)) : divide(value, decimal(rate.rate, true));
      return { value: fractionText(value), fromSymbol: from.unit.symbol, toSymbol: to.unit.symbol, rateDate: rate.effectiveAt };
    }
    if (from.dimension === 'TEMPERATURE') {
      if (fromId === '°F') value = divide({ n: (value.n - 32n * value.d) * 5n, d: value.d }, { n: 9n, d: 1n });
      if (toId === '°F') value = divide(multiply(value, { n: 9n, d: 1n }), { n: 5n, d: 1n });
      if (toId === '°F') value = { n: value.n + 32n * value.d, d: value.d };
    } else {
      if (from.root !== to.root) throw new BadRequestException('These units do not share a base unit');
      value = divide(multiply(value, from.factor), to.factor);
    }
    return { value: fractionText(value), fromSymbol: from.unit.symbol, toSymbol: to.unit.symbol };
  }

  private validateFields(input: (CollectionFieldInput | UpdateCollectionFieldInput)[], existingIds?: Set<string>): CollectionField[] {
    if (!input.length || input.length > 30) throw new BadRequestException('Choose between 1 and 30 fields');
    const names = new Set<string>();
    const ids = new Set<string>();
    const variableNames = new Set<string>();
    return input.map((field) => {
      const fieldName = field.name.trim();
      if (!fieldName || fieldName.length > 80) throw new BadRequestException('Field names must be 1 to 80 characters');
      const key = fieldName.toLocaleLowerCase();
      if (names.has(key)) throw new BadRequestException('Field names must be unique within a format');
      names.add(key);
      if (!Object.values(FieldKind).includes(field.kind)) throw new BadRequestException('Invalid field type');
      if (field.sensitivity && !validSensitivity(field.sensitivity)) throw new BadRequestException('Choose a sensitivity level');
      const unit = field.unit?.trim();
      if (unit && field.kind !== FieldKind.NUMBER && field.kind !== FieldKind.MEASURE) throw new BadRequestException('Only number and measure fields can have units');
      if (unit && ((unit.startsWith('local:') ? unit.length > 70 : unit.length > 24) || /[\x00-\x1f\x7f]/.test(unit))) {
        throw new BadRequestException('Unit must be at most 24 characters on one line');
      }
      const rawOptions = field.options ?? [];
      const choice = field.kind === FieldKind.SELECT || field.kind === FieldKind.MULTI_SELECT;
      if (!choice && rawOptions.length) throw new BadRequestException('Only choice fields can have options');
      const options = rawOptions.map((value) => value.trim());
      if (choice && (options.length < 2 || options.length > 30 || options.some((value) => !value || value.length > 80 || /[\x00-\x1f\x7f]/.test(value)) || new Set(options.map((value) => value.toLocaleLowerCase())).size !== options.length)) {
        throw new BadRequestException('Choice fields need 2 to 30 unique options');
      }
      const reference = field.kind === FieldKind.OBJECT_REF;
      const codeListId = field.codeListId?.trim();
      if (field.kind === FieldKind.CODE && !codeListId) throw new BadRequestException('Choose a code list in this collection');
      if (field.kind !== FieldKind.CODE && codeListId) throw new BadRequestException('Only code fields can use a code list');
      const targetObjectFormatId = field.targetObjectFormatId?.trim();
      const variableName = field.variableName?.trim();
      const referenceMode = field.referenceMode ?? 'SNAPSHOT';
      if (reference && (!targetObjectFormatId || !/^[a-f0-9-]{36}$/i.test(targetObjectFormatId))) throw new BadRequestException('Choose an object model in this collection');
      if (!reference && (targetObjectFormatId || field.multiple != null || variableName || field.referenceMode)) throw new BadRequestException('Only object reference fields can define an object variable');
      if (reference && (!['CURRENT', 'SNAPSHOT'].includes(referenceMode) || (variableName && !/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(variableName)))) throw new BadRequestException('Choose a valid reference mode and variable name');
      if (variableName) {
        if (variableNames.has(variableName.toLocaleLowerCase())) throw new BadRequestException('Object variable names must be unique within a data format');
        variableNames.add(variableName.toLocaleLowerCase());
      }
      const requestedId = 'id' in field ? field.id : undefined;
      if (requestedId && (!existingIds?.has(requestedId) || ids.has(requestedId))) throw new BadRequestException('Invalid or repeated field ID');
      const id = requestedId || randomUUID();
      ids.add(id);
      return { id, name: fieldName, kind: field.kind, sensitivity: field.sensitivity ?? ([FieldKind.POSITION, FieldKind.ZONE].includes(field.kind) ? SensitivityLevel.SENSITIVE : SensitivityLevel.ORDINARY), ...(unit ? { unit } : {}), ...(choice ? { options } : {}), ...(reference ? { targetObjectFormatId, multiple: field.multiple ?? false, variableName, referenceMode } : {}), ...(codeListId ? { codeListId } : {}) };
    });
  }

  private assertReferenceFields(formats: CollectionFormat[], grants: Collection['sharedObjects'] = []): void {
    for (const format of formats) for (const field of format.fields) {
      if (field.kind !== FieldKind.OBJECT_REF) continue;
      if (!formats.some((candidate) => candidate.id === field.targetObjectFormatId && candidate.objectModel) && !grants.some((grant) => grant.sourceFormatId === field.targetObjectFormatId && (grant.mode === 'CURRENT' || field.referenceMode === 'SNAPSHOT'))) {
        throw new BadRequestException('Object reference must target a local model or an explicitly linked object');
      }
    }
  }

  private assertCodeFields(formats: CollectionFormat[], lists: Collection['codeLists']): void {
    for (const format of formats) for (const field of format.fields) {
      if (field.kind === FieldKind.CODE && !lists.some((list) => list.id === field.codeListId)) throw new BadRequestException('Code field needs a list in this collection');
    }
  }

  private makeFormat(input: CollectionFormatInput): CollectionFormat {
    const name = input.name.trim();
    if (!name || name.length > 80) throw new BadRequestException('Data format name must be 1 to 80 characters');
    const color = this.validatedColor(input.color);
    const fields = this.validateFields(input.fields);
    if (input.sensitivity && !validSensitivity(input.sensitivity)) throw new BadRequestException('Choose a sensitivity level');
    if (input.objectModel && !fields.some((field) => field.kind === FieldKind.TITLE)) throw new BadRequestException('An object data format needs a title field');
    return { id: randomUUID(), name, color, fields, sensitivity: input.sensitivity ?? SensitivityLevel.ORDINARY, version: 1, objectModel: input.objectModel ?? false };
  }

  objectModelTemplates(language?: string): ObjectModelTemplate[] {
    if (language !== 'fr') return objectTemplates;
    return objectTemplates.map((template) => {
      const translated = frenchObjectTemplates[template.id];
      return { ...template, name: translated.name, description: translated.description, fields: template.fields.map((field, index) => ({ ...field, name: translated.fields[index] })) };
    });
  }

  async addObjectModelFromTemplate(collectionId: string, templateId: string, name: string, color: string, ownerId: string, language?: string): Promise<Collection> {
    const template = this.objectModelTemplates(language).find((item) => item.id === templateId);
    if (!template) throw new NotFoundException('Object template not found');
    return this.addFormat(collectionId, { name, color, objectModel: true, fields: template.fields.map(({ name: fieldName, kind, unit, options }) => ({ name: fieldName, kind, unit, options })) }, ownerId);
  }

  private validatedColor(value: string): string {
    const color = value.trim().toUpperCase();
    if (!formatColors.includes(color)) throw new BadRequestException('Choose a light data format color');
    return color;
  }

  async create(input: CreateCollectionInput, ownerId: string): Promise<Collection> {
    const name = input.name.trim();
    if (!name || name.length > 80) throw new BadRequestException('Collection name must be 1 to 80 characters');
    if (input.fields && input.formats) throw new BadRequestException('Use fields or formats, not both');
    const requested = input.formats ?? (input.fields ? [{ name: 'General', color: formatColors[0], fields: input.fields }] : []);
    if (!requested.length || requested.length > formatColors.length) {
      throw new BadRequestException(`Choose between 1 and ${formatColors.length} data formats`);
    }
    const names = new Set<string>();
    const colors = new Set<string>();
    const formats = requested.map((format) => {
      const result = this.makeFormat(format);
      const key = result.name.toLocaleLowerCase();
      if (names.has(key)) throw new BadRequestException('Data format names must be unique within a collection');
      if (colors.has(result.color)) throw new BadRequestException('Each data format needs a different color');
      names.add(key);
      colors.add(result.color);
      return result;
    });
    const units = (input.units ?? []).map((unit) => this.normalizedUnit(unit, unit.id ?? randomUUID(), 1));
    if (units.length > 100 || new Set(units.map((unit) => unit.id)).size !== units.length) throw new BadRequestException('Too many or repeated units');
    for (const unit of units) this.checkUnit(unit, units, formats);
    this.assertFieldUnits(formats, units);
    this.assertReferenceFields(formats);
    const codeLists = (input.codeLists ?? []).map((list) => ({ id: list.id || randomUUID(), name: list.name.trim(), version: 1, codes: validateClassificationCodes(list.codes.map((code) => ({ ...code, active: code.active !== false }))) }));
    if (codeLists.length > 100 || new Set(codeLists.map((list) => list.id)).size !== codeLists.length || new Set(codeLists.map((list) => list.name.toLocaleLowerCase())).size !== codeLists.length || codeLists.some((list) => !list.name || list.name.length > 80 || !/^[\w.-]{1,100}$/.test(list.id))) throw new BadRequestException('Invalid code lists');
    this.assertCodeFields(formats, codeLists);
    if ((input.exchangeRates?.length ?? 0) > 1000) throw new BadRequestException('Too many exchange rates in this collection');
    const exchangeRates = (input.exchangeRates ?? []).map((rate) => {
      const from = resolveUnit(rate.from, units);
      const to = resolveUnit(rate.to, units);
      if (from.dimension !== 'CURRENCY' || to.dimension !== 'CURRENCY' || rate.from === rate.to) throw new BadRequestException('Choose two different currencies');
      decimal(rate.rate, true);
      const effectiveAt = new Date(rate.effectiveAt);
      if (Number.isNaN(effectiveAt.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(rate.effectiveAt)) throw new BadRequestException('Use a valid exchange rate date');
      return { id: randomUUID(), from: rate.from, to: rate.to, rate: rate.rate, effectiveAt };
    });
    return this.collections.create({ name, fields: formats[0].fields, formats, codeLists, units, exchangeRates, ownerId });
  }

  async addFormat(id: string, input: CollectionFormatInput, ownerId: string): Promise<Collection> {
    const collection = await this.one(id, ownerId);
    this.collaboration.checkAccess(collection, ownerId, CollectionRole.OWNER);
    if (collection.formats.length >= formatColors.length) {
      throw new BadRequestException(`A collection can have at most ${formatColors.length} data formats`);
    }
    const format = this.makeFormat(input);
    this.assertFieldUnits([format], collection.units);
    this.assertReferenceFields([...collection.formats, format], collection.sharedObjects);
    this.assertCodeFields([...collection.formats, format], collection.codeLists ?? []);
    if (collection.formats.some((item) => item.name.toLocaleLowerCase() === format.name.toLocaleLowerCase())) {
      throw new BadRequestException('Data format names must be unique within a collection');
    }
    if (collection.formats.some((item) => item.color === format.color)) {
      throw new BadRequestException('Each data format needs a different color');
    }
    const updated = await this.collections.findOneAndUpdate(
      { _id: id }, { $push: { formats: format } }, { new: true, runValidators: true },
    ).exec();
    if (!updated) throw new NotFoundException('Collection not found');
    await this.collaboration.logAction(id, ownerId, 'UPDATE_FORMAT', `Added data format ${format.name}`);
    return updated;
  }

  async setFormatColor(id: string, formatId: string, value: string, ownerId: string): Promise<Collection> {
    const collection = await this.one(id, ownerId);
    this.collaboration.checkAccess(collection, ownerId, CollectionRole.OWNER);
    const color = this.validatedColor(value);
    if (!collection.formats.some((format) => format.id === formatId)) {
      throw new NotFoundException('Data format not found in this collection');
    }
    if (collection.formats.some((format) => format.id !== formatId && format.color === color)) {
      throw new BadRequestException('Each data format needs a different color');
    }
    const updated = await this.collections.findOneAndUpdate(
      { _id: id, 'formats.id': formatId },
      { $set: { 'formats.$.color': color } },
      { new: true, runValidators: true },
    ).exec();
    if (!updated) throw new NotFoundException('Data format not found in this collection');
    return updated;
  }

  async formatImpact(id: string, formatId: string, ownerId: string): Promise<CollectionFormatImpact> {
    const collection = await this.one(id, ownerId);
    if (!collection.formats.some((item) => item.id === formatId)) throw new NotFoundException('Data format not found in this collection');
    const query = { collectionId: id, ownerId, formatId };
    const [entryCount, populatedFieldIds] = await Promise.all([
      this.entries.countDocuments(query).exec(),
      this.entries.distinct('values.fieldId', query).exec(),
    ]);
    return { entryCount, populatedFieldIds: populatedFieldIds as string[] };
  }

  async updateFormat(id: string, formatId: string, input: UpdateCollectionFormatInput, ownerId: string): Promise<Collection> {
    const collection = await this.one(id, ownerId);
    this.collaboration.checkAccess(collection, ownerId, CollectionRole.OWNER);
    const current = collection.formats.find((item) => item.id === formatId);
    if (!current) throw new NotFoundException('Data format not found in this collection');
    const version = current.version ?? 1;
    if (input.expectedVersion !== version) throw new BadRequestException('Data format changed. Refresh and try again');
    const name = input.name.trim();
    if (!name || name.length > 80) throw new BadRequestException('Data format name must be 1 to 80 characters');
    if (collection.formats.some((item) => item.id !== formatId && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new BadRequestException('Data format names must be unique within a collection');
    }
    const fields = this.validateFields(input.fields, new Set(current.fields.map((field) => field.id)));
    for (const field of fields) {
      const previous = current.fields.find((item) => item.id === field.id);
      const requested = input.fields.find((item) => item.id === field.id);
      if (previous && requested?.sensitivity === undefined) field.sensitivity = previous.sensitivity ?? SensitivityLevel.ORDINARY;
    }
    if (current.workflow) {
      const before = current.fields.find((field) => field.id === current.workflow!.stateFieldId);
      const after = fields.find((field) => field.id === current.workflow!.stateFieldId);
      if (!after || after.kind !== FieldKind.SELECT || JSON.stringify(after.options ?? []) !== JSON.stringify(before?.options ?? []) || current.workflow.requirements.some((item) => item.fieldIds.some((id) => !fields.some((field) => field.id === id)))) {
        throw new BadRequestException('Keep the workflow state field and its choices while the workflow is enabled');
      }
    }
    if (current.objectModel && !fields.some((field) => field.kind === FieldKind.TITLE)) throw new BadRequestException('An object data format needs a title field');
    this.assertFieldUnits([{ ...current, fields }], collection.units);
    this.assertReferenceFields(collection.formats.map((item) => item.id === formatId ? { ...item, fields } : item), collection.sharedObjects);
    this.assertCodeFields(collection.formats.map((item) => item.id === formatId ? { ...item, fields } : item), collection.codeLists ?? []);
    const next = new Map(fields.map((field) => [field.id, field]));
    for (const field of current.fields) {
      if (!(collection.formulas ?? []).some((formula) => formula.expression.includes(`"${field.id}"`))) continue;
      const replacement = next.get(field.id);
      if (!replacement || replacement.kind !== field.kind || (replacement.unit ?? '') !== (field.unit ?? '') || (replacement.targetObjectFormatId ?? '') !== (field.targetObjectFormatId ?? '') || (replacement.multiple ?? false) !== (field.multiple ?? false)) {
        throw new BadRequestException(`Field ${field.name} is used by a formula. Keep its type and unit or remove the formula first`);
      }
    }
    for (const rule of collection.stockRules ?? []) {
      if (rule.formatId !== formatId) continue;
      for (const fieldId of [rule.productFieldId, rule.quantityFieldId, rule.dateFieldId, rule.priceFieldId, rule.reasonFieldId, rule.fromLocationFieldId, rule.toLocationFieldId, rule.lotFieldId]) {
        if (!fieldId) continue;
        const previous = current.fields.find((field) => field.id === fieldId);
        const replacement = next.get(fieldId);
        if (!previous || !replacement || replacement.kind !== previous.kind || (replacement.unit ?? '') !== (previous.unit ?? '') || (replacement.targetObjectFormatId ?? '') !== (previous.targetObjectFormatId ?? '')) throw new BadRequestException(`Field ${previous?.name ?? fieldId} is used by a stock rule. Remove the rule first`);
      }
    }
    if (current.objectModel) {
      const targets = await this.collections.find({ ownerId, 'sharedObjects.sourceCollectionId': id, 'sharedObjects.sourceFormatId': formatId }).exec();
      for (const target of targets) for (const grant of target.sharedObjects ?? []) {
        if (grant.sourceCollectionId !== id || grant.sourceFormatId !== formatId || grant.revokedAt) continue;
        for (const sharedId of grant.propertyFieldIds) {
          const previous = current.fields.find((field) => field.id === sharedId);
          const replacement = next.get(sharedId);
          if (!previous || !replacement || previous.kind !== replacement.kind || previous.unit !== replacement.unit) throw new BadRequestException('A shared object uses this property. Revoke the link before changing its type, unit or removing it');
        }
      }
    }
    const impact = await this.formatImpact(id, formatId, ownerId);
    for (const field of current.fields) {
      const replacement = next.get(field.id);
      const isNumberToMeasure = field.kind === FieldKind.NUMBER && replacement?.kind === FieldKind.MEASURE;
      const isAllowedKind = replacement && (replacement.kind === field.kind || isNumberToMeasure);
      if (impact.populatedFieldIds.includes(field.id) && (!isAllowedKind || (replacement.unit ?? '') !== (field.unit ?? '') || (replacement.targetObjectFormatId ?? '') !== (field.targetObjectFormatId ?? '') || (replacement.codeListId ?? '') !== (field.codeListId ?? '') || (replacement.multiple ?? false) !== (field.multiple ?? false) || (replacement.referenceMode ?? '') !== (field.referenceMode ?? '') || (field.options ?? []).some((option) => !replacement.options?.includes(option)))) {
        throw new BadRequestException(`Field ${field.name} has saved values. Keep its type, unit and existing choices, or migrate entries first`);
      }
    }
    const filter = { _id: id, formats: { $elemMatch: { id: formatId, version: version === 1 ? { $in: [null, 1] } : version } } };
    const changes: Record<string, unknown> = { 'formats.$.name': name, 'formats.$.fields': fields, 'formats.$.version': version + 1 };
    if (collection.formats[0].id === formatId) changes.fields = fields;
    const updated = await this.collections.findOneAndUpdate(
      filter,
      { $set: changes },
      { new: true, runValidators: true },
    ).exec();
    if (!updated) throw new BadRequestException('Data format changed. Refresh and try again');
    await this.collaboration.logAction(id, ownerId, 'UPDATE_FORMAT', `Updated data format ${name}`);
    return updated;
  }

  async rename(id: string, name: string, ownerId: string): Promise<Collection> {
    this.validId(id);
    const collection = await this.one(id, ownerId);
    this.collaboration.checkAccess(collection, ownerId, CollectionRole.OWNER);
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 80) throw new BadRequestException('Collection name must be 1 to 80 characters');
    const updated = await this.collections.findOneAndUpdate(
      { _id: id }, { $set: { name: trimmed } }, { new: true, runValidators: true },
    ).exec();
    if (!updated) throw new NotFoundException('Collection not found');
    return this.ensureFormats(updated);
  }

  async setObjectModel(collectionId: string, formatId: string, enabled: boolean, expectedVersion: number, ownerId: string, expectedEntryCount?: number): Promise<Collection> {
    const collection = await this.one(collectionId, ownerId);
    this.collaboration.checkAccess(collection, ownerId, CollectionRole.OWNER);
    const format = collection.formats.find((item) => item.id === formatId);
    if (format?.appendOnly) throw new BadRequestException('A register cannot become an object model');
    if (!format) throw new NotFoundException('Data format not found');
    if ((format.version ?? 1) !== expectedVersion) throw new BadRequestException('Data format changed. Refresh and try again');
    const title = format.fields.find((field) => field.kind === FieldKind.TITLE);
    if (enabled && !title) throw new BadRequestException('An object data format needs a title field');
    const entryCount = await this.entries.countDocuments({ collectionId, formatId }).exec();
    if (enabled && entryCount > 0) {
      if (await this.entries.exists({ collectionId, formatId, contributionLinkId: { $exists: true } })) throw new BadRequestException('Delete public contributions before converting this data format to objects');
      const unnamedCount = await this.entries.countDocuments({ collectionId, formatId, values: { $not: { $elemMatch: { fieldId: title!.id, value: { $type: 'string', $regex: '\\S' } } } } }).exec();
      if (unnamedCount > 0) throw new BadRequestException('Existing entries need titles before becoming objects');
      if (expectedEntryCount !== entryCount) throw new BadRequestException('Review existing entries before converting them to objects');
    }
    if (!enabled && entryCount > 0) throw new BadRequestException('Move or delete objects before disabling this object model');
    if (!enabled && collection.formats.some((item) => item.fields.some((field) => field.kind === FieldKind.OBJECT_REF && field.targetObjectFormatId === formatId))) {
      throw new BadRequestException('This object model is used by an object reference field');
    }
    const updated = await this.collections.findOneAndUpdate({ _id: collectionId, formats: { $elemMatch: { id: formatId, version: expectedVersion === 1 ? { $in: [null, 1] } : expectedVersion } } }, { $set: { 'formats.$.objectModel': enabled, 'formats.$.version': expectedVersion + 1 } }, { new: true, runValidators: true }).exec();
    if (!updated) throw new BadRequestException('Data format changed. Refresh and try again');
    return updated;
  }

  async remove(id: string, ownerId: string): Promise<boolean> {
    const collection = await this.one(id, ownerId);
    this.collaboration.checkAccess(collection, ownerId, CollectionRole.OWNER);
    if (collection.formats.some((item) => item.appendOnly)) throw new BadRequestException('A collection with a register cannot be deleted until the retention policy is defined');
    if (await this.collections.exists({ ownerId: collection.ownerId, sharedObjects: { $elemMatch: { sourceCollectionId: id, revokedAt: null } } })) throw new BadRequestException('Revoke object links before deleting this collection');
    if (await this.collections.exists({ ownerId: collection.ownerId, 'formats.linkedSource.sourceCollectionId': id })) throw new BadRequestException('Detach linked data formats before deleting this collection');
    await this.entries.deleteMany({ collectionId: id }).exec();
    await this.contributionSubmissions.deleteMany({ collectionId: id }).exec();
    await this.contributionLinks.deleteMany({ collectionId: id }).exec();
    await this.stockMovements.deleteMany({ collectionId: id }).exec();
    await this.stockLedgerHeads.deleteMany({ collectionId: id }).exec();
    await this.collections.deleteOne({ _id: id }).exec();
    return true;
  }

  async listEntries(collectionId: string, ownerId: string): Promise<Entry[]> {
    const collection = await this.one(collectionId, ownerId);
    const access = this.collaboration.checkAccess(collection, ownerId, CollectionRole.READER);
    const entries = await this.entries.find({ ownerId: collection.ownerId, collectionId }).sort({ createdAt: -1 }).exec();
    const visible = entries.map((entry) => this.collaboration.filterEntryFields(entry, access.member, collection));
    await this.collaboration.auditProtectedRead(collection, ownerId, visible);
    return visible;
  }

  async entryDetail(collectionId: string, entryId: string, ownerId: string): Promise<Entry> {
    const collection = await this.one(collectionId, ownerId);
    const access = this.collaboration.checkAccess(collection, ownerId, CollectionRole.READER);
    const entry = await this.entries.findOne({ _id: entryId, ownerId: collection.ownerId, collectionId }).exec();
    if (!entry) throw new NotFoundException('Entry not found');
    const visible = this.collaboration.filterEntryFields(entry, access.member, collection);
    await this.collaboration.auditProtectedRead(collection, ownerId, [visible]);
    return visible;
  }

  async saveView(collectionId: string, ownerId: string, input: SavedCollectionViewInput, viewId?: string): Promise<Collection> {
    const collection = await this.one(collectionId, ownerId);
    this.collaboration.checkAccess(collection, ownerId, CollectionRole.EDITOR);
    const name = input.name.trim();
    if (!name || name.length > 80) throw new BadRequestException('View name must be 1 to 80 characters');
    if (!['LIST', 'TABLE', 'CARDS', 'TASKS', 'CALENDAR'].includes(input.layout)) throw new BadRequestException('Invalid view layout');
    if (!['NEWEST', 'OLDEST', 'MANUAL'].includes(input.sort)) throw new BadRequestException('Invalid view sort');
    if ((input.search?.length ?? 0) > 200) throw new BadRequestException('View search is too long');
    const formatIds = [...new Set(input.formatIds)];
    if (!formatIds.length || formatIds.length > 24 || formatIds.some((id) => !collection.formats.some((format) => format.id === id))) throw new BadRequestException('Choose data formats from this collection');
    const fields = collection.formats.filter((format) => formatIds.includes(format.id)).flatMap((format) => format.fields);
    const manualOrderFieldIds = input.sort === 'MANUAL' ? [...new Set(input.manualOrderFieldIds ?? [])] : [];
    if (input.sort === 'MANUAL' && (['TASKS', 'CALENDAR'].includes(input.layout) || manualOrderFieldIds.length !== formatIds.length || formatIds.some((formatId) => !collection.formats.find((format) => format.id === formatId)?.fields.some((field) => field.kind === FieldKind.NUMBER && manualOrderFieldIds.includes(field.id))))) throw new BadRequestException('Choose one numeric order field for each selected data format');
    const fieldOf = (id: string | undefined, kinds: FieldKind[], label: string, required = false) => {
      if (!id) { if (required) throw new BadRequestException(`Choose a ${label} field`); return; }
      if (!fields.some((field) => field.id === id && kinds.includes(field.kind))) throw new BadRequestException(`Choose a compatible ${label} field`);
    };
    if (input.layout === 'TASKS') {
      if (formatIds.length !== 1) throw new BadRequestException('A task view needs one data format');
      fieldOf(input.taskDoneFieldId, [FieldKind.BOOLEAN], 'task completion', true);
      fieldOf(input.taskDueFieldId, [FieldKind.DATE, FieldKind.DATETIME], 'task due date');
      fieldOf(input.taskCompletedFieldId, [FieldKind.DATETIME], 'completion date');
      fieldOf(input.taskPriorityFieldId, [FieldKind.SELECT, FieldKind.NUMBER], 'priority');
    }
    if (input.layout === 'CALENDAR') {
      if (formatIds.length !== 1) throw new BadRequestException('A calendar view needs one data format');
      fieldOf(input.calendarStartFieldId, [FieldKind.DATETIME], 'calendar start', true);
      fieldOf(input.calendarEndFieldId, [FieldKind.DATETIME], 'calendar end', true);
      try { new Intl.DateTimeFormat('en', { timeZone: input.calendarTimeZone ?? '' }); }
      catch { throw new BadRequestException('Choose a valid IANA time zone'); }
      if (!input.calendarTimeZone) throw new BadRequestException('Choose a calendar time zone');
    }
    const columnFieldIds = [...new Set(input.columnFieldIds)];
    if (columnFieldIds.length > 30 || columnFieldIds.some((id) => !fields.some((field) => field.id === id))) throw new BadRequestException('Choose columns from selected data formats');
    if (input.filterFieldId) {
      const field = fields.find((item) => item.id === input.filterFieldId);
      if (!field || formatIds.length !== 1) throw new BadRequestException('A field filter needs one data format');
      if (!input.filterOperator || !input.filterValue) throw new BadRequestException('Complete the view filter');
      this.entryFilterCondition(field, { fieldId: field.id, operator: input.filterOperator as EntryFilterOperator, value: input.filterValue });
    } else if (input.filterOperator || input.filterValue) throw new BadRequestException('Choose a filter field');
    const existing = viewId ? collection.savedViews.find((view) => view.id === viewId) : undefined;
    if (viewId && !existing) throw new NotFoundException('View not found');
    if (!viewId && collection.savedViews.length >= 30) throw new BadRequestException('This collection has 30 saved views');
    const view: SavedCollectionView = { id: viewId ?? randomUUID(), name, layout: input.layout, formatIds, columnFieldIds, search: input.search?.trim() ?? '', filterFieldId: input.filterFieldId, filterOperator: input.filterOperator, filterValue: input.filterValue?.trim(), sort: input.sort, manualOrderFieldIds, groupByFormat: input.groupByFormat, taskDoneFieldId: input.layout === 'TASKS' ? input.taskDoneFieldId : undefined, taskDueFieldId: input.layout === 'TASKS' ? input.taskDueFieldId : undefined, taskCompletedFieldId: input.layout === 'TASKS' ? input.taskCompletedFieldId : undefined, taskPriorityFieldId: input.layout === 'TASKS' ? input.taskPriorityFieldId : undefined, calendarStartFieldId: input.layout === 'CALENDAR' ? input.calendarStartFieldId : undefined, calendarEndFieldId: input.layout === 'CALENDAR' ? input.calendarEndFieldId : undefined, calendarTimeZone: input.layout === 'CALENDAR' ? input.calendarTimeZone : undefined };
    const savedViews = viewId ? collection.savedViews.map((item) => item.id === viewId ? view : item) : [...collection.savedViews, view];
    const updated = await this.collections.findOneAndUpdate({ _id: collectionId }, { $set: { savedViews } }, { new: true, runValidators: true }).exec();
    if (!updated) throw new NotFoundException('Collection not found');
    return updated;
  }

  async deleteView(collectionId: string, ownerId: string, viewId: string): Promise<Collection> {
    const collection = await this.one(collectionId, ownerId);
    this.collaboration.checkAccess(collection, ownerId, CollectionRole.EDITOR);
    if (!collection.savedViews.some((item) => item.id === viewId)) throw new NotFoundException('View not found');
    const updated = await this.collections.findOneAndUpdate({ _id: collectionId }, { $pull: { savedViews: { id: viewId } } }, { new: true }).exec();
    if (!updated) throw new NotFoundException('Collection not found');
    return updated;
  }

  async setTaskCompletion(collectionId: string, ownerId: string, viewId: string, entryId: string, done: boolean): Promise<Entry> {
    this.validId(entryId);
    const collection = await this.one(collectionId, ownerId);
    this.collaboration.checkAccess(collection, ownerId, CollectionRole.EDITOR);
    const view = collection.savedViews.find((item) => item.id === viewId && item.layout === 'TASKS');
    if (!view?.taskDoneFieldId) throw new NotFoundException('Task view not found');
    const entry = await this.entries.findOne({ _id: entryId, collectionId, formatId: view.formatIds[0], movingOperationId: null }).exec();
    if (!entry) throw new NotFoundException('Task not found');
    if (entry.ledgerHash || collection.formats.find((item) => item.id === entry.formatId)?.appendOnly) throw new BadRequestException('A register writing cannot be edited');
    const values = entry.values.filter((item) => item.fieldId !== view.taskDoneFieldId && item.fieldId !== view.taskCompletedFieldId);
    values.push({ fieldId: view.taskDoneFieldId, value: done ? 'true' : 'false', booleanValue: done });
    if (done && view.taskCompletedFieldId) {
      const now = new Date().toISOString();
      values.push({ fieldId: view.taskCompletedFieldId, value: now, dateTimeValue: now });
    }
    const updated = await this.entries.findOneAndUpdate({ _id: entryId, collectionId, updatedAt: entry.updatedAt, movingOperationId: null }, { $set: { values }, $push: { revisions: { $each: [{ at: entry.updatedAt, formatVersion: entry.formatVersion ?? 1, values: entry.values }], $slice: -20 } } }, { new: true, runValidators: true }).exec();
    if (!updated) throw new BadRequestException('Task changed. Refresh and try again');
    await this.collaboration.logAction(collection.id, ownerId, 'UPDATE_ENTRY', `Updated task completion in entry ${entryId}`);
    return updated;
  }

  async setEntryRecurrence(collectionId: string, ownerId: string, viewId: string, entryId: string, input?: EntryRecurrenceInput): Promise<Entry> {
    this.validId(entryId);
    const collection = await this.one(collectionId, ownerId);
    this.collaboration.checkAccess(collection, ownerId, CollectionRole.EDITOR);
    const view = collection.savedViews.find((item) => item.id === viewId && item.layout === 'CALENDAR');
    if (!view?.calendarStartFieldId || !view.calendarEndFieldId) throw new NotFoundException('Calendar view not found');
    const entry = await this.entries.findOne({ _id: entryId, collectionId, formatId: view.formatIds[0], movingOperationId: null }).exec();
    if (!entry) throw new NotFoundException('Event not found');
    if (entry.ledgerHash || collection.formats.find((item) => item.id === entry.formatId)?.appendOnly) throw new BadRequestException('A register writing cannot be edited');
    if (!input) {
      const updated = await this.entries.findOneAndUpdate({ _id: entryId, collectionId, updatedAt: entry.updatedAt }, { $unset: { recurrence: '' } }, { new: true }).exec();
      if (!updated) throw new BadRequestException('Event changed. Refresh and try again');
      await this.collaboration.logAction(collection.id, ownerId, 'UPDATE_ENTRY', `Removed event recurrence in entry ${entryId}`);
      return updated;
    }
    if (!validTimeZone(input.timeZone) || input.timeZone.length > 100) throw new BadRequestException('Choose a valid IANA time zone');
    if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(input.frequency) || !Number.isInteger(input.interval) || input.interval < 1 || input.interval > 30) throw new BadRequestException('Choose a recurrence frequency and interval');
    const start = new Date(entry.values.find((item) => item.fieldId === view.calendarStartFieldId)?.value ?? '');
    const end = new Date(entry.values.find((item) => item.fieldId === view.calendarEndFieldId)?.value ?? '');
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start || end.getTime() - start.getTime() > 14 * 86_400_000) throw new BadRequestException('A recurring event needs a start and end within 14 days');
    const startDate = localDate(localTime(start, input.timeZone));
    const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    if (input.untilDate && (!validDate(input.untilDate) || input.untilDate < startDate)) throw new BadRequestException('Recurrence end must follow the first event');
    if (input.excludedDates.length > 500 || input.excludedDates.some((date) => !validDate(date) || date < startDate)) throw new BadRequestException('Invalid recurrence exception date');
    const recurrence = { startFieldId: view.calendarStartFieldId, endFieldId: view.calendarEndFieldId, timeZone: input.timeZone, frequency: input.frequency, interval: input.interval, untilDate: input.untilDate, excludedDates: [...new Set(input.excludedDates)] };
    const updated = await this.entries.findOneAndUpdate({ _id: entryId, collectionId, updatedAt: entry.updatedAt }, { $set: { recurrence } }, { new: true, runValidators: true }).exec();
    if (!updated) throw new BadRequestException('Event changed. Refresh and try again');
    await this.collaboration.logAction(collection.id, ownerId, 'UPDATE_ENTRY', `Updated event recurrence in entry ${entryId}`);
    return updated;
  }

  async calendarOccurrences(collectionId: string, ownerId: string, viewId: string, fromText: string, toText: string): Promise<CalendarOccurrence[]> {
    const collection = await this.one(collectionId, ownerId);
    const access = this.collaboration.checkAccess(collection, ownerId, CollectionRole.READER);
    const view = collection.savedViews.find((item) => item.id === viewId && item.layout === 'CALENDAR');
    if (!view?.calendarStartFieldId || !view.calendarEndFieldId || !view.calendarTimeZone) throw new NotFoundException('Calendar view not found');
    const from = new Date(fromText), to = new Date(toText);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from || to.getTime() - from.getTime() > 45 * 86_400_000) throw new BadRequestException('Choose a calendar range of at most 45 days');
    const rawEntries = await this.entries.find({ ownerId: collection.ownerId, collectionId, formatId: view.formatIds[0] }).limit(10_001).exec();
    if (rawEntries.length > 10_000) throw new BadRequestException('Calendar has too many events for this view');
    const entries = rawEntries.map((e) => this.collaboration.filterEntryFields(e, access.member, collection));
    await this.collaboration.auditProtectedRead(collection, ownerId, entries);
    const result: CalendarOccurrence[] = [];
    const clock = (date: Date, zone: string) => { const local = localTime(date, zone); return `${local.hour.toString().padStart(2, '0')}:${local.minute.toString().padStart(2, '0')}`; };
    for (const entry of entries) {
      const start = new Date(entry.values.find((item) => item.fieldId === view.calendarStartFieldId)?.value ?? '');
      const end = new Date(entry.values.find((item) => item.fieldId === view.calendarEndFieldId)?.value ?? '');
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) continue;
      const recurrence = entry.recurrence;
      const zone = recurrence?.timeZone ?? view.calendarTimeZone;
      if (!recurrence || recurrence.startFieldId !== view.calendarStartFieldId || recurrence.endFieldId !== view.calendarEndFieldId) {
        if (start < to && end > from) result.push({ entry, startAt: start.toISOString(), endAt: end.toISOString(), timeZone: zone, recurring: false, localDate: localDate(localTime(start, zone)), localStartClock: clock(start, zone), localEndClock: clock(end, zone) });
        continue;
      }
      const base = localTime(start, zone), baseEnd = localTime(end, zone);
      const endDayOffset = Math.round((Date.UTC(baseEnd.year, baseEnd.month - 1, baseEnd.day) - Date.UTC(base.year, base.month - 1, base.day)) / 86_400_000);
      const fromLocal = localTime(new Date(from.getTime() - 14 * 86_400_000), zone);
      const dayDifference = Math.floor((Date.UTC(fromLocal.year, fromLocal.month - 1, fromLocal.day) - Date.UTC(base.year, base.month - 1, base.day)) / 86_400_000);
      const monthDifference = (fromLocal.year - base.year) * 12 + fromLocal.month - base.month;
      const firstIndex = recurrence.frequency === 'MONTHLY' ? Math.max(0, Math.floor(monthDifference / recurrence.interval) - 1) : Math.max(0, Math.floor(dayDifference / (recurrence.interval * (recurrence.frequency === 'WEEKLY' ? 7 : 1))) - 1);
      for (let index = firstIndex; index < firstIndex + 500; index++) {
        const candidate = recurrence.frequency === 'MONTHLY' ? addLocalMonths(base, index * recurrence.interval) : addLocalDays(base, index * recurrence.interval * (recurrence.frequency === 'WEEKLY' ? 7 : 1));
        if (!candidate) continue; // A monthly event on the 31st skips shorter months.
        const date = localDate(candidate);
        if (recurrence.untilDate && date > recurrence.untilDate) break;
        const occurrenceStart = localToInstant(candidate, zone);
        if (occurrenceStart >= to) break;
        if (recurrence.excludedDates.includes(date)) continue;
        const endDate = addLocalDays(candidate, endDayOffset);
        const occurrenceEnd = localToInstant({ ...endDate, hour: baseEnd.hour, minute: baseEnd.minute, second: baseEnd.second }, zone);
        if (occurrenceEnd > from && occurrenceStart < to) result.push({ entry, startAt: occurrenceStart.toISOString(), endAt: occurrenceEnd.toISOString(), timeZone: zone, recurring: true, localDate: date, localStartClock: clock(occurrenceStart, zone), localEndClock: clock(occurrenceEnd, zone) });
        if (result.length > 500) throw new BadRequestException('Calendar range contains too many occurrences');
      }
    }
    return result.sort((a, b) => a.startAt.localeCompare(b.startAt) || a.entry.id.localeCompare(b.entry.id));
  }

  async entriesPage(
    collectionId: string,
    ownerId: string,
    input: { first: number; after?: string; search?: string; formatId?: string; filters?: EntryFieldFilterInput[]; viewId?: string },
  ): Promise<EntryPage> {
    const collection = await this.one(collectionId, ownerId);
    const access = this.collaboration.checkAccess(collection, ownerId, CollectionRole.READER);
    const view = input.viewId ? collection.savedViews.find((item) => item.id === input.viewId) : undefined;
    if (input.viewId && !view) throw new NotFoundException('View not found');
    if (view) input = { ...input, search: view.search, formatId: view.formatIds.length === 1 ? view.formatIds[0] : undefined, filters: view.filterFieldId && view.filterOperator && view.filterValue ? [{ fieldId: view.filterFieldId, operator: view.filterOperator as EntryFilterOperator, value: view.filterValue }] : undefined };
    if (!Number.isInteger(input.first) || input.first < 1 || input.first > 100) throw new BadRequestException('Page size must be between 1 and 100');
    const search = input.search?.trim() ?? '';
    if (search.length > 200) throw new BadRequestException('Search is too long');
    if (access.member && search && collection.formats.some((item) => [...protectedFields(item)].some((id) => !access.member!.sensitiveFieldIds?.includes(id)))) throw new BadRequestException('Search is unavailable while protected fields are hidden');
    if ((input.filters?.length ?? 0) > 8) throw new BadRequestException('Choose at most 8 filters');
    let format = input.formatId ? collection.formats.find((item) => item.id === input.formatId) : undefined;
    if (input.formatId && !format) throw new BadRequestException('Data format not found in this collection');
    const conditions: Record<string, unknown>[] = [];
    for (const filter of input.filters ?? []) {
      const matching = collection.formats.find((item) => item.fields.some((field) => field.id === filter.fieldId));
      if (!matching || (format && matching.id !== format.id)) throw new BadRequestException('Filter field does not belong to this data format');
      format = matching;
      const field = matching.fields.find((item) => item.id === filter.fieldId)!;
      if (access.member && ((access.member.sharedFieldIds?.length && !access.member.sharedFieldIds.includes(field.id)) || (protectedFields(matching).has(field.id) && !access.member.sensitiveFieldIds?.includes(field.id)))) throw new BadRequestException('This field is not shared for filtering');
      conditions.push(this.entryFilterCondition(field, filter));
    }
    if (input.after && view?.sort !== 'MANUAL') {
      let cursor: { createdAt?: string; id?: string };
      try { cursor = JSON.parse(Buffer.from(input.after, 'base64url').toString('utf8')) as typeof cursor; }
      catch { throw new BadRequestException('Invalid page cursor'); }
      const date = new Date(cursor.createdAt ?? '');
      if (input.after.length > 500 || !cursor.createdAt || !cursor.id || !Types.ObjectId.isValid(cursor.id) || Number.isNaN(date.getTime()) || date.toISOString() !== cursor.createdAt) {
        throw new BadRequestException('Invalid page cursor');
      }
      const direction = view?.sort === 'OLDEST' ? '$gt' : '$lt';
      conditions.push({ $or: [{ createdAt: { [direction]: date } }, { createdAt: date, _id: { [direction]: new Types.ObjectId(cursor.id) } }] });
    }
    const query: Record<string, unknown> = { ownerId: collection.ownerId, collectionId };
    if (format) query.formatId = format.id;
    else if (view) query.formatId = { $in: view.formatIds };
    if (search) query.$text = { $search: search };
    if (conditions.length) query.$and = conditions;
    if (view?.sort === 'MANUAL') {
      if (access.member && (view.manualOrderFieldIds ?? []).some((id) => collection.formats.some((item) => protectedFields(item).has(id) && !access.member!.sensitiveFieldIds?.includes(id)))) throw new BadRequestException('This view sorts by a protected field');
      const all = await this.entries.find(query as QueryFilter<Entry>).limit(10001).exec();
      if (all.length > 10000) throw new BadRequestException('Manual order currently supports at most 10000 entries');
      const orderFields = new Map(view.formatIds.map((formatId) => [formatId, collection.formats.find((item) => item.id === formatId)?.fields.find((field) => view.manualOrderFieldIds?.includes(field.id))?.id]));
      const orderOf = (entry: Entry) => {
        const value = entry.values.find((item) => item.fieldId === orderFields.get(entry.formatId!));
        return value ? decimal(value.numberValue ?? value.value) : undefined;
      };
      all.sort((a, b) => {
        const left = orderOf(a), right = orderOf(b);
        if (!left || !right) return left ? -1 : right ? 1 : a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
        const difference = left.n * right.d - right.n * left.d;
        return difference < 0n ? -1 : difference > 0n ? 1 : a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
      });
      let start = 0;
      if (input.after) {
        let cursor: { manual?: boolean; id?: string };
        try { cursor = JSON.parse(Buffer.from(input.after, 'base64url').toString('utf8')) as typeof cursor; }
        catch { throw new BadRequestException('Invalid page cursor'); }
        if (input.after.length > 500 || cursor.manual !== true || !cursor.id || !Types.ObjectId.isValid(cursor.id)) throw new BadRequestException('Invalid page cursor');
        start = all.findIndex((entry) => entry.id === cursor.id) + 1;
        if (!start) throw new BadRequestException('Manual order changed. Reload this view');
      }
      const rawEntries = all.slice(start, start + input.first);
      const entries = rawEntries.map((e) => this.collaboration.filterEntryFields(e, access.member, collection));
      await this.collaboration.auditProtectedRead(collection, ownerId, entries);
      const last = rawEntries.at(-1);
      const hasMore = start + rawEntries.length < all.length;
      return { entries, hasMore, nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ manual: true, id: last.id })).toString('base64url') : undefined };
    }
    const sortDirection = view?.sort === 'OLDEST' ? 1 : -1;
    const found = await this.entries.find(query as QueryFilter<Entry>).sort({ createdAt: sortDirection, _id: sortDirection }).limit(input.first + 1).exec();
    const hasMore = found.length > input.first;
    const rawEntries = found.slice(0, input.first);
    const entries = rawEntries.map((e) => this.collaboration.filterEntryFields(e, access.member, collection));
    await this.collaboration.auditProtectedRead(collection, ownerId, entries);
    const last = rawEntries.at(-1);
    return { entries, hasMore, nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ createdAt: last.createdAt.toISOString(), id: last.id })).toString('base64url') : undefined };
  }

  private entryFilterCondition(field: CollectionField, filter: EntryFieldFilterInput): Record<string, unknown> {
    const value = filter.value.trim();
    if (!value || value.length > 200) throw new BadRequestException(`${field.name} needs a filter value`);
    const operator = filter.operator;
    const comparison = { [EntryFilterOperator.EQ]: '$eq', [EntryFilterOperator.GT]: '$gt', [EntryFilterOperator.GTE]: '$gte', [EntryFilterOperator.LT]: '$lt', [EntryFilterOperator.LTE]: '$lte' } as const;
    if (operator === EntryFilterOperator.CONTAINS) {
      if (![FieldKind.TITLE, FieldKind.TEXT, FieldKind.LONG_TEXT, FieldKind.LINK, FieldKind.CHARACTER, FieldKind.ATTACHMENT].includes(field.kind)) throw new BadRequestException(`${field.name} cannot use contains`);
      return { values: { $elemMatch: { fieldId: field.id, value: { $regex: value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } } } };
    }
    if (!comparison[operator]) throw new BadRequestException('Invalid filter operator');
    if (field.kind === FieldKind.NUMBER || field.kind === FieldKind.DURATION) {
      if (field.kind === FieldKind.NUMBER && (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value)))) throw new BadRequestException(`${field.name} must be a number`);
      if (field.kind === FieldKind.DURATION && !/^\d{1,6}:[0-5]\d$/.test(value)) throw new BadRequestException(`${field.name} needs a duration as hours:minutes`);
      const expected = field.kind === FieldKind.NUMBER ? Types.Decimal128.fromString(value) : (Number(value.split(':')[0]) * 60 + Number(value.split(':')[1])) * 60;
      const stored = field.kind === FieldKind.NUMBER
        ? { $convert: { input: { $ifNull: ['$$item.numberValue', '$$item.value'] }, to: 'decimal', onError: null, onNull: null } }
        : { $ifNull: ['$$item.durationSeconds', null] };
      return { $expr: { $anyElementTrue: { $map: { input: '$values', as: 'item', in: { $and: [{ $eq: ['$$item.fieldId', field.id] }, { [comparison[operator]]: [stored, expected] }] } } } } };
    }
    if (field.kind === FieldKind.BOOLEAN && (operator !== EntryFilterOperator.EQ || !['true', 'false'].includes(value))) throw new BadRequestException(`${field.name} must be yes or no`);
    if ([FieldKind.SELECT, FieldKind.MULTI_SELECT].includes(field.kind) && (operator !== EntryFilterOperator.EQ || !field.options?.includes(value))) throw new BadRequestException(`${field.name} needs one of its choices`);
    if ([FieldKind.DATE, FieldKind.DATETIME].includes(field.kind)) {
      const date = new Date(field.kind === FieldKind.DATE ? `${value}T00:00:00Z` : value);
      const valid = field.kind === FieldKind.DATE
        ? /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
        : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(date.getTime());
      if (!valid) throw new BadRequestException(`${field.name} needs a valid date and time`);
      if (field.kind === FieldKind.DATETIME) return { values: { $elemMatch: { fieldId: field.id, value: { [comparison[operator]]: date.toISOString() } } } };
    } else if (![FieldKind.TIME, FieldKind.NUMBER, FieldKind.DURATION].includes(field.kind) && operator !== EntryFilterOperator.EQ) {
      throw new BadRequestException(`${field.name} only supports equals`);
    }
    if (field.kind === FieldKind.MULTI_SELECT) return { values: { $elemMatch: { fieldId: field.id, selectedValues: value } } };
    return { values: { $elemMatch: { fieldId: field.id, value: { [comparison[operator]]: value } } } };
  }

  async entryAttachment(entryId: string, fieldId: string, ownerId: string): Promise<EntryAttachment> {
    this.validId(entryId);
    const entry = await this.entries.findOne({ _id: entryId, ownerId }).exec();
    if (!entry) throw new NotFoundException('Entry not found');
    const collection = await this.one(entry.collectionId, ownerId);
    const format = collection.formats.find((item) => item.id === (entry.formatId ?? collection.formats[0].id));
    if (!format?.fields.some((field) => field.id === fieldId && field.kind === FieldKind.ATTACHMENT)) throw new NotFoundException('Attachment not found');
    const value = entry.values.find((item) => item.fieldId === fieldId);
    if (!value?.attachmentData) throw new NotFoundException('Attachment not found');
    return { fileName: value.value, mimeType: value.attachmentMimeType ?? 'application/octet-stream', size: value.attachmentSize ?? value.attachmentData.length, base64: Buffer.from(value.attachmentData).toString('base64') };
  }

  async importEntriesBatch(collectionId: string, input: ImportEntriesInput, ownerId: string): Promise<ImportEntriesResult> {
    const collection = await this.one(collectionId, ownerId);
    const format = collection.formats.find((item) => item.id === input.formatId);
    if (!format) throw new BadRequestException('Data format not found in this collection');
    if (format.appendOnly) throw new BadRequestException('Import into a register is not supported; add writings through the register');
    if (!input.importKey || input.importKey.length > 100 || !/^[\w.-]+$/.test(input.importKey)) throw new BadRequestException('Invalid import key');
    if (!input.rows.length || input.rows.length > 50) throw new BadRequestException('Import 1 to 50 rows at a time');
    const seen = new Set<string>();
    const errors: { sourceId: string; message: string }[] = [];
    const rows: { sourceId: string; values: EntryValue[]; createdAt: Date; updatedAt: Date; workflow?: { history: ReturnType<typeof importedWorkflowHistory> } }[] = [];
    for (const row of input.rows) {
      try {
        if (!row.sourceId || row.sourceId.length > 100 || /[\x00-\x1f\x7f]/.test(row.sourceId) || seen.has(row.sourceId)) throw new BadRequestException('Invalid or repeated source ID');
        seen.add(row.sourceId);
        const createdAt = new Date(row.createdAt);
        const updatedAt = new Date(row.updatedAt);
        if (Number.isNaN(createdAt.getTime()) || Number.isNaN(updatedAt.getTime()) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(row.createdAt) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(row.updatedAt) || updatedAt < createdAt) throw new BadRequestException('Invalid entry dates');
        const values = prepareWorkflowImport(format, this.validateValues(row.values, format.fields, [], collection.units, true, collection.codeLists ?? []));
        const history = importedWorkflowHistory(format, values, row.workflowHistory, ownerId, new Date());
        await this.validateReferences(collection, format, values, ownerId);
        this.assertObjectTitle(format, values);
        rows.push({ sourceId: row.sourceId, values, createdAt, updatedAt, workflow: history ? { history } : undefined });
      } catch (error) {
        errors.push({ sourceId: row.sourceId || '(missing)', message: error instanceof Error ? error.message : 'Invalid row' });
      }
    }
    if (errors.length) return { validCount: rows.length, createdCount: 0, skippedCount: 0, errors };
    const existing = await this.entries.find({ ownerId, collectionId, importKey: input.importKey, sourceId: { $in: rows.map((row) => row.sourceId) } }).select('sourceId').lean().exec();
    const skippedCount = existing.length;
    if (input.dryRun) return { validCount: rows.length, createdCount: 0, skippedCount, errors: [] };
    const result = await this.entries.bulkWrite(rows.map((row) => ({ updateOne: {
      filter: { ownerId, collectionId, importKey: input.importKey, sourceId: row.sourceId },
      update: { $setOnInsert: { ownerId, collectionId, importKey: input.importKey, sourceId: row.sourceId, formatId: format.id, formatVersion: format.version ?? 1, values: row.values, workflow: row.workflow, createdAt: row.createdAt, updatedAt: row.updatedAt } },
      upsert: true,
      timestamps: false,
    } })), { ordered: false, timestamps: false });
    return { validCount: rows.length, createdCount: result.upsertedCount, skippedCount: rows.length - result.upsertedCount, errors: [] };
  }

  async linkImportedObjects(collectionId: string, importKey: string, links: ImportObjectLinkInput[], ownerId: string): Promise<boolean> {
    const collection = await this.one(collectionId, ownerId);
    if (!importKey || importKey.length > 100 || !/^[\w.-]+$/.test(importKey)) throw new BadRequestException('Invalid import key');
    if (!links.length || links.length > 50) throw new BadRequestException('Link 1 to 50 imported entries at a time');
    const ids = new Set<string>();
    for (const link of links) {
      if (!link.sourceId || !link.sourceObjectId || link.sourceId.length > 100 || link.sourceObjectId.length > 100 || link.sourceId === link.sourceObjectId || ids.has(link.sourceId)) throw new BadRequestException('Invalid object link');
      ids.add(link.sourceId);
    }
    const imported = await this.entries.find({ ownerId, collectionId, importKey, sourceId: { $in: [...new Set(links.flatMap((link) => [link.sourceId, link.sourceObjectId]))] } }).exec();
    const bySource = new Map(imported.map((entry) => [entry.sourceId, entry]));
    for (const link of links) {
      const target = bySource.get(link.sourceId);
      const source = bySource.get(link.sourceObjectId);
      if (!target || !source || !collection.formats.some((format) => format.id === source.formatId && format.objectModel)) throw new BadRequestException('Linked object must be imported in this collection first');
      if (target.sourceObjectId && target.sourceObjectId !== source.id) throw new BadRequestException('Imported entry already links to a different object');
    }
    const result = await this.entries.bulkWrite(links.map((link) => ({ updateOne: {
      filter: { _id: bySource.get(link.sourceId)!.id, ownerId, collectionId, importKey, sourceObjectId: { $in: [null, bySource.get(link.sourceObjectId)!.id] } },
      update: { $set: { sourceObjectId: bySource.get(link.sourceObjectId)!.id } },
      timestamps: false,
    } })), { ordered: true, timestamps: false });
    if (result.matchedCount !== links.length) throw new BadRequestException('Imported entry changed. Refresh and try again');
    return true;
  }

  async validateContributionValues(collection: Collection, formatId: string, values: EntryValueInput[]): Promise<EntryValue[]> {
    const format = collection.formats.find((item) => item.id === formatId);
    if (!format) throw new BadRequestException('Data format not found in this collection');
    return this.validateValues(values, format.fields, [], collection.units, false, collection.codeLists ?? []);
  }

  async createEntry(collectionId: string, values: EntryValueInput[], formatId: string | undefined, ownerId: string, clientMutationId?: string, contribution?: { linkId: string; receivedAt: Date }, correctionOf?: string): Promise<Entry> {
    const collection = await this.one(collectionId, ownerId);
    this.collaboration.checkAccess(collection, ownerId, CollectionRole.EDITOR);
    if (clientMutationId && !/^[\w.-]{1,100}$/.test(clientMutationId)) throw new BadRequestException('Invalid mutation ID');
    if (clientMutationId) {
      const existing = await this.entries.findOne({ collectionId, ownerId: collection.ownerId, clientMutationId }).exec();
      if (existing) return existing;
    }
    const format = formatId
      ? collection.formats.find((item) => item.id === formatId)
      : collection.formats[0];
    if (!format) throw new BadRequestException('Data format not found in this collection');
    if (correctionOf && !format.appendOnly) throw new BadRequestException('Corrections require a register');
    if (format.appendOnly && contribution) throw new BadRequestException('Public contributions cannot write directly to a register');
    const validated = prepareWorkflowCreate(format, this.validateValues(values, format.fields, [], collection.units, false, collection.codeLists ?? []));
    await this.validateReferences(collection, format, validated, ownerId);
    this.assertObjectTitle(format, validated);
    let entry: Entry;
    try { entry = format.appendOnly
      ? await this.ledger.append(collection, format, validated, ownerId, clientMutationId, correctionOf)
      : await this.entries.create({ collectionId, ownerId: collection.ownerId, formatId: format.id, formatVersion: format.version ?? 1, values: validated, clientMutationId, contributionLinkId: contribution?.linkId, contributionReceivedAt: contribution?.receivedAt }); }
    catch (error) {
      if (clientMutationId && (error as { code?: number }).code === 11000) {
        const existing = await this.entries.findOne({ collectionId, ownerId: collection.ownerId, clientMutationId }).exec();
        if (existing) return existing;
      }
      throw error;
    }
    await this.collaboration.logAction(collectionId, ownerId, 'CREATE_ENTRY', `Created entry in format ${format.name}`);
    return entry;
  }

  async correctLedgerEntry(originalId: string, values: EntryValueInput[], actorId: string, clientMutationId?: string): Promise<Entry> {
    this.validId(originalId);
    const original = await this.entries.findOne({ _id: originalId }).exec();
    if (!original) throw new NotFoundException('Original writing not found');
    const collection = await this.one(original.collectionId, actorId);
    this.collaboration.checkAccess(collection, actorId, CollectionRole.EDITOR);
    const format = collection.formats.find((item) => item.id === original.formatId);
    if (!format?.appendOnly || !original.ledgerHash) throw new BadRequestException('Choose a writing in a register');
    const proposed = this.validateValues(values, format.fields, [], collection.units, false, collection.codeLists ?? []);
    for (const field of format.fields.filter((item) => item.kind === FieldKind.NUMBER)) {
      const before = original.values.find((item) => item.fieldId === field.id);
      const after = proposed.find((item) => item.fieldId === field.id);
      if (!before && after) throw new BadRequestException(`Counter-writing cannot add an amount for ${field.name}`);
      if (!before) continue;
      if (!after) throw new BadRequestException(`Counter-writing needs the opposite amount for ${field.name}`);
      const a = decimal(before.numberValue ?? before.value);
      const b = decimal(after.numberValue ?? after.value);
      if (a.n * b.d + b.n * a.d !== 0n) throw new BadRequestException(`Counter-writing needs the opposite amount for ${field.name}`);
    }
    return this.createEntry(collection.id, values, format.id, actorId, clientMutationId, undefined, originalId);
  }

  private assertObjectTitle(format: CollectionFormat, values: EntryValue[]): void {
    if (!format.objectModel) return;
    const title = format.fields.find((field) => field.kind === FieldKind.TITLE);
    if (!title || !values.some((item) => item.fieldId === title.id && item.value.trim())) throw new BadRequestException('Give this object a name');
  }

  private objectProperties(object: Entry, format: CollectionFormat): ObjectPropertySnapshot[] {
    return format.fields.flatMap((field) => {
      const value = object.values.find((item) => item.fieldId === field.id);
      return value ? [{ fieldId: field.id, name: field.name, kind: field.kind, value: value.value, unitSnapshot: value.unitSnapshot }] : [];
    });
  }

  private async validateReferences(collection: Collection, format: CollectionFormat, values: EntryValue[], ownerId: string, updatingId?: string, previousValues: EntryValue[] = []): Promise<void> {
    for (const value of values) {
      const field = format.fields.find((item) => item.id === value.fieldId);
      if (field?.kind !== FieldKind.OBJECT_REF) continue;
      const ids = value.objectIds ?? [];
      const localTarget = collection.formats.find((item) => item.id === field.targetObjectFormatId && item.objectModel);
      const grants = (collection.sharedObjects ?? []).filter((grant) => grant.sourceFormatId === field.targetObjectFormatId && !grant.revokedAt);
      const objects = await this.entries.find({ _id: { $in: ids }, ownerId, formatId: field.targetObjectFormatId }).exec();
      if (objects.some((object) => object.movingOperationId)) throw new BadRequestException('This object is being moved. Try again after the transfer finishes');
      if (objects.length !== ids.length || objects.some((object) => object.collectionId !== collection.id && !grants.some((grant) => grant.objectId === object.id && grant.sourceCollectionId === object.collectionId && (grant.mode === 'CURRENT' || field.referenceMode === 'SNAPSHOT')))) {
        throw new BadRequestException('An object reference is missing or not linked to this collection');
      }
      if (!localTarget && !grants.length) throw new BadRequestException('Object reference model is unavailable');
      if (updatingId && format.objectModel) {
        const seen = new Set<string>();
        const pending = [...objects];
        while (pending.length) {
          const current = pending.pop()!;
          if (current.id === updatingId) throw new BadRequestException('Object references cannot form a cycle');
          if (seen.has(current.id)) continue;
          seen.add(current.id);
          if (seen.size > 200) throw new BadRequestException('Object reference chain is too large');
          const next = current.values.flatMap((item) => item.objectIds ?? []);
          if (next.length) pending.push(...await this.entries.find({ _id: { $in: next }, ownerId }).exec());
        }
      }
      const sourceCollections = await this.collections.find({ _id: { $in: [...new Set(objects.filter((object) => object.collectionId !== collection.id).map((object) => object.collectionId))] }, ownerId }).exec();
      const sourceFormats = new Map(sourceCollections.flatMap((source) => source.formats.map((item) => [item.id, item] as const)));
      const now = new Date();
      const previous = previousValues.find((item) => item.fieldId === field.id);
      value.objectSnapshots = ids.map((id) => {
        const retained = previous?.objectSnapshots?.find((item) => item.objectId === id);
        if (retained) return retained;
        const object = objects.find((item) => item.id === id)!;
        if (object.collectionId !== collection.id) {
          const grant = grants.find((item) => item.objectId === id && item.sourceCollectionId === object.collectionId)!;
          const sourceFormat = sourceFormats.get(grant.sourceFormatId);
          if (!sourceFormat?.objectModel) throw new BadRequestException('Linked object model is unavailable');
          return { objectId: id, formatId: grant.sourceFormatId, formatVersion: grant.mode === 'SNAPSHOT' ? grant.sourceFormatVersion : sourceFormat.version ?? 1, capturedAt: grant.mode === 'SNAPSHOT' ? grant.createdAt : now, properties: grant.mode === 'SNAPSHOT' ? grant.snapshot : this.objectProperties(object, sourceFormat).filter((item) => grant.propertyFieldIds.includes(item.fieldId)) } satisfies ObjectReferenceSnapshot;
        }
        return { objectId: id, formatId: localTarget!.id, formatVersion: localTarget!.version ?? 1, capturedAt: now, properties: this.objectProperties(object, localTarget!) } satisfies ObjectReferenceSnapshot;
      });
    }
  }

  async entryObjectReferences(entryId: string, ownerId: string): Promise<ResolvedObjectReference[]> {
    this.validId(entryId);
    const entry = await this.entries.findOne({ _id: entryId, ownerId }).exec();
    if (!entry) throw new NotFoundException('Entry not found');
    const collection = await this.one(entry.collectionId, ownerId);
    const format = collection.formats.find((item) => item.id === entry.formatId);
    if (!format) throw new NotFoundException('Data format not found');
    const result: ResolvedObjectReference[] = [];
    for (const value of entry.values) {
      const field = format.fields.find((item) => item.id === value.fieldId);
      if (field?.kind !== FieldKind.OBJECT_REF) continue;
      for (const objectId of value.objectIds ?? []) {
        const snapshot = value.objectSnapshots?.find((item) => item.objectId === objectId);
        if (field.referenceMode !== 'CURRENT' && snapshot) {
          result.push({ objectId, fieldId: field.id, mode: 'SNAPSHOT', missing: false, capturedAt: snapshot.capturedAt, name: snapshot.properties.find((item) => item.kind === FieldKind.TITLE)?.value, properties: snapshot.properties });
          continue;
        }
        const localTarget = collection.formats.find((item) => item.id === field.targetObjectFormatId && item.objectModel);
        const grant = (collection.sharedObjects ?? []).find((item) => item.objectId === objectId && item.sourceFormatId === field.targetObjectFormatId && !item.revokedAt);
        const source = grant ? await this.collections.findOne({ _id: grant.sourceCollectionId, ownerId }).exec() : undefined;
        const target = localTarget ?? source?.formats.find((item) => item.id === field.targetObjectFormatId && item.objectModel);
        const object = target ? await this.entries.findOne({ _id: objectId, ownerId, collectionId: grant?.sourceCollectionId ?? collection.id, formatId: field.targetObjectFormatId }).exec() : null;
        const properties = object && target ? this.objectProperties(object, target).filter((item) => !grant || grant.propertyFieldIds.includes(item.fieldId)) : [];
        result.push({ objectId, fieldId: field.id, mode: 'CURRENT', missing: !object || !target, name: properties.find((item) => item.kind === FieldKind.TITLE)?.value, properties });
      }
    }
    return result;
  }

  async resolveObjectVariable(entryId: string, variableName: string, propertyFieldId: string, ownerId: string, objectId?: string): Promise<ResolvedObjectVariable> {
    this.validId(entryId);
    const entry = await this.entries.findOne({ _id: entryId, ownerId }).exec();
    if (!entry) throw new NotFoundException('Entry not found');
    const collection = await this.one(entry.collectionId, ownerId);
    const format = collection.formats.find((item) => item.id === entry.formatId);
    const field = format?.fields.find((item) => item.kind === FieldKind.OBJECT_REF && item.variableName === variableName);
    if (!field) throw new NotFoundException('Object variable not found in this data format');
    const value = entry.values.find((item) => item.fieldId === field.id);
    const ids = value?.objectIds ?? [];
    if (!ids.length) throw new BadRequestException('This object variable has no value');
    if (ids.length > 1 && !objectId) throw new BadRequestException('Choose one object before reading a property');
    const selected = objectId ?? ids[0];
    if (!ids.includes(selected)) throw new BadRequestException('Choose an object referenced by this entry');
    const target = collection.formats.find((item) => item.id === field.targetObjectFormatId && item.objectModel);
    const grant = (collection.sharedObjects ?? []).find((item) => item.objectId === selected && item.sourceFormatId === field.targetObjectFormatId);
    if (!target?.fields.some((item) => item.id === propertyFieldId) && !grant?.propertyFieldIds.includes(propertyFieldId)) throw new BadRequestException('This property is not available to the object variable');
    const resolved = (await this.entryObjectReferences(entryId, ownerId)).find((item) => item.fieldId === field.id && item.objectId === selected);
    if (!resolved || resolved.missing) throw new BadRequestException('Referenced object is unavailable');
    const property = resolved.properties.find((item) => item.fieldId === propertyFieldId);
    if (!property) throw new BadRequestException('This object has no value for that property');
    return { variableName, objectId: selected, mode: resolved.mode, capturedAt: resolved.capturedAt, property };
  }

  async objectDetail(id: string, ownerId: string): Promise<Entry> {
    this.validId(id);
    const entry = await this.entries.findOne({ _id: id }).exec();
    if (!entry) throw new NotFoundException('Object not found');
    const collection = await this.one(entry.collectionId, ownerId);
    const access = this.collaboration.checkAccess(collection, ownerId, CollectionRole.READER);
    if (!collection.formats.some((format) => format.id === entry.formatId && format.objectModel)) throw new NotFoundException('Object not found');
    entry.revisions ??= [];
    const visible = this.collaboration.filterEntryFields(entry, access.member, collection);
    await this.collaboration.auditProtectedRead(collection, ownerId, [visible]);
    return visible;
  }

  async objectsPage(collectionId: string, formatId: string, ownerId: string, first: number, after?: string, search?: string): Promise<EntryPage> {
    const collection = await this.one(collectionId, ownerId);
    this.collaboration.checkAccess(collection, ownerId, CollectionRole.READER);
    if (!collection.formats.some((format) => format.id === formatId && format.objectModel)) throw new NotFoundException('Object model not found');
    return this.entriesPage(collectionId, ownerId, { first, after, search, formatId });
  }

  async duplicateObject(id: string, ownerId: string): Promise<Entry> {
    const source = await this.objectDetail(id, ownerId);
    if (source.movingOperationId) throw new BadRequestException('This object is being moved');
    const collection = await this.one(source.collectionId, ownerId);
    this.collaboration.checkAccess(collection, ownerId, CollectionRole.EDITOR);
    const format = collection.formats.find((item) => item.id === source.formatId)!;
    const values = source.values.map((item) => ({ fieldId: item.fieldId, value: item.value, numberValue: item.numberValue, booleanValue: item.booleanValue, selectedValues: item.selectedValues, durationSeconds: item.durationSeconds, dateTimeValue: item.dateTimeValue, dateValue: item.dateValue, attachmentSize: item.attachmentSize, attachmentMimeType: item.attachmentMimeType, attachmentData: item.attachmentData, unitSnapshot: item.unitSnapshot, objectIds: item.objectIds, objectSnapshots: item.objectSnapshots }));
    const created = await this.entries.create({ ownerId: collection.ownerId, collectionId: source.collectionId, formatId: format.id, formatVersion: format.version ?? 1, values });
    await this.collaboration.logAction(collection.id, ownerId, 'CREATE_ENTRY', `Duplicated object ${id}`);
    return created;
  }

  async useObjectInEntry(objectId: string, targetFormatId: string, targetFieldId: string, ownerId: string): Promise<Entry> {
    const source = await this.objectDetail(objectId, ownerId);
    if (source.movingOperationId) throw new BadRequestException('This object is being moved');
    const collection = await this.one(source.collectionId, ownerId);
    this.collaboration.checkAccess(collection, ownerId, CollectionRole.EDITOR);
    const sourceFormat = collection.formats.find((item) => item.id === source.formatId)!;
    const target = collection.formats.find((item) => item.id === targetFormatId);
    const field = target?.fields.find((item) => item.id === targetFieldId);
    if (!target || target.objectModel || target.appendOnly || !field || ![FieldKind.TITLE, FieldKind.TEXT, FieldKind.LONG_TEXT].includes(field.kind)) throw new BadRequestException('Choose a text field in a regular data format outside a register');
    const summary = sourceFormat.fields.flatMap((definition) => {
      const value = source.values.find((item) => item.fieldId === definition.id);
      if (!value) return [];
      const unitCode = definition.unit;
      const unit = value.unitSnapshot?.symbol ?? (unitCode?.startsWith('local:')
        ? collection.units.find((item) => item.id === unitCode.slice(6))?.symbol
        : unitCode);
      return [`${definition.name}: ${value.value}${unit ? ` ${unit}` : ''}`];
    }).join('\n');
    if (!summary || summary.length > (field.kind === FieldKind.LONG_TEXT ? 50000 : 10000)) throw new BadRequestException('Object is too long for this field');
    const values = this.validateValues([{ fieldId: field.id, value: summary }], target.fields, [], collection.units);
    this.assertObjectTitle(target, values);
    const created = await this.entries.create({ ownerId: collection.ownerId, collectionId: source.collectionId, formatId: target.id, formatVersion: target.version ?? 1, sourceObjectId: source.id, values });
    await this.collaboration.logAction(collection.id, ownerId, 'CREATE_ENTRY', `Created entry using object ${objectId}`);
    return created;
  }

  async updateEntry(id: string, values: EntryValueInput[], formatId: string | undefined, ownerId: string, clientMutationId?: string, expectedUpdatedAt?: string): Promise<Entry> {
    this.validId(id);
    const entry = await this.entries.findOne({ _id: id }).exec();
    if (!entry) throw new NotFoundException('Entry not found');
    const collection = await this.one(entry.collectionId, ownerId);
    this.collaboration.checkAccess(collection, ownerId, CollectionRole.EDITOR);
    if (entry.ledgerHash || collection.formats.find((item) => item.id === entry.formatId)?.appendOnly) throw new BadRequestException('A register writing cannot be edited. Add a linked correction');
    if (clientMutationId && !/^[\w.-]{1,100}$/.test(clientMutationId)) throw new BadRequestException('Invalid mutation ID');
    if (clientMutationId && entry.lastMutationId === clientMutationId) return entry;
    if (expectedUpdatedAt && (!Number.isFinite(Date.parse(expectedUpdatedAt)) || entry.updatedAt.getTime() !== Date.parse(expectedUpdatedAt))) throw new BadRequestException('This entry changed elsewhere. Review the conflict before syncing');
    if (entry.movingOperationId) throw new BadRequestException('This object is being moved. Try again after the transfer finishes');
    if (await this.stockMovements.exists({ collectionId: collection.id, sourceEntryId: id })) throw new BadRequestException('This entry has a validated stock effect. Add a correction or return instead of editing it');
    const savedFormatId = entry.formatId ?? collection.formats[0].id;
    if (formatId && formatId !== savedFormatId) throw new BadRequestException('Entry data format cannot be changed');
    const format = collection.formats.find((item) => item.id === savedFormatId);
    if (!format) throw new BadRequestException('Data format not found in this collection');
    const validated = this.validateValues(values, format.fields, entry.values, collection.units, false, collection.codeLists ?? []);
    assertWorkflowEdit(format, entry.values, validated);
    await this.validateReferences(collection, format, validated, collection.ownerId, entry.id, entry.values);
    this.assertObjectTitle(format, validated);
    const saved = await this.entries.findOneAndUpdate(
      { _id: id, movingOperationId: null, ...(expectedUpdatedAt || format.workflow ? { updatedAt: entry.updatedAt } : {}) }, { $set: { formatId: savedFormatId, formatVersion: format.version ?? 1, values: validated, ...(clientMutationId ? { lastMutationId: clientMutationId } : {}) }, $push: { revisions: { $each: [{ at: entry.updatedAt, formatVersion: entry.formatVersion ?? 1, values: entry.values }], $slice: -20 } } },
      { new: true, runValidators: true },
    ).exec();
    if (!saved) throw new BadRequestException('This entry changed elsewhere. Review the conflict before syncing');
    await this.collaboration.logAction(collection.id, ownerId, 'UPDATE_ENTRY', `Updated entry in format ${format.name}`);
    return saved;
  }

  async removeEntry(id: string, ownerId: string): Promise<boolean> {
    this.validId(id);
    const entry = await this.entries.findOne({ _id: id }).exec();
    if (!entry) throw new NotFoundException('Entry not found');
    const collection = await this.one(entry.collectionId, ownerId);
    this.collaboration.checkAccess(collection, ownerId, CollectionRole.EDITOR);
    if (entry.ledgerHash || collection.formats.find((item) => item.id === entry.formatId)?.appendOnly) throw new BadRequestException('A register writing cannot be deleted. Add a linked correction');
    if (entry.movingOperationId) throw new BadRequestException('This object is being moved');
    if (await this.stockMovements.exists({ collectionId: collection.id, $or: [{ sourceEntryId: id }, { productId: id }] })) throw new BadRequestException('This entry has stock history. Preserve it and add a correction or return');
    if (await this.entries.exists({ collectionId: collection.id, $or: [{ sourceObjectId: id }, { 'values.objectIds': id }] })) throw new BadRequestException('This object is used in entries. Remove those links first');
    if (await this.collections.exists({ _id: collection.id, sharedObjects: { $elemMatch: { objectId: id, revokedAt: null } } })) throw new BadRequestException('Revoke object links before deleting this object');
    const result = await this.entries.deleteOne({ _id: id, movingOperationId: null }).exec();
    if (result.deletedCount > 0) {
      await this.collaboration.logAction(collection.id, ownerId, 'DELETE_ENTRY', `Deleted entry ${id}`);
      return true;
    }
    return false;
  }

  async entryAsOfDate(entryId: string, asOfDate: string, ownerId: string): Promise<Entry> {
    this.validId(entryId);
    const entry = await this.entries.findOne({ _id: entryId }).exec();
    if (!entry) throw new NotFoundException('Entry not found');
    const collection = await this.one(entry.collectionId, ownerId);
    const access = this.collaboration.checkAccess(collection, ownerId, CollectionRole.READER);
    const asOfEntry = await this.measurements.asOfDate(entry, asOfDate);
    const visible = this.collaboration.filterEntryFields(asOfEntry, access.member, collection);
    await this.collaboration.auditProtectedRead(collection, ownerId, [visible]);
    return visible;
  }

  private validateValues(values: EntryValueInput[], fields: Collection['fields'], existing: EntryValue[] = [], units: CollectionUnit[] = [], imported = false, codeLists: Collection['codeLists'] = []): EntryValue[] {
    if (!values.length) throw new BadRequestException('Write something before saving');
    const definitions = new Map(fields.map((field) => [field.id, field]));
    const seen = new Set<string>();
    let totalAttachmentBytes = 0;
    return values.map((input) => {
      const { fieldId, value } = input;
      const field = definitions.get(fieldId);
      if (!field || seen.has(fieldId)) throw new BadRequestException('Invalid or repeated field');
      seen.add(fieldId);
      const text = value.trim();
      const isAbsentMeasure = field.kind === FieldKind.MEASURE && input.measureValue?.status === 'ABSENT';
      if (!text && !isAbsentMeasure) throw new BadRequestException('Leave empty fields out of the entry');
      if (text.length > (field.kind === FieldKind.LONG_TEXT ? 50000 : 10000)) throw new BadRequestException(`${field.name} is too long`);
      switch (field.kind) {
        case FieldKind.ATTACHMENT: {
          if (text.length > 255 || /[\\/\x00-\x1f\x7f]/.test(text) || text === '.' || text === '..') throw new BadRequestException(`${field.name} needs a valid file name`);
          const previous = existing.find((item) => item.fieldId === fieldId && item.value === text && item.attachmentData);
          let data: Buffer;
          if (input.attachmentBase64 != null) {
            if (input.attachmentBase64.length > 2_800_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.attachmentBase64)) throw new BadRequestException(`${field.name} file is too large or invalid`);
            data = Buffer.from(input.attachmentBase64, 'base64');
            if (!data.length || data.length > 2_097_152 || data.toString('base64') !== input.attachmentBase64) throw new BadRequestException(`${field.name} file is too large or invalid`);
          } else if (previous?.attachmentData) {
            data = Buffer.from(previous.attachmentData);
          } else {
            throw new BadRequestException(`${field.name} needs a file`);
          }
          totalAttachmentBytes += data.length;
          if (totalAttachmentBytes > 8_388_608) throw new BadRequestException('Attachments in one entry cannot exceed 8 MB');
          const mimeType = input.attachmentMimeType ?? previous?.attachmentMimeType ?? 'application/octet-stream';
          if (mimeType.length > 100 || !/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)) throw new BadRequestException(`${field.name} needs a valid file type`);
          return { fieldId, value: text, attachmentSize: data.length, attachmentMimeType: mimeType, attachmentData: data };
        }
        case FieldKind.DATE: {
          const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
          const date = new Date(`${text}T00:00:00Z`);
          if (!match || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) {
            throw new BadRequestException(`${field.name} must be a valid date`);
          }
          return { fieldId, value: text, dateValue: text };
        }
        case FieldKind.DATETIME: {
          if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) throw new BadRequestException(`${field.name} needs a date, time and time zone`);
          const date = new Date(text);
          const year = Number(text.slice(0, 4));
          const month = Number(text.slice(5, 7));
          const day = Number(text.slice(8, 10));
          const hours = Number(text.slice(11, 13));
          const minutes = Number(text.slice(14, 16));
          const calendarDay = new Date(Date.UTC(year, month - 1, day));
          if (Number.isNaN(date.getTime()) || calendarDay.getUTCFullYear() !== year || calendarDay.getUTCMonth() + 1 !== month || calendarDay.getUTCDate() !== day || hours > 23 || minutes > 59) {
            throw new BadRequestException(`${field.name} needs a valid date and time`);
          }
          return { fieldId, value: date.toISOString(), dateTimeValue: date.toISOString() };
        }
        case FieldKind.DURATION: {
          const match = /^(\d{1,6}):([0-5]\d)$/.exec(text);
          if (!match) throw new BadRequestException(`${field.name} needs a duration as hours:minutes`);
          return { fieldId, value: `${Number(match[1])}:${match[2]}`, durationSeconds: (Number(match[1]) * 60 + Number(match[2])) * 60 };
        }
        case FieldKind.TIME:
          if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) throw new BadRequestException(`${field.name} must be a valid time`);
          break;
        case FieldKind.NUMBER: {
          if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) || !Number.isFinite(Number(text))) {
            throw new BadRequestException(`${field.name} must be a number`);
          }
          const previous = imported ? input.unitSnapshot : existing.find((item) => item.fieldId === fieldId && item.value === text)?.unitSnapshot;
          const unitSnapshot = this.numberSnapshot(field.unit, units, previous);
          return { fieldId, value: text, numberValue: text, ...(unitSnapshot ? { unitSnapshot } : {}) };
        }
        case FieldKind.MEASURE: {
          const validated = this.measurements.validateMeasure(input.measureValue, text, field.name);
          const previous = imported ? input.unitSnapshot : existing.find((item) => item.fieldId === fieldId)?.unitSnapshot;
          const unitSnapshot = this.numberSnapshot(field.unit, units, previous);
          return {
            fieldId,
            value: validated.value,
            ...(validated.numberValue ? { numberValue: validated.numberValue } : {}),
            measureValue: validated.measureValue,
            ...(unitSnapshot ? { unitSnapshot } : {}),
          };
        }
        case FieldKind.BOOLEAN:
          if (text !== 'true' && text !== 'false') throw new BadRequestException(`${field.name} must be yes or no`);
          return { fieldId, value: text, booleanValue: text === 'true' };
        case FieldKind.SELECT:
          if (!field.options?.includes(text)) throw new BadRequestException(`${field.name} needs one of its choices`);
          return { fieldId, value: text, selectedValues: [text] };
        case FieldKind.MULTI_SELECT: {
          let selected: string[];
          try { selected = JSON.parse(text) as string[]; } catch { throw new BadRequestException(`${field.name} needs valid choices`); }
          if (!Array.isArray(selected) || !selected.length || selected.some((item) => typeof item !== 'string' || !field.options?.includes(item)) || new Set(selected).size !== selected.length) {
            throw new BadRequestException(`${field.name} needs valid choices`);
          }
          return { fieldId, value: JSON.stringify(selected), selectedValues: selected };
        }
        case FieldKind.OBJECT_REF: {
          let ids: unknown;
          try { ids = JSON.parse(text); } catch { throw new BadRequestException(`${field.name} needs object IDs`); }
          if (!Array.isArray(ids) || !ids.length || ids.length > 20 || ids.some((id) => typeof id !== 'string' || !Types.ObjectId.isValid(id)) || new Set(ids).size !== ids.length || (!field.multiple && ids.length !== 1)) {
            throw new BadRequestException(`${field.name} needs compatible objects`);
          }
          return { fieldId, value: JSON.stringify(ids), objectIds: ids as string[] };
        }
        case FieldKind.LINK:
          try {
            const url = new URL(text);
            if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported protocol');
          } catch {
            throw new BadRequestException(`${field.name} must be a web link`);
          }
          break;
        case FieldKind.CHARACTER:
          if ([...text].length !== 1) throw new BadRequestException(`${field.name} must be one character`);
          break;
        case FieldKind.CODE: {
          const list = codeLists.find((item) => item.id === field.codeListId);
          const code = list?.codes.find((item) => item.code === text);
          if (!code || (!code.active && !imported && !existing.some((item) => item.fieldId === fieldId && item.value === text))) throw new BadRequestException(`${field.name} needs an active code`);
          break;
        }
        case FieldKind.POSITION:
          return { fieldId, value: JSON.stringify(parsePosition(text)) };
        case FieldKind.ZONE:
          return { fieldId, value: JSON.stringify(parseZone(text)) };
      }
      return { fieldId, value: text };
    });
  }
}
