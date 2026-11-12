import { BadRequestException } from '@nestjs/common';
import { ClassificationCode, ClassificationList } from './collection.schema.js';

const codePattern = /^[\p{L}\p{N}_.-]{1,64}$/u;
export const MAX_CODE_LEVELS = 8;
/** Lists up to this size stay inside the collection document; larger ones are stored apart (T39/3). */
export const EMBEDDED_CODE_LIMIT = 5000;
export const MAX_REFERENTIAL_CODES = 50_000;
/** Below Vercel's 4.5 MB request limit, with room for the rest of the request. */
export const MAX_REFERENTIAL_TEXT = 4_200_000;

type LinkedCode = Pick<ClassificationCode, 'code' | 'parentCode'>;
export type CodeHierarchyProblem = { code: string; message: string };

/** Level of every code and what is wrong with the tree, in one pass over the list. */
export function codeHierarchy(codes: LinkedCode[]): { levels: Map<string, number>; problems: CodeHierarchyProblem[] } {
  const byCode = new Map(codes.map((item) => [item.code, item]));
  const levels = new Map<string, number>();
  const broken = new Map<string, 'cycle' | 'missing'>();
  for (const item of codes) {
    const chain: LinkedCode[] = [];
    const visiting = new Set<string>();
    let cursor: LinkedCode | undefined = item;
    let start = 1;
    let failure: 'cycle' | 'missing' | undefined;
    while (cursor) {
      const known = levels.get(cursor.code);
      if (known !== undefined) { start = known + 1; break; }
      failure = broken.get(cursor.code) ?? (visiting.has(cursor.code) ? 'cycle' : undefined);
      if (failure) break;
      visiting.add(cursor.code);
      chain.push(cursor);
      if (!cursor.parentCode) break;
      const parent: LinkedCode | undefined = byCode.get(cursor.parentCode);
      if (!parent) failure = 'missing';
      cursor = parent;
    }
    if (failure) for (const link of chain) broken.set(link.code, failure);
    else for (const link of [...chain].reverse()) levels.set(link.code, start++);
  }
  const problems: CodeHierarchyProblem[] = [];
  for (const { code } of codes) {
    const failure = broken.get(code);
    if (failure === 'cycle') problems.push({ code, message: `Code hierarchy has a cycle at ${code}` });
    else if (failure === 'missing') problems.push({ code, message: `Missing parent code for ${code}` });
    else if ((levels.get(code) ?? 0) > MAX_CODE_LEVELS) problems.push({ code, message: `Code hierarchy exceeds ${MAX_CODE_LEVELS} levels at ${code}` });
  }
  return { levels, problems };
}

export function validateClassificationCodes(codes: ClassificationCode[], max = EMBEDDED_CODE_LIMIT): ClassificationCode[] {
  if (codes.length < 1 || codes.length > max) throw new BadRequestException(`Choose between 1 and ${max} codes`);
  const byCode = new Map<string, ClassificationCode>();
  const normalized = codes.map((item) => {
    const code = (item.code ?? '').trim();
    const labelEn = (item.labelEn ?? '').trim();
    const labelFr = (item.labelFr ?? '').trim();
    const parentCode = item.parentCode?.trim() || undefined;
    if (!codePattern.test(code) || !labelEn || !labelFr || labelEn.length > 120 || labelFr.length > 120) throw new BadRequestException('Each code needs a stable ID and English/French labels');
    if (byCode.has(code)) throw new BadRequestException(`Repeated code ${code}`);
    const result = { code, labelEn, labelFr, parentCode, active: item.active !== false, mergedInto: item.mergedInto };
    byCode.set(code, result);
    return result;
  });
  const [problem] = codeHierarchy(normalized).problems;
  if (problem) throw new BadRequestException(problem.message);
  for (const item of normalized) {
    if (item.mergedInto && (!byCode.get(item.mergedInto)?.active || item.mergedInto === item.code || item.active)) throw new BadRequestException('A merged code needs an active target');
  }
  return normalized;
}

