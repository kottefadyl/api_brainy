import { BadRequestException } from '@nestjs/common';
import { AnalysisInput, AnalysisOperationSpec, AnalysisRow, AnalysisSource } from './analysis.input';
import { decimal, divide, fractionText, multiply, Rational } from './unit_math';

/**
 * Definitions shared by every way of running a statistic, and the accumulator
 * that computes them one entry at a time. Its memory depends on the number of
 * groups and of distinct values, never on the number of entries.
 */

function gcd(a: bigint, b: bigint): bigint {
  let [x, y] = [a < 0n ? -a : a, b < 0n ? -b : b];
  while (y) [x, y] = [y, x % y];
  return x || 1n;
}

/** Adds over the least common denominator, so a long sum keeps a small denominator. */
export function plus(a: Rational, b: Rational): Rational {
  if (a.d === b.d) return { n: a.n + b.n, d: a.d };
  const shared = gcd(a.d, b.d);
  return { n: a.n * (b.d / shared) + b.n * (a.d / shared), d: (a.d / shared) * b.d };
}
export const negate = (a: Rational): Rational => ({ n: -a.n, d: a.d });
export const compareRational = (a: Rational, b: Rational): number => {
  const diff = a.n * b.d - b.n * a.d;
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
};
// Dividing first keeps the result finite when numerator and denominator are each beyond the range of a double.
export const toNumber = (r: Rational): number => Number((r.n * 1_000_000_000_000_000n) / r.d) / 1e15;
export const formatFloat = (n: number): string => {
  if (!Number.isFinite(n)) throw new BadRequestException('Invalid numeric result');
  const rounded = Math.round(n * 1_000_000) / 1_000_000;
  return fractionText(decimal(rounded.toFixed(6)));
};

export type ObservationRecord = {
  entryId: string;
  dateValue?: string;
  primaryKey: string;
  secondaryKey?: string;
  value?: Rational;
  weight?: Rational;
  denominator?: Rational;
  counterReset?: boolean;
  status?: string;
  uncertainty?: string;
  uncertaintyType?: string;
};

export type RegistryComputationOutput = {
  rows: AnalysisRow[];
  outputUnit?: string;
  slope?: string;
  explanation: string;
  hasEstimated?: boolean;
  propagatedUncertainty?: string;
};

export type GroupStats = {
  count: number;
  sum?: Rational;
  squares?: Rational;
  min?: Rational;
  max?: Rational;
  picked?: Rational[];
  mode?: Rational;
  weightedSum?: Rational;
  totalWeight?: Rational;
  denominator?: Rational;
};

const isDeviation = (id: string) => id === 'VARIANCE' || id === 'STDDEV' || id === 'STDDEV_SAMPLE';
const isDistribution = (id: string) => id === 'MEDIAN' || id === 'MODE' || id.startsWith('PERCENTILE');
export const needsDistribution = (spec: AnalysisOperationSpec) => isDistribution(spec.id);
export const needsSquares = (spec: AnalysisOperationSpec) => isDeviation(spec.id);
/** A cross-tabulation adds up events and averages snapshots or rates. */
const scalarId = (spec: AnalysisOperationSpec, input: AnalysisInput): string => spec.id === 'CROSSTAB' ? (input.measureKind === 'EVENT' ? 'SUM' : 'AVERAGE') : spec.id;

function percentileOf(spec: AnalysisOperationSpec, input: AnalysisInput): number {
  const fixed: Record<string, number> = { PERCENTILE_25: 25, PERCENTILE_75: 75, PERCENTILE_95: 95 };
  const p = fixed[spec.id] ?? input.percentile ?? 95;
  if (!Number.isInteger(p) || p < 1 || p > 99) throw new BadRequestException('Choose a percentile between 1 and 99');
  return p;
}

/** Zero-based position of the nearest-rank percentile, in whole numbers so that 7 % of 100 is exactly 7. */
const percentileIndex = (p: number, count: number): number => Math.max(0, Math.min(count - 1, Math.floor((p * count + 99) / 100) - 1));

