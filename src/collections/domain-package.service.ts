import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { AnalysisService } from './analysis.service';
import { ClassificationService } from './classification.service';
import { CollaborationService } from './collaboration.service';
import { CollectionRole } from './collaboration.schema';
import { Collection, CollectionFormat, FieldKind } from './collection.schema';
import { CollectionFieldInput, CollectionUnitInput } from './collection.input';
import { CollectionsService, formatColors } from './collections.service';
import { Entry } from './entry.schema';
import { builtInUnits } from './unit_math';
import { StockService } from './stock.service';
import { DomainPackage, PackageCodeList, PackageField, PackageFormat, PackageObject, PackageStockRule, PackageText, PackageUnit, PackageView, PackageFormula, PACKAGE_FORMAT, PACKAGE_SCHEMA_VERSION, compareVersions, localized, parseDomainPackage, signatureStatus } from './domain-package.format';
import { DomainPackageExport, DomainPackageInstall, DomainPackageInstallResult, DomainPackageKey, DomainPackagePreview, DomainPackageSummary } from './domain-package.schema';
import { pilotPackages } from './domain-package.pilots';
import { formulaChildKeys } from './formula_nodes';

export type DomainPackageExportOptions = { packageId: string; version: string; name: string; description?: string; notice?: string; author: string; license: string };

type Plan = {
  pkg: DomainPackage; signature: ReturnType<typeof signatureStatus>; language: string;
  collection?: Collection; install?: DomainPackageInstall & { _id: Types.ObjectId }; mode: 'NEW_COLLECTION' | 'INSTALL' | 'UPDATE';
  keys: Map<string, string>; formats: PackageFormat[]; fields: { format: PackageFormat; field: PackageField }[];
  units: PackageUnit[]; codeLists: PackageCodeList[]; newCodes: { list: PackageCodeList; codes: PackageCodeList['codes'] }[];
  views: PackageView[]; formulas: PackageFormula[]; stockRules: PackageStockRule[]; objects: PackageObject[];
  colors: Map<string, string>; adjustments: string[]; conflicts: string[]; dependencies: string[];
};

const say = (language: string, en: string, fr: string) => language === 'fr' ? fr : en;
const lower = (value: string) => value.toLocaleLowerCase();

@Injectable()
export class DomainPackageService {
  constructor(
    @InjectModel(DomainPackageInstall.name) private readonly installs: Model<DomainPackageInstall>,
    @InjectModel(Collection.name) private readonly collectionModel: Model<Collection>,
    @InjectModel(Entry.name) private readonly entries: Model<Entry>,
    private readonly collections: CollectionsService,
    private readonly classification: ClassificationService,
    private readonly analysis: AnalysisService,
    private readonly stock: StockService,
    private readonly collaboration: CollaborationService,
  ) {}

  pilots(language: string): DomainPackageSummary[] {
    return pilotPackages.map((raw) => {
      const packageJson = JSON.stringify(raw, null, 2);
      const pkg = parseDomainPackage(packageJson);
      return { id: pkg.id, version: pkg.version, name: localized(pkg.name, language), description: localized(pkg.description, language), packageJson };
    });
  }

  async listInstalls(collectionId: string, userId: string): Promise<DomainPackageInstall[]> {
    await this.owned(collectionId, userId, CollectionRole.READER);
    const items = await this.installs.find({ collectionId, detachedAt: { $exists: false } }).sort({ installedAt: -1 }).exec();
    return items.map((item) => ({ ...item.toObject(), id: item.id as string, dataFormatCount: item.keys.filter((entry) => entry.kind === 'format').length }));
  }