export function codeAtDepth(list: ClassificationList, code: string, depth: number): string {
  const byCode = new Map(list.codes.map((item) => [item.code, item]));
  let current = byCode.get(code);
  if (!current) return code;
  const chain: ClassificationCode[] = [current];
  while (current.parentCode && byCode.has(current.parentCode)) {
    current = byCode.get(current.parentCode)!;
    chain.unshift(current);
  }
  return chain[Math.min(Math.max(depth, 0), chain.length - 1)].code;
}

/** The labels of a code's ancestors, from the root, in the language asked for. */
export function resolveClassificationPaths(list: ClassificationList, language?: string): { code: string; label: string; path: string[]; level: number; active: boolean }[] {
  const byCode = new Map(list.codes.map((item) => [item.code, item]));
  const label = (item: ClassificationCode) => (language === 'fr' ? item.labelFr : item.labelEn);
  return list.codes.map((item) => {
    const path: string[] = [];
    const seen = new Set([item.code]);
    let parent = item.parentCode ? byCode.get(item.parentCode) : undefined;
    while (parent && !seen.has(parent.code)) {
      seen.add(parent.code);
      path.unshift(label(parent));
      parent = parent.parentCode ? byCode.get(parent.parentCode) : undefined;
    }
    return { code: item.code, label: label(item), path, level: path.length + 1, active: item.active };
  });
}

export function parseClassificationCsv(csv: string): { codes: ClassificationCode[]; errors: { row: number; message: string }[] } {
  if (csv.length > 1_000_000) throw new BadRequestException('CSV is too large');
  const records: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i];
    if (quoted && char === '"' && csv[i + 1] === '"') { cell += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && csv[i + 1] === '\n') i++;
      row.push(cell); records.push(row); row = []; cell = '';
    } else cell += char;
  }
  if (quoted) throw new BadRequestException('CSV has an unclosed quote');
  if (cell || row.length) { row.push(cell); records.push(row); }
  const header = records.shift()?.map((part) => part.trim().toLowerCase()) ?? [];
  if (!['code', 'label_en', 'label_fr', 'parent_code', 'active'].every((name) => header.includes(name))) throw new BadRequestException('CSV needs code,label_en,label_fr,parent_code,active columns');
  const at = (row: string[], name: string) => row[header.indexOf(name)]?.trim() ?? '';
  const errors: { row: number; message: string }[] = [];
  const codes: ClassificationCode[] = [];
  const sourceRows = new Map<string, number>();
  for (const [index, record] of records.entries()) {
    if (record.every((value) => !value.trim())) continue;
    const code = at(record, 'code'), labelEn = at(record, 'label_en'), labelFr = at(record, 'label_fr');
    const active = at(record, 'active').toLowerCase();
    if (!codePattern.test(code) || !labelEn || !labelFr || !['true', 'false', '1', '0'].includes(active)) {
      errors.push({ row: index + 2, message: 'Invalid code, labels or active value' }); continue;
    }
    if (sourceRows.has(code)) { errors.push({ row: index + 2, message: `Repeated code ${code}` }); continue; }
    sourceRows.set(code, index + 2);
    codes.push({ code, labelEn, labelFr, parentCode: at(record, 'parent_code') || undefined, active: active === 'true' || active === '1' });
  }
  for (const problem of codeHierarchy(codes).problems) errors.push({ row: sourceRows.get(problem.code)!, message: problem.message });
  if (!errors.length) {
    try { validateClassificationCodes(codes); }
    catch (error) { errors.push({ row: 0, message: (error as Error).message }); }
  }
  return { codes, errors };
}

/** Lower case without accents, for searching labels whatever their spelling. */
export const foldSearch = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('en');

type ReferentialRow = { code: string; labelEn: string; labelFr: string; parentCode?: string; active: boolean };

/**
 * A standard referential (T39/1): CSV with `code` and `label`, or
 * `label_en`/`label_fr`, and optional `parent_code` (or `parent`) and
 * `active` columns, separated by commas or semicolons; or JSON, flat
 * (`parent_code`) or nested (`children`). A single label serves both
 * languages. Up to 50,000 codes on 8 levels.
 */
