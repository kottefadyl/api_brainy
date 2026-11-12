import { BadRequestException } from '@nestjs/common';
import { AnalysisInput, AnalysisResult, AnalysisRow } from './analysis.input.js';
import { Collection, CollectionField, CollectionFormat, FieldKind, SensitivityLevel } from './collection.schema.js';
import { decimal, divide, fractionText, multiply, type Rational } from './unit_math.js';

const rank: Record<SensitivityLevel, number> = { ORDINARY: 0, PERSONAL: 1, SENSITIVE: 2 };
export const validSensitivity = (level: SensitivityLevel): boolean => Object.values(SensitivityLevel).includes(level);
export const effectiveSensitivity = (format: CollectionFormat, field?: CollectionField): SensitivityLevel => {
  const parent = format.sensitivity ?? SensitivityLevel.ORDINARY;
  const child = field?.sensitivity ?? (field && [FieldKind.POSITION, FieldKind.ZONE].includes(field.kind) ? SensitivityLevel.SENSITIVE : SensitivityLevel.ORDINARY);
  return rank[parent] >= rank[child] ? parent : child;
};
export const sensitiveFields = (format: CollectionFormat): Set<string> =>
  new Set(format.fields.filter((field) => effectiveSensitivity(format, field) === SensitivityLevel.SENSITIVE).map((field) => field.id));
export const protectedFields = (format: CollectionFormat): Set<string> =>
  new Set(format.fields.filter((field) => effectiveSensitivity(format, field) !== SensitivityLevel.ORDINARY).map((field) => field.id));
export const hasSensitiveData = (collection: Collection): boolean => collection.formats.some((format) => sensitiveFields(format).size > 0);
export const hasProtectedData = (collection: Collection): boolean => collection.formats.some((format) => protectedFields(format).size > 0);
export const sensitiveAnalysis = (format: CollectionFormat): boolean => {
  if (format.sensitivity === SensitivityLevel.SENSITIVE) return true;
  return format.fields.some((field) => effectiveSensitivity(format, field) === SensitivityLevel.SENSITIVE);
};
export function assertSensitiveAnalysisRequest(format: CollectionFormat, input: AnalysisInput): boolean {
  if (!sensitiveAnalysis(format)) return false;
  if (!['COUNT', 'SUM', 'AVERAGE'].includes(input.operation) || !['NONE', 'DAY', 'MONTH', 'CATEGORY'].includes(input.groupBy) ||
      input.secondaryGroupBy || input.filters?.length || input.search || input.viewId || input.sourceGroup || input.sourceOffset ||
      input.from || input.to || input.comparisonFrom || input.comparisonTo || input.formulaId || input.groupDepth || input.secondaryGroupDepth) {
    throw new BadRequestException('Sensitive analysis allows only an unfiltered count, sum or average without comparison or source details');
  }
  return true;
}
/**
 * k-anonymity rule (T43/1): every row returned for a sensitive aggregate holds
 * at least k observations (k = the collection's minimum aggregate size).
 * Before refusing, the grouping is widened step by step, always in the same
 * order so that the result is explainable:
 * - CATEGORY: the small groups are merged into one "Other" row when they are
 *   at least two and together reach k (a lone small group would still be
 *   named by its absence); otherwise the whole set becomes one total;
 * - DAY → MONTH → one total; MONTH → one total;
 * - a total under k, or omitted observations (a complement that can be
 *   subtracted), is refused.
 * This limits disclosure; it is not anonymization.
 */
export const COARSER: Record<string, string | undefined> = { DAY: 'MONTH', MONTH: 'NONE', CATEGORY: 'NONE' };
export const MERGED_GROUP = '__merged__';
export type Generalization =
  | { kind: 'fine'; result: AnalysisResult }
  | { kind: 'merged'; result: AnalysisResult; merged: number }
  | { kind: 'coarser'; groupBy: string }
  | { kind: 'refused'; reason: string };

export function assertMinimumAggregateSize(minimum: number): void {
  if (!Number.isInteger(minimum) || minimum < 2 || minimum > 100) throw new BadRequestException('Invalid minimum aggregate size');
}

const sum = (a: Rational, b: Rational): Rational => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });

function mergedValue(operation: string, rows: AnalysisRow[]): string {
  const count = rows.reduce((total, row) => total + row.count, 0);
  if (operation === 'COUNT') return String(count);
  const total = rows.reduce((acc, row) => sum(acc, operation === 'AVERAGE' ? multiply(decimal(row.value), { n: BigInt(row.count), d: 1n }) : decimal(row.value)), { n: 0n, d: 1n });
  return fractionText(operation === 'AVERAGE' ? divide(total, { n: BigInt(count), d: 1n }) : total);
}

export function generalizeSensitiveAggregate(result: AnalysisResult, minimum: number, language?: string): Generalization {
  assertMinimumAggregateSize(minimum);
  const refused = `Sensitive aggregate needs at least ${minimum} observations in every group, with no omitted observations`;
  if (!result.rows.length || (result.skippedMissingCount ?? 0) > 0) return { kind: 'refused', reason: refused };
  const small = result.rows.filter((row) => row.count < minimum);
  if (!small.length) return { kind: 'fine', result };
  if (result.groupBy === 'CATEGORY' && small.length >= 2 && ['COUNT', 'SUM', 'AVERAGE'].includes(result.operation)) {
    const count = small.reduce((total, row) => total + row.count, 0);
    if (count >= minimum) {
      const label = language === 'fr' ? `Autres (${small.length} groupes regroupés)` : `Other (${small.length} groups merged)`;
      const merged: AnalysisRow = { group: MERGED_GROUP, label, value: mergedValue(result.operation, small), count, sources: [], sourcesHasMore: false };
      return { kind: 'merged', merged: small.length, result: { ...result, rows: [...result.rows.filter((row) => row.count >= minimum), merged] } };
    }
  }
  const coarser = COARSER[result.groupBy];
  return coarser ? { kind: 'coarser', groupBy: coarser } : { kind: 'refused', reason: refused };
}

/** Strips the sources and says what was widened; `steps` are `DAY>MONTH`-style codes or `MERGED:n`. */
export function finishSensitiveAggregate(result: AnalysisResult, minimum: number, steps: string[], language?: string): AnalysisResult {
  const fr = language === 'fr';
  const names: Record<string, string> = fr
    ? { DAY: 'jours', MONTH: 'mois', CATEGORY: 'catégories', NONE: 'un seul total' }
    : { DAY: 'days', MONTH: 'months', CATEGORY: 'categories', NONE: 'one total' };
  const told = steps.map((step) => {
    if (step.startsWith('MERGED:')) return fr ? `${step.slice(7)} petits groupes regroupés` : `${step.slice(7)} small groups merged`;
    const [from, to] = step.split('>');
    return `${names[from] ?? from} → ${names[to] ?? to}`;
  });
  const widened = told.length ? (fr ? ` Groupes élargis : ${told.join(' ; ')}.` : ` Groups widened: ${told.join('; ')}.`) : '';
  const explanation = fr
    ? `Agrégat sensible : au moins ${minimum} observations par groupe.${widened} Ce n'est pas une anonymisation.`
    : `Sensitive aggregate: at least ${minimum} observations per group.${widened} This is not anonymization.`;
  return { ...result, skippedMissingCount: undefined, explanation, rows: result.rows.map((row) => ({ ...row, sources: [], sourcesHasMore: false })) };
}