/** Zero-based sorted positions an operation reads from a group. */
function statsRanks(spec: AnalysisOperationSpec, count: number, input: AnalysisInput): number[] {
  if (spec.id === 'MEDIAN') return count % 2 === 1 ? [(count - 1) / 2] : [count / 2 - 1, count / 2];
  return spec.id.startsWith('PERCENTILE') ? [percentileIndex(percentileOf(spec, input), count)] : [];
}

/** Reads a group's distinct values in ascending order, keeping only the ranks asked for and the most frequent value. */
export function distributionReader(spec: AnalysisOperationSpec, count: number, input: AnalysisInput) {
  const wanted = statsRanks(spec, count, input);
  const picked: Rational[] = [];
  let seen = 0;
  let bestCount = 0;
  let mode: Rational | undefined;
  return {
    read(value: Rational, occurrences: number) {
      for (const rank of wanted) if (rank >= seen && rank < seen + occurrences) picked.push(value);
      // Ascending order means a tie keeps the smallest value.
      if (occurrences > bestCount) { bestCount = occurrences; mode = value; }
      seen += occurrences;
    },
    result: (): Pick<GroupStats, 'picked' | 'mode'> => ({ picked, mode }),
  };
}

export function scalarFromStats(spec: AnalysisOperationSpec, stats: GroupStats, input: AnalysisInput): Rational {
  const id = scalarId(spec, input);
  if (id === 'COUNT') return decimal(String(stats.count));
  if (stats.count < spec.minObservations) throw new BadRequestException(`Operation ${spec.id} requires at least ${spec.minObservations} observations (got ${stats.count})`);
  const count = decimal(String(stats.count));
  const weighted = !!input.weightFieldId;
  if (id === 'SUM') return weighted ? stats.weightedSum! : stats.sum!;
  if (id === 'AVERAGE') {
    if (!weighted) return divide(stats.sum!, count);
    if (stats.totalWeight!.n <= 0n) throw new BadRequestException('Total weight must be strictly positive');
    return divide(stats.weightedSum!, stats.totalWeight!);
  }
  if (id === 'MIN') return stats.min!;
  if (id === 'MAX') return stats.max!;
  if (id === 'RANGE') return plus(stats.max!, negate(stats.min!));
  if (id === 'MODE') return stats.mode!;
  if (isDistribution(id)) {
    const picked = stats.picked!;
    return picked.length === 2 ? divide(plus(picked[0], picked[1]), decimal('2')) : picked[0];
  }
  if (isDeviation(id)) {
    const spread = plus(stats.squares!, negate(divide(multiply(stats.sum!, stats.sum!), count)));
    const variance = divide(spread, decimal(String(id === 'STDDEV_SAMPLE' ? stats.count - 1 : stats.count)));
    return id === 'VARIANCE' ? variance : decimal(formatFloat(Math.sqrt(Math.max(0, toNumber(variance)))));
  }
  if (id === 'RATE_PER_N') {
    const base = input.rateBase ?? 1000;
    if (!Number.isInteger(base) || base <= 0 || base > 1_000_000_000) throw new BadRequestException('Choose a positive rate base (e.g. 1000)');
    const numerator = weighted ? stats.weightedSum! : stats.sum!;
    let denominator: Rational;
    if (input.denominatorValue?.trim()) denominator = decimal(input.denominatorValue.trim().replace(',', '.'));
    else if (input.denominatorFieldId) denominator = stats.denominator ?? decimal('0');
    else throw new BadRequestException('Choose a positive denominator value or field for rate calculation');
    if (denominator.n <= 0n) throw new BadRequestException('Denominator must be strictly positive');
    return multiply(divide(numerator, denominator), decimal(String(base)));
  }
  throw new BadRequestException(`Unsupported scalar operation ${spec.id}`);
}

export function outputUnitFor(spec: AnalysisOperationSpec, input: AnalysisInput, baseUnit?: string): string | undefined {
  if (spec.outputKind === 'COUNT') return undefined;
  if (spec.outputKind === 'SQUARED_UNIT') return baseUnit ? `${baseUnit}²` : undefined;
  if (spec.outputKind === 'PERCENT') return '%';
  if (spec.outputKind === 'RATE_PER_N') {
    const base = input.rateBase ?? 1000;
    return baseUnit ? `${baseUnit}/${base}` : `/${base}`;
  }
  return baseUnit;
}