export function parseReferential(format: 'CSV' | 'JSON', content: string): { codes: ClassificationCode[]; errors: { row: number; message: string }[] } {
  if (content.length > MAX_REFERENTIAL_TEXT) throw new BadRequestException('Referential file is too large (4 MB at most)');
  const rows: { row: number; value: Record<string, unknown>; parent?: string }[] = [];
  if (format === 'JSON') {
    let root: unknown;
    try { root = JSON.parse(content); } catch { throw new BadRequestException('JSON could not be read'); }
    const items = Array.isArray(root) ? root : (root as { codes?: unknown })?.codes;
    if (!Array.isArray(items)) throw new BadRequestException('JSON needs a list of codes');
    const walk = (list: unknown[], parent?: string, depth = 1) => {
      for (const item of list) {
        if (rows.length > MAX_REFERENTIAL_CODES) return;
        if (!item || typeof item !== 'object' || Array.isArray(item)) { rows.push({ row: rows.length + 1, value: {} }); continue; }
        const value = item as Record<string, unknown>;
        rows.push({ row: rows.length + 1, value, parent });
        if (Array.isArray(value.children) && depth < MAX_CODE_LEVELS + 1) walk(value.children, String(value.code ?? ''), depth + 1);
      }
    };
    walk(items);
  } else {
    const firstLine = content.slice(0, Math.max(0, content.search(/\r?\n|$/)));
    const separator = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
    const records: string[][] = [];
    let row: string[] = [], cell = '', quoted = false;
    const text = content.replace(/^\uFEFF/, '');
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (quoted && char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = !quoted;
      else if (char === separator && !quoted) { row.push(cell); cell = ''; }
      else if ((char === '\n' || char === '\r') && !quoted) {
        if (char === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); records.push(row); row = []; cell = '';
      } else cell += char;
    }
    if (quoted) throw new BadRequestException('CSV has an unclosed quote');
    if (cell || row.length) { row.push(cell); records.push(row); }
    const header = records.shift()?.map((part) => part.trim().toLowerCase()) ?? [];
    if (!header.includes('code') || !(header.includes('label') || header.includes('label_en') || header.includes('label_fr'))) throw new BadRequestException('CSV needs a code column and a label, label_en or label_fr column');
    for (const [index, record] of records.entries()) {
      if (record.every((value) => !value.trim())) continue;
      rows.push({ row: index + 2, value: Object.fromEntries(header.map((name, column) => [name, record[column]])) });
    }
  }
  if (rows.length > MAX_REFERENTIAL_CODES) throw new BadRequestException(`A referential holds at most ${MAX_REFERENTIAL_CODES} codes`);
  const field = (value: Record<string, unknown>, ...names: string[]) => {
    for (const name of names) { const found = value[name]; if (found !== undefined && found !== null && String(found).trim()) return String(found).trim(); }
    return '';
  };
  const errors: { row: number; message: string }[] = [];
  const seen = new Map<string, number>();
  const parsed: ReferentialRow[] = [];
  for (const { row, value, parent } of rows) {
    const code = field(value, 'code');
    const common = field(value, 'label');
    const labelEn = (field(value, 'label_en', 'labelEn') || common || field(value, 'label_fr', 'labelFr')).slice(0, 120);
    const labelFr = (field(value, 'label_fr', 'labelFr') || common || labelEn).slice(0, 120);
    const activeText = field(value, 'active').toLowerCase();
    if (!codePattern.test(code) || !labelEn) { errors.push({ row, message: 'Invalid code or missing label' }); continue; }
    if (activeText && !['true', 'false', '1', '0', 'yes', 'no', 'oui', 'non'].includes(activeText)) { errors.push({ row, message: 'Invalid active value' }); continue; }
    if (seen.has(code)) { errors.push({ row, message: `Repeated code ${code}` }); continue; }
    seen.set(code, row);
    parsed.push({ code, labelEn, labelFr, parentCode: field(value, 'parent_code', 'parentCode', 'parent') || parent || undefined, active: !['false', '0', 'no', 'non'].includes(activeText) });
  }
  for (const problem of codeHierarchy(parsed).problems) errors.push({ row: seen.get(problem.code) ?? 0, message: problem.message });
  if (!errors.length && !parsed.length) errors.push({ row: 0, message: 'The file holds no code' });
  return { codes: parsed, errors: errors.slice(0, 200) };
}
