import { BadRequestException } from '@nestjs/common';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { FieldKind, SensitivityLevel } from './collection.schema';
import { formulaChildKeys } from './formula_nodes';
import { builtInUnits } from './unit_math';

export const PACKAGE_FORMAT = 'brainy.domain-package';
export const PACKAGE_SCHEMA_VERSION = 1;
export const MAX_PACKAGE_BYTES = 512 * 1024;

export type PackageText = string | { en: string; fr: string };
export type PackageField = { key: string; name: PackageText; kind: FieldKind; unit?: string; options?: PackageText[]; codeList?: string; target?: string; multiple?: boolean; referenceMode?: 'CURRENT' | 'SNAPSHOT'; variableName?: string; sensitivity?: SensitivityLevel };
export type PackageFormat = { key: string; name: PackageText; color?: string; objectModel?: boolean; sensitivity?: SensitivityLevel; fields: PackageField[] };
export type PackageUnit = { key: string; name: PackageText; symbol: string; dimension: string; base?: string; factor: string; objectFormat?: string };
export type PackageCode = { code: string; label: PackageText; parent?: string; active?: boolean };
export type PackageCodeList = { key: string; name: PackageText; codes: PackageCode[] };
export type PackageObject = { dataFormat: string; values: Record<string, PackageText> };
export type PackageView = { key: string; name: PackageText; layout: string; dataFormats: string[]; columns: string[]; sort: string; groupByFormat?: boolean; manualOrder?: string[]; task?: { done?: string; due?: string; completed?: string; priority?: string }; calendar?: { start: string; end?: string; timeZone?: string } };
export type PackageFormula = { key: string; name: PackageText; dataFormat: string; expression: Record<string, unknown> };
export type PackageStockRule = { key: string; name: PackageText; dataFormat: string; kind: string; product: string; quantity: string; date?: string; price?: string; reason?: string; from?: string; to?: string; lot?: string; packageFactor?: string };
export type PackageSignature = { algorithm: 'ed25519'; publicKey: string; value: string };
export type DomainPackage = {
  format: typeof PACKAGE_FORMAT; schemaVersion: number; id: string; version: string;
  name: PackageText; description?: PackageText; notice?: PackageText;
  provenance: { author: string; license: string; publishedAt: string; homepage?: string; signature?: PackageSignature };
  content: { units: PackageUnit[]; codeLists: PackageCodeList[]; dataFormats: PackageFormat[]; exampleObjects: PackageObject[]; views: PackageView[]; formulas: PackageFormula[]; stockRules: PackageStockRule[] };
};

const forbiddenCode = new Set(['script', 'scripts', 'js', 'javascript', 'wasm', 'exec', 'command', 'commands', 'hook', 'hooks', 'oninstall', 'postinstall', 'function', 'eval', 'plugin', 'binary']);
const forbiddenData = new Set(['entries', 'entry', 'attachments', 'attachment', 'attachmentdata', 'members', 'owner', 'ownerid', 'users', 'exchangerates', 'sharedobjects', 'contributions', 'submissions']);
const exampleKinds = new Set([FieldKind.TITLE, FieldKind.TEXT, FieldKind.LONG_TEXT, FieldKind.NUMBER, FieldKind.LINK, FieldKind.SELECT, FieldKind.BOOLEAN, FieldKind.DATE, FieldKind.CHARACTER]);
const keyPattern = /^[A-Za-z0-9_.-]{1,64}$/;

const fail = (message: string): never => { throw new BadRequestException(message); };

