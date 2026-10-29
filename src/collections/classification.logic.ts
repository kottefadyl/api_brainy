import { BadRequestException } from '@nestjs/common';
import { ClassificationCode, ClassificationList } from './collection.schema';

const codePattern = /^[\p{L}\p{N}_.-]{1,64}$/u;

export function validateClassificationCodes(codes: ClassificationCode[]): ClassificationCode[] {
  if (codes.length < 1 || codes.length > 5000) throw new BadRequestException('Choose between 1 and 5000 codes');
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
  for (const item of normalized) {
    let cursor: ClassificationCode | undefined = item;
    const seen = new Set<string>();
    while (cursor) {
      if (seen.has(cursor.code) || seen.size >= 3) throw new BadRequestException(`Code hierarchy has a cycle or exceeds three levels at ${item.code}`);
      seen.add(cursor.code);
      if (cursor.parentCode && !byCode.has(cursor.parentCode)) throw new BadRequestException(`Missing parent code for ${cursor.code}`);
      cursor = cursor.parentCode ? byCode.get(cursor.parentCode) : undefined;
    }
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
  const byCode = new Map(codes.map((item) => [item.code, item]));
  for (const item of codes) {
    let cursor: ClassificationCode | undefined = item;
    const seen = new Set<string>();
    while (cursor?.parentCode) {
      if (seen.has(cursor.code) || seen.size >= 3) { errors.push({ row: sourceRows.get(item.code)!, message: 'Code hierarchy has a cycle or exceeds three levels' }); break; }
      seen.add(cursor.code);
      if (!byCode.has(cursor.parentCode)) { errors.push({ row: sourceRows.get(item.code)!, message: `Missing parent ${cursor.parentCode}` }); break; }
      cursor = byCode.get(cursor.parentCode);
    }
    if (seen.size >= 3) errors.push({ row: sourceRows.get(item.code)!, message: 'Code hierarchy exceeds three levels' });
  }
  if (!errors.length) {
    try { validateClassificationCodes(codes); }
    catch (error) { errors.push({ row: 0, message: (error as Error).message }); }
  }
  return { codes, errors };
}