  async detach(installId: string, userId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(installId)) throw new NotFoundException('Package installation not found');
    const install = await this.installs.findOne({ _id: installId, detachedAt: { $exists: false } }).exec();
    if (!install) throw new NotFoundException('Package installation not found');
    await this.owned(install.collectionId, userId, CollectionRole.OWNER);
    await this.installs.updateOne({ _id: installId }, { $set: { detachedAt: new Date() } }).exec();
    return true;
  }

  async preview(source: string, userId: string, language: string, collectionId?: string): Promise<DomainPackagePreview> {
    const plan = await this.plan(source, userId, language, collectionId);
    const { pkg } = plan;
    const name = (item: { name: PackageText }) => localized(item.name, language);
    return {
      packageId: pkg.id, version: pkg.version, name: localized(pkg.name, language), description: localized(pkg.description, language), notice: localized(pkg.notice, language),
      author: pkg.provenance.author, license: pkg.provenance.license, publishedAt: pkg.provenance.publishedAt, homepage: pkg.provenance.homepage,
      signatureStatus: plan.signature.status, keyFingerprint: plan.signature.fingerprint, mode: plan.mode, installedVersion: plan.install?.version,
      dataFormats: plan.formats.map(name), addedFields: plan.fields.map(({ format, field }) => `${this.formatName(plan, format)} → ${name(field)}`),
      units: plan.units.map((unit) => `${name(unit)} (${unit.symbol})`), codeLists: [...plan.codeLists.map(name), ...plan.newCodes.map(({ list, codes }) => say(language, `${name(list)}: ${codes.length} new codes`, `${name(list)} : ${codes.length} nouveaux codes`))],
      views: plan.views.map(name), formulas: plan.formulas.map(name), stockRules: plan.stockRules.map(name), exampleObjects: plan.objects.length,
      dependencies: plan.dependencies, adjustments: plan.adjustments, conflicts: plan.conflicts, allowed: plan.conflicts.length === 0 && plan.signature.status !== 'INVALID',
    };
  }

  async install(source: string, userId: string, language: string, collectionId?: string, collectionName?: string): Promise<DomainPackageInstallResult> {
    const plan = await this.plan(source, userId, language, collectionId);
    if (plan.signature.status === 'INVALID') throw new BadRequestException(say(language, 'The package signature is invalid: the file was changed after signing', 'La signature du paquet est invalide : le fichier a été modifié après signature'));
    if (plan.conflicts.length) throw new BadRequestException(plan.conflicts.join(' · '));
    const createdEntries: string[] = [];
    const snapshot = plan.collection ? this.snapshot(plan.collection) : undefined;
    const state: { collectionId?: string } = { collectionId: plan.collection?.id as string | undefined };
    try {
      const targetId = await this.apply(plan, userId, collectionName, createdEntries, state);
      const keys = [...plan.keys].map(([compound, id]) => { const at = compound.indexOf(':'); return { kind: compound.slice(0, at), key: compound.slice(at + 1), id }; });
      const fields = { packageId: plan.pkg.id, version: plan.pkg.version, name: localized(plan.pkg.name, language), author: plan.pkg.provenance.author, license: plan.pkg.provenance.license, publishedAt: plan.pkg.provenance.publishedAt, signatureStatus: plan.signature.status, keyFingerprint: plan.signature.fingerprint, keys };
      const record = plan.install
        ? await this.installs.findOneAndUpdate({ _id: plan.install._id, version: plan.install.version, detachedAt: { $exists: false } }, { $set: { ...fields, updatedFrom: plan.install.version } }, { new: true }).exec()
        : await this.installs.create({ ...fields, collectionId: targetId, ownerId: userId, installedAt: new Date() });
      if (!record) throw new BadRequestException('Package installation changed. Refresh and try again');
      return { collectionId: targetId, installId: record.id, mode: plan.mode, version: plan.pkg.version, addedDataFormats: plan.formats.length, addedFields: plan.fields.length, exampleObjects: plan.objects.length };
    } catch (error) {
      await this.rollback(plan, userId, state.collectionId, snapshot, createdEntries);
      throw error;
    }
  }

  async export(collectionId: string, userId: string, options: DomainPackageExportOptions, language: string): Promise<DomainPackageExport> {
    const collection = await this.owned(collectionId, userId, CollectionRole.OWNER);
    const warnings: string[] = [];
    const warn = (en: string, fr: string) => warnings.push(say(language, en, fr));
    const known = new Map<string, string>();
    for (const install of await this.installs.find({ collectionId, detachedAt: { $exists: false } }).exec()) for (const item of install.keys) known.set(`${item.kind}:${item.id}`, item.key.split('.').at(-1)!);
    const used = new Set<string>();
    const keyFor = (kind: string, id: string, knownKind = kind): string => {
      let candidate = known.get(`${knownKind}:${id}`) ?? id;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(candidate)) candidate = `${kind}-${used.size + 1}`;
      while (used.has(`${kind}:${candidate}`)) candidate = `${candidate}-x`;
      used.add(`${kind}:${candidate}`);
      return candidate;
    };
    const formatKeys = new Map(collection.formats.map((format) => [format.id, keyFor('format', format.id)]));
    const fieldKeys = new Map<string, { format: string; key: string }>();
    const unitKeys = new Map(collection.units.map((unit) => [unit.id, keyFor('unit', unit.id)]));
    const listKeys = new Map((collection.codeLists ?? []).map((list) => [list.id, keyFor('codeList', list.id)]));
    const unitRef = (unit?: string) => !unit ? undefined : unit.startsWith('local:') ? (unitKeys.has(unit.slice(6)) ? `local:${unitKeys.get(unit.slice(6))}` : undefined) : builtInUnits.some((item) => item.id === unit) ? unit : undefined;
    const dataFormats: PackageFormat[] = [];
    for (const format of collection.formats) {
      if (format.workflow) warn(`Workflow of ${format.name} is not exported in package format 1`, `Le flux d’états de ${format.name} n’est pas exporté dans le format de paquet 1`);
      if (format.appendOnly) warn(`${format.name} is exported as an ordinary data format, without its register setting`, `${format.name} est exporté comme format ordinaire, sans son réglage de registre`);
      const fields: PackageField[] = [];
      for (const field of format.fields) {
        if (field.kind === FieldKind.OBJECT_REF && !collection.formats.some((item) => item.id === field.targetObjectFormatId && item.objectModel)) { warn(`Field ${format.name} → ${field.name} refers to a shared object and is not exported`, `Le champ ${format.name} → ${field.name} vise un objet partagé et n’est pas exporté`); continue; }
        if (field.unit && !unitRef(field.unit)) { warn(`Field ${format.name} → ${field.name} uses a unit unknown to packages and is exported without unit`, `Le champ ${format.name} → ${field.name} utilise une unité inconnue des paquets et est exporté sans unité`); }
        const key = keyFor(`field.${format.id}`, field.id, 'field');
        fieldKeys.set(field.id, { format: formatKeys.get(format.id)!, key });
        fields.push({
          key, name: field.name, kind: field.kind, unit: unitRef(field.unit), options: field.options?.length ? [...field.options] : undefined,
          codeList: field.codeListId ? listKeys.get(field.codeListId) : undefined, target: field.targetObjectFormatId ? formatKeys.get(field.targetObjectFormatId) : undefined,
          multiple: field.multiple || undefined, referenceMode: field.referenceMode as PackageField['referenceMode'], variableName: field.variableName, sensitivity: field.sensitivity,
        });
      }
      dataFormats.push({ key: formatKeys.get(format.id)!, name: format.name, color: format.color, objectModel: format.objectModel || undefined, sensitivity: format.sensitivity, fields });
    }
    const ref = (fieldId?: string) => { const found = fieldId ? fieldKeys.get(fieldId) : undefined; return found ? `${found.format}.${found.key}` : undefined; };
    const units: PackageUnit[] = collection.units.map((unit) => ({ key: unitKeys.get(unit.id)!, name: unit.name, symbol: unit.symbol, dimension: unit.dimension, base: unit.baseUnitId ? (unitKeys.has(unit.baseUnitId) ? `local:${unitKeys.get(unit.baseUnitId)}` : unit.baseUnitId) : undefined, factor: unit.factor, objectFormat: unit.objectFormatId ? formatKeys.get(unit.objectFormatId) : undefined }));
    if ((collection.codeLists ?? []).some((list) => list.external)) throw new BadRequestException('Large code lists cannot be shared in a domain package');
    const codeLists: PackageCodeList[] = (collection.codeLists ?? []).map((list) => ({ key: listKeys.get(list.id)!, name: list.name, codes: list.codes.map((code) => ({ code: code.code, label: { en: code.labelEn, fr: code.labelFr }, parent: code.parentCode, active: code.active === false || code.mergedInto ? false : undefined })) }));
    const views: PackageView[] = [];
    for (const view of collection.savedViews ?? []) {
      if (view.search || view.filterFieldId) warn(`Search and filter of view ${view.name} are not exported`, `La recherche et le filtre de la vue ${view.name} ne sont pas exportés`);
      const clean = (ids: (string | undefined)[]) => ids.map(ref).filter((item): item is string => !!item);
      const task = view.layout === 'TASKS' ? { done: ref(view.taskDoneFieldId), due: ref(view.taskDueFieldId), completed: ref(view.taskCompletedFieldId), priority: ref(view.taskPriorityFieldId) } : undefined;
      const start = ref(view.calendarStartFieldId);
      if (view.layout === 'CALENDAR' && !start) { warn(`Calendar view ${view.name} is not exported`, `La vue calendrier ${view.name} n’est pas exportée`); continue; }
      views.push({ key: keyFor('view', view.id), name: view.name, layout: view.layout, dataFormats: view.formatIds.map((id) => formatKeys.get(id)).filter((item): item is string => !!item), columns: clean(view.columnFieldIds), sort: view.sort, groupByFormat: view.groupByFormat || undefined, manualOrder: view.manualOrderFieldIds?.length ? clean(view.manualOrderFieldIds) : undefined, task: task && Object.fromEntries(Object.entries(task).filter(([, value]) => value)), calendar: start ? { start, end: ref(view.calendarEndFieldId), timeZone: view.calendarTimeZone } : undefined });
    }
    const formulaKeys = new Map((collection.formulas ?? []).map((formula) => [formula.id, keyFor('formula', formula.id)]));
    const formulas: PackageFormula[] = [];
    for (const formula of collection.formulas ?? []) {
      let missing = false;
      const map = (node: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(node).map(([name, value]) => {
        if (['fieldId', 'referenceFieldId', 'propertyFieldId', 'fromFieldId', 'toFieldId'].includes(name)) { const found = fieldKeys.get(value as string); if (!found) missing = true; return [name, found?.key ?? '']; }
        if (name === 'through' && Array.isArray(value)) return [name, value.map((step) => { const found = fieldKeys.get(step as string); if (!found) missing = true; return found?.key ?? ''; })];
        if (name === 'formulaId') { const found = formulaKeys.get(value as string); if (!found) missing = true; return [name, found ?? '']; }
        if (name === 'unit' && typeof value === 'string' && node.kind === 'number') { const mapped = builtInUnits.some((item) => item.id === value) ? value : unitKeys.has(value) ? `local:${unitKeys.get(value)}` : undefined; if (!mapped) missing = true; return [name, mapped ?? '']; }
        if (name === 'args' && Array.isArray(value)) return [name, value.map((child) => map(child as Record<string, unknown>))];
        if (formulaChildKeys.includes(name) && value && typeof value === 'object') return [name, map(value as Record<string, unknown>)];
        return [name, value];
      }));
      const expression = map(JSON.parse(formula.expression) as Record<string, unknown>);
      if (missing || !formatKeys.has(formula.formatId)) { warn(`Formula ${formula.name} depends on an element that is not exported`, `La formule ${formula.name} dépend d’un élément non exporté`); continue; }
      formulas.push({ key: formulaKeys.get(formula.id)!, name: formula.name, dataFormat: formatKeys.get(formula.formatId)!, expression });
    }
    const field = (id?: string) => id ? fieldKeys.get(id)?.key : undefined;
    const stockRules: PackageStockRule[] = (collection.stockRules ?? []).map((item) => ({ key: keyFor('stockRule', item.id), name: item.name, dataFormat: formatKeys.get(item.formatId)!, kind: item.kind, product: field(item.productFieldId)!, quantity: field(item.quantityFieldId)!, date: field(item.dateFieldId), price: field(item.priceFieldId), reason: field(item.reasonFieldId), from: field(item.fromLocationFieldId), to: field(item.toLocationFieldId), lot: field(item.lotFieldId), packageFactor: item.packageFactor }));
    if ((collection.exchangeRates ?? []).length) warn('Exchange rates are observations and are not exported', 'Les taux de change sont des observations et ne sont pas exportés');
    const strip = (value: unknown): unknown => Array.isArray(value) ? value.map(strip) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([name, item]) => [name, strip(item)])) : value;
    const raw = strip({
      format: PACKAGE_FORMAT, schemaVersion: PACKAGE_SCHEMA_VERSION, id: options.packageId.trim(), version: options.version.trim(), name: options.name.trim(),
      description: options.description?.trim() || undefined, notice: options.notice?.trim() || undefined,
      provenance: { author: options.author.trim(), license: options.license.trim(), publishedAt: new Date().toISOString().slice(0, 10) },
      content: { units, codeLists, dataFormats, exampleObjects: [], views, formulas, stockRules: stockRules.filter((item) => item.dataFormat && item.product && item.quantity) },
    });
    const packageJson = JSON.stringify(raw, null, 2);
    parseDomainPackage(packageJson);
    return { packageJson, fileName: `${options.packageId.trim()}-${options.version.trim()}.brainy-package.json`, warnings, dataFormats: dataFormats.length };
  }

  private async owned(collectionId: string, userId: string, role: CollectionRole): Promise<Collection> {
    const collection = await this.collections.one(collectionId, userId);
    this.collaboration.checkAccess(collection, userId, role);
    return collection;
  }

  private formatName(plan: Plan, format: PackageFormat): string {
    const id = plan.keys.get(`format:${format.key}`);
    return plan.collection?.formats.find((item) => item.id === id)?.name ?? localized(format.name, plan.language);
  }

  private async plan(source: string, userId: string, language: string, collectionId?: string): Promise<Plan> {
    const pkg = parseDomainPackage(source);
    if (!pkg.content.dataFormats.some((format) => format.fields.every((field) => !field.target && !field.unit?.startsWith('local:'))) && !collectionId) throw new BadRequestException('A package needs one data format without object reference or local unit');
    const collection = collectionId ? await this.owned(collectionId, userId, CollectionRole.OWNER) : undefined;
    const install = collectionId ? await this.installs.findOne({ collectionId, packageId: pkg.id, detachedAt: { $exists: false } }).exec() : undefined;
    const m = (en: string, fr: string) => say(language, en, fr);
    const name = (item: { name: PackageText }) => localized(item.name, language);
    const plan: Plan = {
      pkg, signature: signatureStatus(source), language, collection, install: (install ?? undefined) as Plan['install'], mode: !collection ? 'NEW_COLLECTION' : install ? 'UPDATE' : 'INSTALL',
      keys: new Map((install?.keys ?? []).map((item) => [`${item.kind}:${item.key}`, item.id])), formats: [], fields: [], units: [], codeLists: [], newCodes: [], views: [], formulas: [], stockRules: [], objects: [],
      colors: new Map(), adjustments: [], conflicts: [], dependencies: [],
    };
    if (install) {
      const order = compareVersions(pkg.version, install.version);
      if (order === 0) plan.conflicts.push(m(`Version ${pkg.version} is already installed in this collection`, `La version ${pkg.version} est déjà installée dans cette collection`));
      if (order < 0) plan.conflicts.push(m(`Version ${pkg.version} is older than the installed version ${install.version}`, `La version ${pkg.version} est plus ancienne que la version installée ${install.version}`));
      if (order <= 0) return plan;
    }
    const exists = (kind: string, item: { key: string; name: PackageText }, present: (id: string) => boolean): boolean => {
      const id = plan.keys.get(`${kind}:${item.key}`);
      if (id && !present(id)) { plan.adjustments.push(m(`${name(item)} was removed locally and is not added again`, `${name(item)} a été retiré localement et n’est pas ajouté à nouveau`)); return true; }
      return !!id;
    };
    const formats = collection?.formats ?? [];
    const formatNames = new Set(formats.map((item) => lower(item.name)));
    for (const format of pkg.content.dataFormats) {
      if (exists('format', format, (id) => formats.some((item) => item.id === id))) {
        const local = formats.find((item) => item.id === plan.keys.get(`format:${format.key}`));
        if (!local) continue;
        const additions = format.fields.filter((field) => !plan.keys.has(`field:${format.key}.${field.key}`));
        for (const field of additions) {
          if (local.fields.some((item) => lower(item.name) === lower(name(field)))) plan.conflicts.push(m(`${local.name} already has a field named ${name(field)}`, `${local.name} possède déjà un champ nommé ${name(field)}`));
          plan.fields.push({ format, field });
        }
        if (local.fields.length + additions.length > 30) plan.conflicts.push(m(`${local.name} would have more than 30 fields`, `${local.name} dépasserait 30 champs`));
        continue;
      }
      if (formatNames.has(lower(name(format)))) plan.conflicts.push(m(`A data format named ${name(format)} already exists in this collection`, `Un format de données nommé ${name(format)} existe déjà dans cette collection`));
      formatNames.add(lower(name(format)));
      plan.formats.push(format);
    }
    if (formats.length + plan.formats.length > formatColors.length) plan.conflicts.push(m(`A collection can hold at most ${formatColors.length} data formats`, `Une collection contient au plus ${formatColors.length} formats de données`));
    const usedColors = new Set(formats.map((item) => item.color));
    for (const format of plan.formats) {
      const wanted = format.color?.toUpperCase();
      const color = wanted && formatColors.includes(wanted) && !usedColors.has(wanted) ? wanted : formatColors.find((item) => !usedColors.has(item));
      if (!color) continue;
      if (wanted && color !== wanted) plan.adjustments.push(m(`${name(format)} uses another colour because its colour is already taken`, `${name(format)} utilise une autre couleur, la sienne étant déjà prise`));
      usedColors.add(color);
      plan.colors.set(format.key, color);
    }
    const units = collection?.units ?? [];
    for (const unit of pkg.content.units) {
      if (exists('unit', unit, (id) => units.some((item) => item.id === id))) continue;
      if (units.some((item) => lower(item.name) === lower(name(unit)) || item.symbol === unit.symbol)) plan.conflicts.push(m(`A local unit named ${name(unit)} or with symbol ${unit.symbol} already exists`, `Une unité locale nommée ${name(unit)} ou de symbole ${unit.symbol} existe déjà`));
      plan.units.push(unit);
    }
    const lists = collection?.codeLists ?? [];
    for (const list of pkg.content.codeLists) {
      if (exists('codeList', list, (id) => lists.some((item) => item.id === id))) {
        const local = lists.find((item) => item.id === plan.keys.get(`codeList:${list.key}`));
        const codes = list.codes.filter((code) => !local?.codes.some((item) => item.code === code.code));
        if (local && codes.length) plan.newCodes.push({ list, codes });
        continue;
      }
      if (lists.some((item) => lower(item.name) === lower(name(list)))) plan.conflicts.push(m(`A code list named ${name(list)} already exists`, `Une liste de codes nommée ${name(list)} existe déjà`));
      plan.codeLists.push(list);
    }
    const views = collection?.savedViews ?? [];
    plan.views = pkg.content.views.filter((view) => !exists('view', view, (id) => views.some((item) => item.id === id)));
    for (const view of plan.views) if (views.some((item) => lower(item.name) === lower(name(view)))) plan.conflicts.push(m(`A view named ${name(view)} already exists`, `Une vue nommée ${name(view)} existe déjà`));
    const formulas = collection?.formulas ?? [];
    plan.formulas = pkg.content.formulas.filter((formula) => !exists('formula', formula, (id) => formulas.some((item) => item.id === id)));
    const rules = collection?.stockRules ?? [];
    plan.stockRules = pkg.content.stockRules.filter((item) => !exists('stockRule', item, (id) => rules.some((rule) => rule.id === id)));
    for (const item of plan.stockRules) if (rules.some((rule) => lower(rule.name) === lower(name(item)))) plan.conflicts.push(m(`A stock rule named ${name(item)} already exists`, `Une règle de stock nommée ${name(item)} existe déjà`));
    // A rule, view or formula added by an update must not rely on a format that was removed locally.
    const available = (formatKey: string) => plan.formats.some((item) => item.key === formatKey) || formats.some((item) => item.id === plan.keys.get(`format:${formatKey}`));
    for (const item of [...plan.views.flatMap((view) => view.dataFormats.map((formatKey) => ({ formatKey, label: name(view) }))), ...plan.formulas.map((formula) => ({ formatKey: formula.dataFormat, label: name(formula) })), ...plan.stockRules.map((rule) => ({ formatKey: rule.dataFormat, label: name(rule) }))]) {
      if (!available(item.formatKey)) plan.conflicts.push(m(`${item.label} needs a data format that was removed locally`, `${item.label} a besoin d’un format de données retiré localement`));
    }
    plan.objects = install ? [] : pkg.content.exampleObjects;
    const builtIns = new Set<string>();
    for (const format of pkg.content.dataFormats) for (const field of format.fields) {
      if (field.unit && !field.unit.startsWith('local:')) builtIns.add(builtInUnits.find((item) => item.id === field.unit)!.symbol);
      if (field.target) plan.dependencies.push(m(`${name(format)} → ${name(field)} refers to objects of ${name(pkg.content.dataFormats.find((item) => item.key === field.target)!)}`, `${name(format)} → ${name(field)} référence les objets de ${name(pkg.content.dataFormats.find((item) => item.key === field.target)!)}`));
      if (field.codeList) plan.dependencies.push(m(`${name(format)} → ${name(field)} uses the code list ${name(pkg.content.codeLists.find((item) => item.key === field.codeList)!)}`, `${name(format)} → ${name(field)} utilise la liste de codes ${name(pkg.content.codeLists.find((item) => item.key === field.codeList)!)}`));
    }
    if (builtIns.size) plan.dependencies.unshift(m(`Built-in units: ${[...builtIns].join(', ')}`, `Unités intégrées : ${[...builtIns].join(', ')}`));
    return plan;
  }

  private snapshot(collection: Collection) {
    const copy = (value: unknown) => JSON.parse(JSON.stringify(value ?? [])) as unknown[];
    return { formats: copy(collection.formats), units: copy(collection.units), codeLists: copy(collection.codeLists), savedViews: copy(collection.savedViews), formulas: copy(collection.formulas), stockRules: copy(collection.stockRules) };
  }

  private async rollback(plan: Plan, userId: string, targetId: string | undefined, snapshot: ReturnType<DomainPackageService['snapshot']> | undefined, createdEntries: string[]): Promise<void> {
    try {
      if (!targetId) return;
      if (!plan.collection) { await this.collections.remove(targetId, userId); return; }
      if (createdEntries.length) await this.entries.deleteMany({ _id: { $in: createdEntries }, collectionId: targetId }).exec();
      await this.collectionModel.updateOne({ _id: targetId }, { $set: snapshot }).exec();
    } catch { /* The original error matters more to the user than a failed compensation. */ }
  }

  private fieldInput(plan: Plan, format: PackageFormat, field: PackageField): CollectionFieldInput {
    const unit = field.unit?.startsWith('local:') ? `local:${plan.keys.get(`unit:${field.unit.slice(6)}`)}` : field.unit;
    return {
      name: localized(field.name, plan.language), kind: field.kind, unit, options: field.options?.map((option) => localized(option, plan.language)),
      targetObjectFormatId: field.target ? plan.keys.get(`format:${field.target}`) : undefined, multiple: field.multiple, referenceMode: field.referenceMode,
      variableName: field.variableName, codeListId: field.codeList ? plan.keys.get(`codeList:${field.codeList}`) : undefined, sensitivity: field.sensitivity ?? format.sensitivity,
    };
  }

  private unitInput(plan: Plan, unit: PackageUnit): CollectionUnitInput {
    const baseUnitId = unit.base?.startsWith('local:') ? plan.keys.get(`unit:${unit.base.slice(6)}`) : unit.base;
    return { name: localized(unit.name, plan.language), symbol: unit.symbol, dimension: unit.dimension, baseUnitId, factor: unit.factor, objectFormatId: unit.objectFormat ? plan.keys.get(`format:${unit.objectFormat}`) : undefined };
  }

  private codes(list: PackageCodeList['codes']) {
    return list.map((code) => ({ code: code.code, labelEn: localized(code.label, 'en'), labelFr: localized(code.label, 'fr'), parentCode: code.parent, active: code.active !== false }));
  }

  private async apply(plan: Plan, userId: string, collectionName: string | undefined, createdEntries: string[], state: { collectionId?: string }): Promise<string> {
    const language = plan.language;
    const label = (item: { name: PackageText }) => localized(item.name, language);
    const unitsToAdd = new Map(plan.units.map((unit) => [unit.key, unit]));
    const formatsToAdd = new Map(plan.formats.map((format) => [format.key, format]));
    let collection: Collection;
    if (plan.collection) collection = plan.collection;
    else {
      // A new collection starts with one independent data format, every code list and the units it needs.
      const first = plan.formats.find((format) => format.fields.every((field) => !field.target && !field.unit?.startsWith('local:')))!;
      const name = (collectionName ?? '').trim() || localized(plan.pkg.name, language);
      const codeLists = plan.codeLists.map((list) => { const id = randomUUID(); plan.keys.set(`codeList:${list.key}`, id); return { id, name: label(list), codes: this.codes(list.codes) }; });
      collection = await this.collections.create({ name, formats: [{ name: label(first), color: plan.colors.get(first.key)!, objectModel: first.objectModel, sensitivity: first.sensitivity, fields: first.fields.map((field) => this.fieldInput(plan, first, field)) }], codeLists }, userId);
      this.mapFormat(plan, first, collection.formats[0]);
      formatsToAdd.delete(first.key);
      plan.codeLists = [];
    }
    const collectionId = collection.id as string;
    state.collectionId = collectionId;
    for (const list of plan.codeLists) {
      collection = await this.classification.save(collectionId, userId, undefined, undefined, label(list), this.codes(list.codes));
      plan.keys.set(`codeList:${list.key}`, collection.codeLists.find((item) => lower(item.name) === lower(label(list)))!.id);
    }
    for (const { list, codes } of plan.newCodes) {
      const local = collection.codeLists.find((item) => item.id === plan.keys.get(`codeList:${list.key}`))!;
      const existing = local.codes.map((code) => ({ code: code.code, labelEn: code.labelEn, labelFr: code.labelFr, parentCode: code.parentCode, active: code.active, mergedInto: code.mergedInto }));
      collection = await this.classification.save(collectionId, userId, local.id, local.version, local.name, [...existing, ...this.codes(codes)]);
    }
    const inProgress = new Set<string>();
    const ensureUnit = async (key: string): Promise<void> => {
      const unit = unitsToAdd.get(key);
      if (!unit || plan.keys.has(`unit:${key}`)) return;
      if (inProgress.has(`unit:${key}`)) throw new BadRequestException('Package units and data formats depend on each other in a cycle');
      inProgress.add(`unit:${key}`);
      if (unit.base?.startsWith('local:')) await ensureUnit(unit.base.slice(6));
      if (unit.objectFormat) await ensureFormat(unit.objectFormat);
      const before = new Set(collection.units.map((item) => item.id));
      collection = await this.collections.saveUnit(collectionId, this.unitInput(plan, unit), userId);
      plan.keys.set(`unit:${key}`, collection.units.find((item) => !before.has(item.id))!.id);
    };
    const ensureFormat = async (key: string): Promise<void> => {
      const format = formatsToAdd.get(key);
      if (!format || plan.keys.has(`format:${key}`)) return;
      if (inProgress.has(`format:${key}`)) throw new BadRequestException('Package units and data formats depend on each other in a cycle');
      inProgress.add(`format:${key}`);
      for (const field of format.fields) {
        if (field.target) await ensureFormat(field.target);
        if (field.unit?.startsWith('local:')) await ensureUnit(field.unit.slice(6));
      }
      collection = await this.collections.addFormat(collectionId, { name: label(format), color: plan.colors.get(key)!, objectModel: format.objectModel, sensitivity: format.sensitivity, fields: format.fields.map((field) => this.fieldInput(plan, format, field)) }, userId);
      this.mapFormat(plan, format, collection.formats.at(-1)!);
    };
    for (const key of formatsToAdd.keys()) await ensureFormat(key);
    for (const key of unitsToAdd.keys()) await ensureUnit(key);
    const byFormat = new Map<string, { format: PackageFormat; fields: PackageField[] }>();
    for (const { format, field } of plan.fields) {
      if (field.target) await ensureFormat(field.target);
      if (field.unit?.startsWith('local:')) await ensureUnit(field.unit.slice(6));
      byFormat.set(format.key, { format, fields: [...(byFormat.get(format.key)?.fields ?? []), field] });
    }
    for (const { format, fields } of byFormat.values()) {
      const local = collection.formats.find((item) => item.id === plan.keys.get(`format:${format.key}`))!;
      const existing = local.fields.map((field) => ({ id: field.id, name: field.name, kind: field.kind, unit: field.unit, options: field.options, targetObjectFormatId: field.targetObjectFormatId, multiple: field.multiple, variableName: field.variableName, referenceMode: field.referenceMode, codeListId: field.codeListId, sensitivity: field.sensitivity }));
      collection = await this.collections.updateFormat(collectionId, local.id, { name: local.name, expectedVersion: local.version ?? 1, fields: [...existing, ...fields.map((field) => this.fieldInput(plan, format, field))] }, userId);
      const updated = collection.formats.find((item) => item.id === local.id)!;
      const added = updated.fields.filter((field) => !local.fields.some((item) => item.id === field.id));
      fields.forEach((field, index) => plan.keys.set(`field:${format.key}.${field.key}`, added[index].id));
    }
    const field = (ref?: string) => ref ? plan.keys.get(`field:${ref}`) : undefined;
    for (const view of plan.views) {
      const before = new Set((collection.savedViews ?? []).map((item) => item.id));
      collection = await this.collections.saveView(collectionId, userId, {
        name: label(view), layout: view.layout, formatIds: view.dataFormats.map((key) => plan.keys.get(`format:${key}`)!), columnFieldIds: view.columns.map((ref) => field(ref)!), sort: view.sort,
        manualOrderFieldIds: view.manualOrder?.map((ref) => field(ref)!), groupByFormat: view.groupByFormat ?? false,
        taskDoneFieldId: field(view.task?.done), taskDueFieldId: field(view.task?.due), taskCompletedFieldId: field(view.task?.completed), taskPriorityFieldId: field(view.task?.priority),
        calendarStartFieldId: field(view.calendar?.start), calendarEndFieldId: field(view.calendar?.end), calendarTimeZone: view.calendar ? view.calendar.timeZone ?? 'UTC' : undefined,
      });
      plan.keys.set(`view:${view.key}`, collection.savedViews.find((item) => !before.has(item.id))!.id);
    }
    for (const formula of plan.formulas) {
      const format = plan.pkg.content.dataFormats.find((item) => item.key === formula.dataFormat)!;
      // Keys are unique per data format only, so each step is resolved in the format the previous step points to.
      const path = (node: Record<string, unknown>): { steps: string[]; last?: PackageField } => {
        let last = format.fields.find((item) => item.key === node.referenceFieldId);
        const steps = ((node.through ?? []) as string[]).map((step) => {
          const owner = last?.target;
          last = plan.pkg.content.dataFormats.find((item) => item.key === owner)?.fields.find((item) => item.key === step);
          return field(`${owner}.${step}`) ?? '';
        });
        return { steps, last };
      };
      const map = (node: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(node).map(([name, value]) => {
        if (['fieldId', 'referenceFieldId', 'fromFieldId', 'toFieldId'].includes(name)) return [name, field(`${format.key}.${value as string}`) ?? ''];
        if (name === 'through' && Array.isArray(value)) return [name, path(node).steps];
        if (name === 'propertyFieldId') return [name, field(`${path(node).last?.target}.${value as string}`) ?? ''];
        if (name === 'formulaId') return [name, plan.keys.get(`formula:${value as string}`) ?? ''];
        if (name === 'unit' && typeof value === 'string' && value.startsWith('local:')) return [name, plan.keys.get(`unit:${value.slice(6)}`) ?? ''];
        if (name === 'args' && Array.isArray(value)) return [name, value.map((child) => map(child as Record<string, unknown>))];
        if (formulaChildKeys.includes(name) && value && typeof value === 'object') return [name, map(value as Record<string, unknown>)];
        return [name, value];
      }));
      const formatId = plan.keys.get(`format:${formula.dataFormat}`)!;
      collection = await this.analysis.saveFormula(collectionId, userId, { name: label(formula), formatId, expression: JSON.stringify(map(formula.expression)) });
      plan.keys.set(`formula:${formula.key}`, collection.formulas.find((item) => item.formatId === formatId && lower(item.name) === lower(label(formula)))!.id);
    }
    for (const item of plan.stockRules) {
      const ref = (key?: string) => key ? field(`${item.dataFormat}.${key}`) : undefined;
      collection = await this.stock.saveRule(collectionId, userId, { name: label(item), formatId: plan.keys.get(`format:${item.dataFormat}`)!, kind: item.kind, productFieldId: ref(item.product)!, quantityFieldId: ref(item.quantity)!, dateFieldId: ref(item.date), priceFieldId: ref(item.price), reasonFieldId: ref(item.reason), fromLocationFieldId: ref(item.from), toLocationFieldId: ref(item.to), lotFieldId: ref(item.lot), packageFactor: item.packageFactor });
      plan.keys.set(`stockRule:${item.key}`, collection.stockRules.find((rule) => lower(rule.name) === lower(label(item)))!.id);
    }
    for (const object of plan.objects) {
      const format = plan.pkg.content.dataFormats.find((item) => item.key === object.dataFormat)!;
      const values = Object.entries(object.values).map(([key, value]) => ({ fieldId: field(`${format.key}.${key}`)!, value: localized(value, language) }));
      const entry = await this.collections.createEntry(collectionId, values, plan.keys.get(`format:${format.key}`), userId);
      createdEntries.push(entry.id as string);
    }
    return collectionId;
  }

  private mapFormat(plan: Plan, format: PackageFormat, local: CollectionFormat): void {
    plan.keys.set(`format:${format.key}`, local.id);
    format.fields.forEach((field, index) => plan.keys.set(`field:${format.key}.${field.key}`, local.fields[index].id));
  }
}

export type { DomainPackageKey };
