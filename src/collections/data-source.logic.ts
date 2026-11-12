// T32 — pure rules for data sources: parsing deliveries and turning rows into entry inputs.
// No database access here so the rules stay testable and the service stays small.
import { EntryValueInput } from './collection.input.js';
import { CollectionFormat, FieldKind } from './collection.schema.js';
import { EntryValue } from './entry.schema.js';

export const DATA_SOURCE_KINDS = new Set<FieldKind>([
  FieldKind.TITLE, FieldKind.TEXT, FieldKind.LONG_TEXT, FieldKind.CHARACTER, FieldKind.LINK,
  FieldKind.DATE, FieldKind.DATETIME, FieldKind.TIME, FieldKind.DURATION, FieldKind.NUMBER,
  FieldKind.MEASURE, FieldKind.BOOLEAN, FieldKind.SELECT, FieldKind.CODE,
]);
export const MAX_DELIVERY_ROWS = 10_000;
export const MAX_DELIVERY_BYTES = 4_000_000;

export type RejectionCode = 'MISSING_RECORD_ID' | 'DUPLICATE_IN_DELIVERY' | 'EMPTY_ROW' | 'INVALID_OBSERVED_AT' | 'UNIT_MISMATCH' | 'INVALID_VALUE' | 'LOCKED_ENTRY' | 'COLUMN_COUNT' | 'CHANGED_DURING_RUN';

export interface SourceMapping { column: string; fieldId: string; unitColumn?: string }
export interface SourceConfig {
  recordIdColumn: string;
  observedAtColumn?: string;
  qualityColumn?: string;
  statusColumn?: string;
  decimalSeparator: string;
  delimiter: string;
  mappings: SourceMapping[];
}
export interface ParsedDelivery { header: string[]; rows: string[][] }
export interface PreparedRow { recordId: string; observedAt?: Date; inputs: EntryValueInput[]; units: Map<string, string> }
export interface RowRejection { code: RejectionCode; message: string }

export class DeliveryError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

/** RFC 4180 CSV with a chosen delimiter; strips a BOM and a trailing empty line. */
export function parseCsv(text: string, delimiter: string): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { cell += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === '') quoted = true;
    else if (char === delimiter) { row.push(cell); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (quoted) throw new DeliveryError('INVALID_CSV', 'A quoted CSV value is not closed');
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((item) => !(item.length === 1 && item[0] === ''));
}

export function parseDelivery(content: string, contentType: string, delimiter: string): ParsedDelivery {
  if (Buffer.byteLength(content, 'utf8') > MAX_DELIVERY_BYTES) throw new DeliveryError('TOO_LARGE', 'A delivery cannot exceed 4 MB');
  let header: string[];
  let rows: string[][];
  if (contentType === 'text/csv') {
    const all = parseCsv(content, delimiter);
    if (!all.length) throw new DeliveryError('EMPTY', 'The delivery has no header');
    header = all[0].map((item) => item.trim());
    rows = all.slice(1);
  } else if (contentType === 'application/json') {
    let data: unknown;
    try { data = JSON.parse(content); } catch { throw new DeliveryError('INVALID_JSON', 'The delivery is not valid JSON'); }
    if (!Array.isArray(data)) throw new DeliveryError('INVALID_JSON', 'Send a JSON array of objects');
    header = [];
    const seen = new Set<string>();
    for (const item of data) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new DeliveryError('INVALID_JSON', 'Each JSON row must be an object');
      for (const [key, value] of Object.entries(item as Record<string, unknown>)) {
        if (value !== null && typeof value === 'object') throw new DeliveryError('INVALID_JSON', `Column ${key} must hold text, a number or yes/no`);
        if (!seen.has(key)) { seen.add(key); header.push(key); }
      }
    }
    rows = (data as Record<string, unknown>[]).map((item) => header.map((key) => (item[key] === null || item[key] === undefined ? '' : String(item[key]))));
  } else throw new DeliveryError('UNSUPPORTED_TYPE', 'Send text/csv or application/json');
  if (new Set(header).size !== header.length || header.some((item) => !item)) throw new DeliveryError('INVALID_HEADER', 'Column names must be present and distinct');
  if (!rows.length || rows.length > MAX_DELIVERY_ROWS) throw new DeliveryError('ROW_LIMIT', `Send 1 to ${MAX_DELIVERY_ROWS} rows per delivery`);
  return { header, rows };
}

export function requiredColumns(config: SourceConfig): string[] {
  return [...new Set([config.recordIdColumn, config.observedAtColumn, config.qualityColumn, config.statusColumn, ...config.mappings.flatMap((item) => [item.column, item.unitColumn])].filter((item): item is string => !!item))];
}

/** Columns the source does not read; reported so a changing feed stays visible. */
export function checkHeader(config: SourceConfig, header: string[]): string[] {
  const missing = requiredColumns(config).filter((column) => !header.includes(column));
  if (missing.length) throw new DeliveryError('MISSING_COLUMN', `Missing column: ${missing.join(', ')}`);
  const used = new Set(requiredColumns(config));
  return header.filter((column) => !used.has(column));
}

/** Later occurrences of a record ID in one delivery are rejected; the first one wins. */
export function duplicateRows(header: string[], rows: string[][], recordIdColumn: string): Set<number> {
  const index = header.indexOf(recordIdColumn);
  const seen = new Set<string>();
  const duplicates = new Set<number>();
  rows.forEach((row, position) => {
    const id = (row[index] ?? '').trim();
    if (!id) return;
    if (seen.has(id)) duplicates.add(position); else seen.add(id);
  });
  return duplicates;
}

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const truthy = new Set(['true', '1', 'yes', 'oui']);
const falsy = new Set(['false', '0', 'no', 'non']);