function record(value: unknown, path: string, allowed: string[], required: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} must be an object`);
  const item = value as Record<string, unknown>;
  for (const key of Object.keys(item)) {
    const lower = key.toLowerCase();
    if (forbiddenCode.has(lower)) fail('Domain packages cannot contain executable code');
    if (forbiddenData.has(lower)) fail('Domain packages cannot contain user entries, members or private files');
    if (!allowed.includes(key)) fail(`Unknown property ${path}.${key}`);
  }
  for (const key of required) if (item[key] === undefined) fail(`Missing property ${path}.${key}`);
  return item;
}

function text(value: unknown, path: string, max = 80, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return fail(`${path} must be a text of 1 to ${max} characters`);
  return value;
}

function label(value: unknown, path: string, max = 80, optional = false): PackageText | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value === 'string') return text(value, path, max);
  const item = record(value, path, ['en', 'fr'], ['en', 'fr']);
  return { en: text(item.en, `${path}.en`, max)!, fr: text(item.fr, `${path}.fr`, max)! };
}

function key(value: unknown, path: string): string {
  if (typeof value !== 'string' || !keyPattern.test(value)) fail(`${path} must be a key of letters, digits, dot, dash or underscore`);
  return value as string;
}

function list(value: unknown, path: string, max: number): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) fail(`${path} must be a list of at most ${max} items`);
  return value as unknown[];
}

function unique(keys: string[], path: string): void {
  if (new Set(keys.map((item) => item.toLowerCase())).size !== keys.length) fail(`Keys in ${path} must be unique`);
}

export function localized(value: PackageText | undefined, language: string): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : language === 'fr' ? value.fr : value.en;
}

export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  return 0;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((item) => `${JSON.stringify(item)}:${canonical((value as Record<string, unknown>)[item])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Bytes covered by a package signature: canonical JSON (sorted keys) of the raw package without provenance.signature. */
export function signedPayload(raw: Record<string, unknown>): string {
  const { signature: _signature, ...provenance } = (raw.provenance ?? {}) as Record<string, unknown>;
  return canonical({ ...raw, provenance });
}

/** Call only after parseDomainPackage(source) succeeded. */
export function signatureStatus(source: string): { status: 'NONE' | 'VALID' | 'INVALID'; fingerprint?: string } {
  const raw = JSON.parse(source) as Record<string, unknown>;
  const signature = (raw.provenance as { signature?: PackageSignature }).signature;
  if (!signature) return { status: 'NONE' };
  const fingerprint = createHash('sha256').update(signature.publicKey).digest('hex').slice(0, 16);
  try {
    const publicKey = createPublicKey({ key: Buffer.from(signature.publicKey, 'base64'), format: 'der', type: 'spki' });
    return { status: verify(null, Buffer.from(signedPayload(raw)), publicKey, Buffer.from(signature.value, 'base64')) ? 'VALID' : 'INVALID', fingerprint };
  } catch {
    return { status: 'INVALID', fingerprint };
  }
}

function expression(node: unknown, path: string, depth = 0, budget = { count: 0 }): Record<string, unknown> {
  if (++budget.count > 64 || depth > 12) fail('Formula is too complex');
  const item = record(node, path, ['kind', 'value', 'unit', 'fieldId', 'referenceFieldId', 'propertyFieldId', 'formulaId', 'fromFieldId', 'toFieldId', 'digits', 'mode', 'operator', 'args', 'condition', 'then', 'else', 'left', 'right', 'arg', 'date', 'days', 'end', 'start', 'duration', 'part', 'text', 'length', 'pattern', 'locale', 'through'], ['kind']);
  for (const [name, value] of Object.entries(item)) {
    if (name === 'args') list(value, `${path}.args`, 64).forEach((child, index) => expression(child, `${path}.args[${index}]`, depth + 1, budget));
    else if (name === 'through') list(value, `${path}.through`, 4).forEach((step, index) => text(step, `${path}.through[${index}]`, 64));
    else if (formulaChildKeys.includes(name) && typeof value === 'object') expression(value, `${path}.${name}`, depth + 1, budget);
    else if (name === 'value' && typeof value === 'boolean') continue;
    // A literal may legitimately be empty or a single space, such as a separator.
    else if (name === 'value' && item.kind === 'textLiteral') { if (typeof value !== 'string' || value.length > 1000) fail(`${path}.value must be a text of at most 1000 characters`); }
    else if (name === 'digits') { if (!Number.isInteger(value)) fail(`${path}.digits must be an integer`); }
    else text(value, `${path}.${name}`, 64);
  }
  return item;
}

function field(value: unknown, path: string): PackageField {
  const item = record(value, path, ['key', 'name', 'kind', 'unit', 'options', 'codeList', 'target', 'multiple', 'referenceMode', 'variableName', 'sensitivity'], ['key', 'name', 'kind']);
  if (!Object.values(FieldKind).includes(item.kind as FieldKind)) fail(`Field kind ${String(item.kind)} is not supported by this Brainy version`);
  if (item.sensitivity !== undefined && !Object.values(SensitivityLevel).includes(item.sensitivity as SensitivityLevel)) fail(`${path}.sensitivity is not a sensitivity level`);
  if (item.referenceMode !== undefined && !['CURRENT', 'SNAPSHOT'].includes(item.referenceMode as string)) fail(`${path}.referenceMode must be CURRENT or SNAPSHOT`);
  if (item.multiple !== undefined && typeof item.multiple !== 'boolean') fail(`${path}.multiple must be true or false`);
  return {
    key: key(item.key, `${path}.key`), name: label(item.name, `${path}.name`)!, kind: item.kind as FieldKind,
    unit: text(item.unit, `${path}.unit`, 70, true), options: item.options === undefined ? undefined : list(item.options, `${path}.options`, 30).map((option, index) => label(option, `${path}.options[${index}]`)!),
    codeList: item.codeList === undefined ? undefined : key(item.codeList, `${path}.codeList`), target: item.target === undefined ? undefined : key(item.target, `${path}.target`),
    multiple: item.multiple as boolean | undefined, referenceMode: item.referenceMode as PackageField['referenceMode'], variableName: text(item.variableName, `${path}.variableName`, 40, true), sensitivity: item.sensitivity as SensitivityLevel | undefined,
  };
}

/** Parses and validates a package; throws a clear BadRequestException when incompatible or unsafe. */
export function parseDomainPackage(source: string): DomainPackage {
  if (Buffer.byteLength(source, 'utf8') > MAX_PACKAGE_BYTES) fail('Domain package is larger than 512 KiB');
  let raw: unknown;
  try { raw = JSON.parse(source); } catch { fail('This file is not valid JSON'); }
  if (!raw || typeof raw !== 'object' || (raw as Record<string, unknown>).format !== PACKAGE_FORMAT) fail('This file is not a Brainy domain package');
  const version = (raw as Record<string, unknown>).schemaVersion;
  if (!Number.isInteger(version) || (version as number) < 1) fail('Domain package format version is missing or invalid');
  if (version !== PACKAGE_SCHEMA_VERSION) fail(`This package uses package format ${String(version)}; this Brainy version reads format ${PACKAGE_SCHEMA_VERSION}. Update Brainy or ask the author for a compatible version`);
  const root = record(raw, 'package', ['format', 'schemaVersion', 'id', 'version', 'name', 'description', 'notice', 'provenance', 'content'], ['id', 'version', 'name', 'provenance', 'content']);
  if (typeof root.id !== 'string' || !/^[a-z0-9][a-z0-9.-]{2,80}$/.test(root.id)) fail('Package id must use lowercase letters, digits, dots or dashes');
  if (typeof root.version !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(root.version)) fail('Package version must look like 1.2.0');
  const provenance = record(root.provenance, 'provenance', ['author', 'license', 'publishedAt', 'homepage', 'signature'], ['author', 'license', 'publishedAt']);
  if (typeof provenance.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(provenance.publishedAt) || Number.isNaN(Date.parse(provenance.publishedAt))) fail('provenance.publishedAt must be a date like 2026-11-07');
  if (typeof provenance.homepage === 'string' && !/^https:\/\/\S{1,300}$/.test(provenance.homepage)) fail('provenance.homepage must be an https link');
  let signature: PackageSignature | undefined;
  if (provenance.signature !== undefined) {
    const item = record(provenance.signature, 'provenance.signature', ['algorithm', 'publicKey', 'value'], ['algorithm', 'publicKey', 'value']);
    if (item.algorithm !== 'ed25519') fail('Only ed25519 package signatures are supported');
    signature = { algorithm: 'ed25519', publicKey: text(item.publicKey, 'signature.publicKey', 200)!, value: text(item.value, 'signature.value', 200)! };
  }
  const content = record(root.content, 'content', ['units', 'codeLists', 'dataFormats', 'exampleObjects', 'views', 'formulas', 'stockRules'], ['dataFormats']);
  const dataFormats = list(content.dataFormats, 'dataFormats', 24).map((value, index): PackageFormat => {
    const path = `dataFormats[${index}]`;
    const item = record(value, path, ['key', 'name', 'color', 'objectModel', 'sensitivity', 'fields'], ['key', 'name', 'fields']);
    const fields = list(item.fields, `${path}.fields`, 30).map((child, childIndex) => field(child, `${path}.fields[${childIndex}]`));
    if (!fields.length) fail(`${path} needs at least one field`);
    unique(fields.map((child) => child.key), `${path}.fields`);
    if (item.color !== undefined && (typeof item.color !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(item.color))) fail(`${path}.color must look like #EEF5FF`);
    if (item.sensitivity !== undefined && !Object.values(SensitivityLevel).includes(item.sensitivity as SensitivityLevel)) fail(`${path}.sensitivity is not a sensitivity level`);
    return { key: key(item.key, `${path}.key`), name: label(item.name, `${path}.name`)!, color: item.color as string | undefined, objectModel: item.objectModel === true, sensitivity: item.sensitivity as SensitivityLevel | undefined, fields };
  });
  if (!dataFormats.length) fail('A domain package needs at least one data format');
  unique(dataFormats.map((item) => item.key), 'dataFormats');
  const units = list(content.units, 'units', 100).map((value, index): PackageUnit => {
    const path = `units[${index}]`;
    const item = record(value, path, ['key', 'name', 'symbol', 'dimension', 'base', 'factor', 'objectFormat'], ['key', 'name', 'symbol', 'dimension', 'factor']);
    return { key: key(item.key, `${path}.key`), name: label(item.name, `${path}.name`)!, symbol: text(item.symbol, `${path}.symbol`, 24)!, dimension: text(item.dimension, `${path}.dimension`, 40)!, base: text(item.base, `${path}.base`, 70, true), factor: text(item.factor, `${path}.factor`, 40)!, objectFormat: item.objectFormat === undefined ? undefined : key(item.objectFormat, `${path}.objectFormat`) };
  });
  unique(units.map((item) => item.key), 'units');
  const codeLists = list(content.codeLists, 'codeLists', 100).map((value, index): PackageCodeList => {
    const path = `codeLists[${index}]`;
    const item = record(value, path, ['key', 'name', 'codes'], ['key', 'name', 'codes']);
    const codes = list(item.codes, `${path}.codes`, 5000).map((child, childIndex) => {
      const code = record(child, `${path}.codes[${childIndex}]`, ['code', 'label', 'parent', 'active'], ['code', 'label']);
      return { code: text(code.code, `${path}.codes[${childIndex}].code`, 100)!, label: label(code.label, `${path}.codes[${childIndex}].label`, 200)!, parent: text(code.parent, `${path}.codes[${childIndex}].parent`, 100, true), active: code.active === false ? false : undefined };
    });
    return { key: key(item.key, `${path}.key`), name: label(item.name, `${path}.name`)!, codes };
  });
  unique(codeLists.map((item) => item.key), 'codeLists');
  const formatByKey = new Map(dataFormats.map((item) => [item.key, item]));
  const fieldOf = (formatKey: string, fieldKey: string | undefined, path: string): PackageField | undefined => {
    if (fieldKey === undefined) return undefined;
    const found = formatByKey.get(formatKey)?.fields.find((item) => item.key === fieldKey);
    return found ?? fail(`${path} refers to unknown field ${formatKey}.${fieldKey}`);
  };
  const unitKeys = new Set(units.map((item) => item.key));
  const unitRef = (value: string | undefined, path: string): void => {
    if (value === undefined) return;
    if (value.startsWith('local:') ? !unitKeys.has(value.slice(6)) : !builtInUnits.some((unit) => unit.id === value)) fail(`${path} refers to unknown unit ${value}`);
  };
  for (const unit of units) {
    unitRef(unit.base, `units.${unit.key}.base`);
    if (unit.objectFormat && !formatByKey.get(unit.objectFormat)?.objectModel) fail(`units.${unit.key}.objectFormat must be an object data format of the package`);
  }
  for (const format of dataFormats) for (const item of format.fields) {
    const path = `${format.key}.${item.key}`;
    unitRef(item.unit, `${path}.unit`);
    if (item.kind === FieldKind.OBJECT_REF && !formatByKey.get(item.target ?? '')?.objectModel) fail(`${path} must target an object data format of the package`);
    if (item.kind === FieldKind.CODE && !codeLists.some((listItem) => listItem.key === item.codeList)) fail(`${path} must use a code list of the package`);
  }
  // Object references must form an acyclic graph so formats can be created in order.
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (formatKey: string): void => {
    if (done.has(formatKey)) return;
    if (visiting.has(formatKey)) fail('Object references between data formats form a cycle');
    visiting.add(formatKey);
    for (const item of formatByKey.get(formatKey)!.fields) if (item.target) visit(item.target);
    visiting.delete(formatKey);
    done.add(formatKey);
  };
  dataFormats.forEach((item) => visit(item.key));
  const exampleObjects = list(content.exampleObjects, 'exampleObjects', 50).map((value, index): PackageObject => {
    const path = `exampleObjects[${index}]`;
    const item = record(value, path, ['dataFormat', 'values'], ['dataFormat', 'values']);
    const format = formatByKey.get(key(item.dataFormat, `${path}.dataFormat`));
    if (!format?.objectModel) fail(`${path} must use an object data format of the package`);
    const values = record(item.values, `${path}.values`, format!.fields.map((child) => child.key));
    for (const fieldKey of Object.keys(values)) {
      if (!exampleKinds.has(fieldOf(format!.key, fieldKey, path)!.kind)) fail(`${path}.${fieldKey}: example objects only hold text, numbers, choices, dates and links`);
      label(values[fieldKey], `${path}.values.${fieldKey}`, 500);
    }
    return { dataFormat: format!.key, values: values as Record<string, PackageText> };
  });
  const columnRef = (value: unknown, path: string): string => {
    const ref = text(value, path, 130)!;
    const [formatKey, fieldKey] = ref.split('.');
    fieldOf(formatKey, fieldKey ?? '', path);
    return ref;
  };
  const views = list(content.views, 'views', 20).map((value, index): PackageView => {
    const path = `views[${index}]`;
    const item = record(value, path, ['key', 'name', 'layout', 'dataFormats', 'columns', 'sort', 'groupByFormat', 'manualOrder', 'task', 'calendar'], ['key', 'name', 'layout', 'dataFormats', 'columns', 'sort']);
    if (!['LIST', 'TABLE', 'CARDS', 'TASKS', 'CALENDAR'].includes(item.layout as string)) fail(`${path}.layout is not a view layout`);
    if (!['NEWEST', 'OLDEST', 'MANUAL'].includes(item.sort as string)) fail(`${path}.sort must be NEWEST, OLDEST or MANUAL`);
    const formats = list(item.dataFormats, `${path}.dataFormats`, 24).map((child) => { const formatKey = key(child, `${path}.dataFormats`); if (!formatByKey.has(formatKey)) fail(`${path} uses unknown data format ${formatKey}`); return formatKey; });
    const task = item.task === undefined ? undefined : record(item.task, `${path}.task`, ['done', 'due', 'completed', 'priority']);
    const calendar = item.calendar === undefined ? undefined : record(item.calendar, `${path}.calendar`, ['start', 'end', 'timeZone'], ['start']);
    return {
      key: key(item.key, `${path}.key`), name: label(item.name, `${path}.name`)!, layout: item.layout as string, dataFormats: formats,
      columns: list(item.columns, `${path}.columns`, 100).map((child, childIndex) => columnRef(child, `${path}.columns[${childIndex}]`)), sort: item.sort as string, groupByFormat: item.groupByFormat === true,
      manualOrder: item.manualOrder === undefined ? undefined : list(item.manualOrder, `${path}.manualOrder`, 24).map((child, childIndex) => columnRef(child, `${path}.manualOrder[${childIndex}]`)),
      task: task && Object.fromEntries(Object.entries(task).map(([name, ref]) => [name, columnRef(ref, `${path}.task.${name}`)])),
      calendar: calendar && { start: columnRef(calendar.start, `${path}.calendar.start`), end: calendar.end === undefined ? undefined : columnRef(calendar.end, `${path}.calendar.end`), timeZone: text(calendar.timeZone, `${path}.calendar.timeZone`, 64, true) },
    };
  });
  unique(views.map((item) => item.key), 'views');
  const formulas = list(content.formulas, 'formulas', 50).map((value, index): PackageFormula => {
    const path = `formulas[${index}]`;
    const item = record(value, path, ['key', 'name', 'dataFormat', 'expression'], ['key', 'name', 'dataFormat', 'expression']);
    const formatKey = key(item.dataFormat, `${path}.dataFormat`);
    if (!formatByKey.has(formatKey)) fail(`${path} uses unknown data format ${formatKey}`);
    return { key: key(item.key, `${path}.key`), name: label(item.name, `${path}.name`)!, dataFormat: formatKey, expression: expression(item.expression, `${path}.expression`) };
  });
  unique(formulas.map((item) => item.key), 'formulas');
  const stockRules = list(content.stockRules, 'stockRules', 50).map((value, index): PackageStockRule => {
    const path = `stockRules[${index}]`;
    const item = record(value, path, ['key', 'name', 'dataFormat', 'kind', 'product', 'quantity', 'date', 'price', 'reason', 'from', 'to', 'lot', 'packageFactor'], ['key', 'name', 'dataFormat', 'kind', 'product', 'quantity']);
    const formatKey = key(item.dataFormat, `${path}.dataFormat`);
    if (!formatByKey.has(formatKey)) fail(`${path} uses unknown data format ${formatKey}`);
    for (const name of ['product', 'quantity', 'date', 'price', 'reason', 'from', 'to', 'lot']) if (item[name] !== undefined) fieldOf(formatKey, key(item[name], `${path}.${name}`), `${path}.${name}`);
    return { key: key(item.key, `${path}.key`), name: label(item.name, `${path}.name`)!, dataFormat: formatKey, kind: text(item.kind, `${path}.kind`, 20)!, product: item.product as string, quantity: item.quantity as string, date: item.date as string | undefined, price: item.price as string | undefined, reason: item.reason as string | undefined, from: item.from as string | undefined, to: item.to as string | undefined, lot: item.lot as string | undefined, packageFactor: text(item.packageFactor, `${path}.packageFactor`, 40, true) };
  });
  unique(stockRules.map((item) => item.key), 'stockRules');
  return {
    format: PACKAGE_FORMAT, schemaVersion: PACKAGE_SCHEMA_VERSION, id: root.id as string, version: root.version as string,
    name: label(root.name, 'name')!, description: label(root.description, 'description', 400, true), notice: label(root.notice, 'notice', 4000, true),
    provenance: { author: text(provenance.author, 'provenance.author', 120)!, license: text(provenance.license, 'provenance.license', 80)!, publishedAt: provenance.publishedAt as string, homepage: provenance.homepage as string | undefined, signature },
    content: { units, codeLists, dataFormats, exampleObjects, views, formulas, stockRules },
  };
}