export const groupExplanation = (spec: AnalysisOperationSpec, input: AnalysisInput, skippedMissingCount: number): string => `${spec.id} v${spec.version}${input.weightFieldId ? ' · weighted' : ''}${spec.id === 'PERCENTILE' ? ` · p=${input.percentile ?? 95}` : ''}${spec.id === 'RATE_PER_N' ? ` · per ${input.rateBase ?? 1000}` : ''} · missingSkipped=${skippedMissingCount}`;

/** The answer when there is nothing to calculate; refuses when there are too few observations. */
export function emptyResult(spec: AnalysisOperationSpec, total: number, baseUnit: string | undefined, isComparison: boolean): RegistryComputationOutput | undefined {
  if (total === 0 && (isComparison || spec.minObservations <= 1)) {
    return { rows: [], outputUnit: spec.outputKind === 'COUNT' ? undefined : baseUnit, explanation: `${spec.id} v${spec.version} · empty` };
  }
  if (spec.id !== 'COUNT' && total < spec.minObservations) {
    throw new BadRequestException(`Not enough observations for ${spec.id} (minimum ${spec.minObservations}, found ${total})`);
  }
  return undefined;
}

/** Which sources of a group are returned: [first, end[ in entry order. */
export function sourceWindow(key: string, input: AnalysisInput): { first: number; end: number } {
  const first = input.sourceGroup === key ? (input.sourceOffset ?? 0) : 0;
  return { first, end: first + (!input.sourceGroup || input.sourceGroup === key ? 100 : 20) };
}

function distinctKey(value: Rational): string {
  if (value.d === 1n) return `${value.n}`;
  const shared = gcd(value.n, value.d);
  return `${value.n / shared}/${value.d / shared}`;
}

class GroupAccumulator {
  readonly stats: GroupStats = { count: 0 };
  readonly sources: AnalysisSource[] = [];
  private readonly window: { first: number; end: number };
  private readonly id: string;
  private readonly distinct = new Map<string, { value: Rational; occurrences: number }>();

  constructor(private readonly spec: AnalysisOperationSpec, private readonly input: AnalysisInput, key: string, readonly rowKey?: string, readonly columnKey?: string) {
    this.window = sourceWindow(key, input);
    this.id = scalarId(spec, input);
  }

  add(item: ObservationRecord): void {
    const { stats, id, input } = this;
    const position = stats.count++;
    const value = item.value;
    if (position >= this.window.first && position < this.window.end) this.sources.push({ entryId: item.entryId, value: value ? fractionText(value) : '1' });
    if (!value) return;
    if (id === 'SUM' || id === 'AVERAGE' || id === 'RATE_PER_N' || isDeviation(id)) stats.sum = plus(stats.sum ?? decimal('0'), value);
    if (isDeviation(id)) stats.squares = plus(stats.squares ?? decimal('0'), multiply(value, value));
    if (id === 'MIN' || id === 'MAX' || id === 'RANGE') {
      if (!stats.min || compareRational(value, stats.min) < 0) stats.min = value;
      if (!stats.max || compareRational(value, stats.max) > 0) stats.max = value;
    }
    if (input.weightFieldId && (id === 'SUM' || id === 'AVERAGE' || id === 'RATE_PER_N')) {
      const weight = item.weight ?? decimal(id === 'AVERAGE' ? '0' : '1');
      stats.weightedSum = plus(stats.weightedSum ?? decimal('0'), multiply(value, weight));
      stats.totalWeight = plus(stats.totalWeight ?? decimal('0'), weight);
    }
    if (id === 'RATE_PER_N' && input.denominatorFieldId) stats.denominator = plus(stats.denominator ?? decimal('0'), item.denominator ?? decimal('0'));
    if (isDistribution(id)) {
      const key = distinctKey(value);
      const known = this.distinct.get(key);
      if (known) known.occurrences++;
      else this.distinct.set(key, { value, occurrences: 1 });
    }
  }

