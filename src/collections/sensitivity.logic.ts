import { BadRequestException } from '@nestjs/common';
import { AnalysisInput, AnalysisResult } from './analysis.input';
import { Collection, CollectionField, CollectionFormat, FieldKind, SensitivityLevel } from './collection.schema';

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
export function enforceSensitiveAggregate(result: AnalysisResult, minimum: number): AnalysisResult {
  if (!Number.isInteger(minimum) || minimum < 2 || minimum > 100) throw new BadRequestException('Invalid minimum aggregate size');
  if (!result.rows.length || result.rows.some((row) => row.count < minimum) || (result.skippedMissingCount ?? 0) > 0) {
    throw new BadRequestException(`Sensitive aggregate needs at least ${minimum} observations in every group, with no omitted observations`);
  }
  return { ...result, skippedMissingCount: undefined, explanation: `Sensitive aggregate: at least ${minimum} observations per group. This is not anonymization.`,
    rows: result.rows.map((row) => ({ ...row, sources: [], sourcesHasMore: false })) };
}