function normalizeNumber(raw: string, separator: string): string | undefined {
  if (separator === 'COMMA') return raw.includes('.') ? undefined : raw.replace(',', '.');
  return raw.includes(',') ? undefined : raw;
}

export function prepareRow(config: SourceConfig, format: CollectionFormat, header: string[], cells: string[]): PreparedRow | RowRejection {
  if (cells.length !== header.length) return { code: 'COLUMN_COUNT', message: `Expected ${header.length} values, found ${cells.length}` };
  const cell = (column?: string) => (column ? (cells[header.indexOf(column)] ?? '').trim() : '');
  const recordId = cell(config.recordIdColumn);
  if (!recordId) return { code: 'MISSING_RECORD_ID', message: `${config.recordIdColumn} is empty` };
  if (recordId.length > 100 || /[\x00-\x1f\x7f]/.test(recordId)) return { code: 'MISSING_RECORD_ID', message: 'Record ID must be 1 to 100 printable characters' };
  let observedAt: Date | undefined;
  const observedText = cell(config.observedAtColumn);
  if (observedText) {
    if (!isoDate.test(observedText) && !isoDateTime.test(observedText)) return { code: 'INVALID_OBSERVED_AT', message: 'Fact date must be YYYY-MM-DD or an ISO date and time with a time zone' };
    observedAt = new Date(isoDate.test(observedText) ? `${observedText}T00:00:00Z` : observedText);
    if (Number.isNaN(observedAt.getTime())) return { code: 'INVALID_OBSERVED_AT', message: 'Fact date is not a real date' };
  }
  const fields = new Map(format.fields.map((field) => [field.id, field]));
  const inputs: EntryValueInput[] = [];
  const units = new Map<string, string>();
  const status = cell(config.statusColumn).toUpperCase();
  for (const mapping of config.mappings) {
    const field = fields.get(mapping.fieldId);
    if (!field) continue;
    let value = cell(mapping.column);
    const absent = field.kind === FieldKind.MEASURE && status === 'ABSENT';
    if (!value && !absent) continue;
    if ((field.kind === FieldKind.NUMBER || field.kind === FieldKind.MEASURE) && value) {
      const normalized = normalizeNumber(value, config.decimalSeparator);
      if (normalized === undefined) return { code: 'INVALID_VALUE', message: `${field.name} uses the wrong decimal separator` };
      value = normalized;
    }
    if (field.kind === FieldKind.BOOLEAN) {
      const lower = value.toLowerCase();
      if (truthy.has(lower)) value = 'true'; else if (falsy.has(lower)) value = 'false';
      else return { code: 'INVALID_VALUE', message: `${field.name} must be yes or no` };
    }
    const input: EntryValueInput = { fieldId: field.id, value };
    if (field.kind === FieldKind.MEASURE) {
      input.measureValue = {
        status: status || undefined,
        quality: cell(config.qualityColumn) || undefined,
        observedAt: observedAt?.toISOString(),
      };
    }
    if (mapping.unitColumn) units.set(field.id, cell(mapping.unitColumn));
    inputs.push(input);
  }
  if (!inputs.length) return { code: 'EMPTY_ROW', message: 'No mapped value in this row' };
  return { recordId, observedAt, inputs, units };
}

/** A declared unit must name the field's own unit; no conversion is ever guessed. */
export function unitMismatch(units: Map<string, string>, values: EntryValue[], format: CollectionFormat): string | undefined {
  for (const [fieldId, declared] of units) {
    if (!declared) continue;
    const field = format.fields.find((item) => item.id === fieldId);
    const value = values.find((item) => item.fieldId === fieldId);
    const accepted = [field?.unit, value?.unitSnapshot?.symbol].filter(Boolean);
    if (!accepted.includes(declared)) return `${field?.name ?? fieldId}: received unit ${declared}, expected ${accepted[0] ?? 'no unit'}`;
  }
  return undefined;
}

const comparable = (value: EntryValue) => JSON.stringify([
  value.fieldId, value.value, value.unitSnapshot?.id ?? null,
  // The uncertainty type only matters with an uncertainty (the stored schema defaults it).
  value.measureValue ? [value.measureValue.status, value.measureValue.uncertainty || null, value.measureValue.uncertainty ? value.measureValue.uncertaintyType ?? null : null, value.measureValue.quality || null, value.measureValue.instrument || null,value.measureValue.observedAt ? new Date(value.measureValue.observedAt).toISOString() : null] : null,
]);

/** Same stored meaning, ignoring the reception timestamp of measures. */
export function sameValues(a: EntryValue[], b: EntryValue[]): boolean {
  if (a.length !== b.length) return false;
  const left = a.map(comparable).sort();
  const right = b.map(comparable).sort();
  return left.every((item, index) => item === right[index]);
}

/** Mapped fields replace stored ones; an empty cell never erases a stored value. */
export function mergeValues(existing: EntryValue[], incoming: EntryValue[]): EntryValue[] {
  const replaced = new Set(incoming.map((item) => item.fieldId));
  return [...existing.filter((item) => !replaced.has(item.fieldId)), ...incoming];
}

export function toCsv(header: string[], rows: string[][], delimiter: string): string {
  const quote = (value: string) => (/["\r\n]/.test(value) || value.includes(delimiter) ? `"${value.replace(/"/g, '""')}"` : value);
  return [header, ...rows].map((row) => row.map(quote).join(delimiter)).join('\n');
}