  value(): Rational {
    if (isDistribution(this.id) && this.stats.count >= this.spec.minObservations) {
      const reader = distributionReader(this.spec, this.stats.count, this.input);
      for (const item of [...this.distinct.values()].sort((a, b) => compareRational(a.value, b.value))) reader.read(item.value, item.occurrences);
      Object.assign(this.stats, reader.result());
      this.distinct.clear();
    }
    return scalarFromStats(this.spec, this.stats, this.input);
  }
}

/** One group's scalar, for a list of observations already in memory. */
export function scalarOf(spec: AnalysisOperationSpec, items: ObservationRecord[], input: AnalysisInput): Rational {
  const group = new GroupAccumulator(spec, input, '');
  for (const item of items) group.add(item);
  return group.value();
}

/** Computes every operation that does not depend on the chronological order of entries. */
export class ObservationAccumulator {
  private readonly groups = new Map<string, GroupAccumulator>();
  private total = 0;
  private hasEstimated = false;
  private withUncertainty = 0;
  private allAbsolute = true;
  private squaredUncertainty = 0;

  constructor(private readonly spec: AnalysisOperationSpec, private readonly input: AnalysisInput) {}

  add(item: ObservationRecord): void {
    this.total++;
    if (item.status === 'ESTIMATED') this.hasEstimated = true;
    if (item.uncertainty !== undefined && item.uncertainty !== '') {
      this.withUncertainty++;
      if (item.uncertaintyType && item.uncertaintyType !== 'ABSOLUTE') this.allAbsolute = false;
      this.squaredUncertainty += Number(item.uncertainty) ** 2;
    }
    const crossTab = this.spec.id === 'CROSSTAB';
    const columnKey = crossTab ? item.secondaryKey ?? 'Missing' : undefined;
    const key = crossTab ? `${item.primaryKey} × ${columnKey}` : item.primaryKey;
    let group = this.groups.get(key);
    if (!group) {
      group = new GroupAccumulator(this.spec, this.input, key, crossTab ? item.primaryKey : undefined, columnKey);
      this.groups.set(key, group);
    }
    group.add(item);
  }

  finish(baseUnit: string | undefined, skippedMissingCount: number, isComparison: boolean): RegistryComputationOutput {
    const { spec, input } = this;
    const empty = emptyResult(spec, this.total, baseUnit, isComparison);
    if (empty) return empty;
    const crossTab = spec.id === 'CROSSTAB';
    if (crossTab && (!input.secondaryGroupBy || input.groupBy === 'NONE' || input.secondaryGroupBy === 'NONE')) {
      throw new BadRequestException('Cross-tabulation requires both primary and secondary groupings');
    }
    const rows: AnalysisRow[] = [...this.groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, item]) => ({
      group,
      label: group,
      ...(crossTab ? { rowKey: item.rowKey, columnKey: item.columnKey } : {}),
      value: fractionText(item.value()),
      count: item.stats.count,
      sources: item.sources,
      sourcesHasMore: item.stats.count > sourceWindow(group, input).first + item.sources.length,
    }));
    const outputUnit = outputUnitFor(spec, input, baseUnit);
    if (crossTab) return { rows, outputUnit, explanation: `CROSSTAB v${spec.version} · ${input.groupBy} × ${input.secondaryGroupBy} · cells=${rows.length} · missingSkipped=${skippedMissingCount}` };
    let uncertaintyNote = '';
    let propagatedUncertainty: string | undefined;
    if ((spec.id === 'SUM' || spec.id === 'AVERAGE') && this.withUncertainty > 0) {
      if (this.withUncertainty === this.total && this.allAbsolute) {
        const combined = spec.id === 'SUM' ? Math.sqrt(this.squaredUncertainty) : Math.sqrt(this.squaredUncertainty) / this.total;
        propagatedUncertainty = (Math.round(combined * 1000000) / 1000000).toString();
        uncertaintyNote = ` · ± ${propagatedUncertainty}`;
      } else uncertaintyNote = ' · incertitude non propagée';
    }
    return { rows, outputUnit, explanation: `${groupExplanation(spec, input, skippedMissingCount)}${this.hasEstimated ? ' · inclut des valeurs estimées' : ''}${uncertaintyNote}`, hasEstimated: this.hasEstimated, propagatedUncertainty };
  }
}
