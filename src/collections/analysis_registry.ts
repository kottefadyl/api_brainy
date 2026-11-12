import { BadRequestException } from '@nestjs/common';
import { AnalysisInput, AnalysisOperationSpec, AnalysisRow, AnalysisSource } from './analysis.input.js';
import { emptyResult, formatFloat, negate, ObservationAccumulator, ObservationRecord, outputUnitFor, plus, RegistryComputationOutput, scalarOf, sourceWindow, toNumber } from './analysis_stats.js';
import { decimal, divide, fractionText, multiply, Rational } from './unit_math.js';

export type { ObservationRecord, RegistryComputationOutput } from './analysis_stats.js';

export const ANALYSIS_REGISTRY: readonly AnalysisOperationSpec[] = [
  { id: 'COUNT', version: 1, acceptedMeasureKinds: ['EVENT', 'SNAPSHOT', 'RATE'], requiresNumeric: false, requiresDateOrder: false, missingValuePolicy: 'COUNT_ONLY', minObservations: 0, outputKind: 'COUNT' },
  { id: 'SUM', version: 1, acceptedMeasureKinds: ['EVENT'], requiresNumeric: true, requiresDateOrder: false, missingValuePolicy: 'SKIP', minObservations: 1, outputKind: 'SAME_UNIT' },
  { id: 'AVERAGE', version: 1, acceptedMeasureKinds: ['EVENT', 'SNAPSHOT', 'RATE'], requiresNumeric: true, requiresDateOrder: false, missingValuePolicy: 'SKIP', minObservations: 1, outputKind: 'SAME_UNIT' },
  { id: 'MIN', version: 1, acceptedMeasureKinds: ['EVENT', 'SNAPSHOT', 'RATE'], requiresNumeric: true, requiresDateOrder: false, missingValuePolicy: 'SKIP', minObservations: 1, outputKind: 'SAME_UNIT' },
  { id: 'MAX', version: 1, acceptedMeasureKinds: ['EVENT', 'SNAPSHOT', 'RATE'], requiresNumeric: true, requiresDateOrder: false, missingValuePolicy: 'SKIP', minObservations: 1, outputKind: 'SAME_UNIT' },
  { id: 'MEDIAN', version: 1, acceptedMeasureKinds: ['EVENT', 'SNAPSHOT', 'RATE'], requiresNumeric: true, requiresDateOrder: false, missingValuePolicy: 'SKIP', minObservations: 1, outputKind: 'SAME_UNIT' },
  { id: 'PERCENTILE', version: 1, acceptedMeasureKinds: ['EVENT', 'SNAPSHOT', 'RATE'], requiresNumeric: true, requiresDateOrder: false, missingValuePolicy: 'SKIP', minObservations: 1, outputKind: 'SAME_UNIT' },
  { id: 'PERCENTILE_25', version: 1, acceptedMeasureKinds: ['EVENT', 'SNAPSHOT', 'RATE'], requiresNumeric: true, requiresDateOrder: false, missingValuePolicy: 'SKIP', minObservations: 1, outputKind: 'SAME_UNIT' },
  { id: 'PERCENTILE_75', version: 1, acceptedMeasureKinds: ['EVENT', 'SNAPSHOT', 'RATE'], requiresNumeric: true, requiresDateOrder: false, missingValuePolicy: 'SKIP', minObservations: 1, outputKind: 'SAME_UNIT' },
  { id: 'PERCENTILE_95', version: 1, acceptedMeasureKinds: ['EVENT', 'SNAPSHOT', 'RATE'], requiresNumeric: true, requiresDateOrder: false, missingValuePolicy: 'SKIP', minObservations: 1, outputKind: 'SAME_UNIT' },
  { id: 'MODE', version: 1, acceptedMeasureKinds: ['EVENT', 'SNAPSHOT', 'RATE'], requiresNumeric: true, requiresDateOrder: false, missingValuePolicy: 'SKIP', minObservations: 1, outputKind: 'SAME_UNIT' },
  { id: 'VARIANCE', version: 1, acceptedMeasureKinds: ['EVENT', 'SNAPSHOT', 'RATE'], requiresNumeric: true, requiresDateOrder: false, missingValuePolicy: 'SKIP', minObservations: 2, outputKind: 'SQUARED_UNIT' },
  { id: 'STDDEV', version: 1, acceptedMeasureKinds: ['EVENT', 'SNAPSHOT', 'RATE'], requiresNumeric: true, requiresDateOrder: false, missingValuePolicy: 'SKIP', minObservations: 2, outputKind: 'SAME_UNIT' },
  { id: 'STDDEV_SAMPLE', version: 1, acceptedMeasureKinds: ['EVENT', 'SNAPSHOT', 'RATE'], requiresNumeric: true, requiresDateOrder: false, missingValuePolicy: 'SKIP', minObservations: 2, outputKind: 'SAME_UNIT' },
  { id: 'RANGE', version: 1, acceptedMeasureKinds: ['EVENT', 'SNAPSHOT', 'RATE'], requiresNumeric: true, requiresDateOrder: false, missingValuePolicy: 'SKIP', minObservations: 1, outputKind: 'SAME_UNIT' },
  { id: 'RATE_PER_N', version: 1, acceptedMeasureKinds: ['EVENT', 'SNAPSHOT', 'RATE'], requiresNumeric: true, requiresDateOrder: false, missingValuePolicy: 'SKIP', minObservations: 1, outputKind: 'RATE_PER_N' },
  { id: 'CROSSTAB', version: 1, acceptedMeasureKinds: ['EVENT', 'SNAPSHOT', 'RATE'], requiresNumeric: true, requiresDateOrder: false, missingValuePolicy: 'SKIP', minObservations: 1, outputKind: 'SAME_UNIT' },
  { id: 'CUMULATIVE', version: 1, acceptedMeasureKinds: ['EVENT'], requiresNumeric: true, requiresDateOrder: true, missingValuePolicy: 'SKIP', minObservations: 1, outputKind: 'SAME_UNIT' },
  { id: 'MOVING_AVERAGE', version: 1, acceptedMeasureKinds: ['EVENT', 'SNAPSHOT', 'RATE'], requiresNumeric: true, requiresDateOrder: true, missingValuePolicy: 'SKIP', minObservations: 1, outputKind: 'SAME_UNIT' },
  { id: 'SUCCESSIVE_DIFF', version: 1, acceptedMeasureKinds: ['SNAPSHOT', 'EVENT'], requiresNumeric: true, requiresDateOrder: true, missingValuePolicy: 'SKIP', minObservations: 2, outputKind: 'SAME_UNIT' },
  { id: 'SUCCESSIVE_VARIATION', version: 1, acceptedMeasureKinds: ['SNAPSHOT', 'EVENT', 'RATE'], requiresNumeric: true, requiresDateOrder: true, missingValuePolicy: 'SKIP', minObservations: 2, outputKind: 'PERCENT' },
  { id: 'LINEAR_TREND', version: 1, acceptedMeasureKinds: ['EVENT', 'SNAPSHOT', 'RATE'], requiresNumeric: true, requiresDateOrder: true, missingValuePolicy: 'SKIP', minObservations: 2, outputKind: 'SLOPE' },
] as const;

export function getOperationSpec(operationId: string): AnalysisOperationSpec {
  const spec = ANALYSIS_REGISTRY.find((item) => item.id === operationId);
  if (!spec) throw new BadRequestException('Choose a valid analysis operation');
  return spec;
}

/** Without a period, these series return one row per entry: that is a limit on the answer, not on the data read. */
const MAX_POINTS_PER_ENTRY = 10_000;

function pageOf<T>(all: T[], key: string, input: AnalysisInput, toSource: (item: T) => AnalysisSource): { sources: AnalysisSource[]; sourcesHasMore: boolean } {
  const { first, end } = sourceWindow(key, input);
  const page = all.slice(first, end);
  return { sources: page.map(toSource), sourcesHasMore: all.length > first + page.length };
}

const observationSource = (item: ObservationRecord): AnalysisSource => ({ entryId: item.entryId, value: fractionText(item.value!) });
const inDateOrder = (a: ObservationRecord, b: ObservationRecord): number => {
  const [left, right] = [a.dateValue ?? '', b.dateValue ?? ''];
  if (left !== right) return left < right ? -1 : 1;
  return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0;
};

function executeSequenceOperation(spec: AnalysisOperationSpec, observations: ObservationRecord[], input: AnalysisInput, outputUnit: string | undefined, skippedMissingCount: number): RegistryComputationOutput {
  const successive = spec.id === 'SUCCESSIVE_DIFF' || spec.id === 'SUCCESSIVE_VARIATION';
  if (!successive && input.groupBy === 'NONE' && observations.length > MAX_POINTS_PER_ENTRY) {
    throw new BadRequestException(`Group this series by day or month: one point per entry is available up to ${MAX_POINTS_PER_ENTRY} entries`);
  }
  const ordered = [...observations].sort(inDateOrder);

  if (successive) {
    const deltas = new Map<string, { entryId: string; step: Rational }[]>();
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1];
      const curr = ordered[i];
      const rawDiff = plus(curr.value!, negate(prev.value!));
      let step: Rational;
      if (spec.id === 'SUCCESSIVE_DIFF') {
        if (rawDiff.n >= 0n) step = rawDiff;
        else if (curr.counterReset) step = curr.value!;
        else throw new BadRequestException('Counter decreased without a declared counter reset');
      } else {
        if (prev.value!.n === 0n) throw new BadRequestException('Cannot compute percentage variation from zero');
        const absPrev: Rational = { n: prev.value!.n < 0n ? -prev.value!.n : prev.value!.n, d: prev.value!.d };
        step = multiply(divide(rawDiff, absPrev), decimal('100'));
      }
      const key = input.groupBy === 'NONE' ? 'All' : curr.primaryKey;
      const bucket = deltas.get(key) ?? [];
      bucket.push({ entryId: curr.entryId, step });
      deltas.set(key, bucket);
    }
    const rows = [...deltas.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, steps]) => {
      const total = steps.reduce((acc, item) => plus(acc, item.step), decimal('0'));
      const val = spec.id === 'SUCCESSIVE_DIFF' ? total : divide(total, decimal(String(steps.length)));
      return { group, label: group, value: fractionText(val), count: steps.length, ...pageOf(steps, group, input, (item) => ({ entryId: item.entryId, value: fractionText(item.step) })) };
    });
    return { rows, outputUnit, explanation: `${spec.id} v${spec.version} · order=date,id · pairs=${ordered.length - 1} · missingSkipped=${skippedMissingCount}` };
  }

  // Group ordered observations into chronological buckets for CUMULATIVE, MOVING_AVERAGE, LINEAR_TREND
  const buckets = new Map<string, ObservationRecord[]>();
  for (const obs of ordered) {
    const key = input.groupBy === 'NONE' ? `${obs.dateValue ?? ''}#${obs.entryId.slice(-6)}` : obs.primaryKey;
    const list = buckets.get(key) ?? [];
    list.push(obs);
    buckets.set(key, list);
  }
  const baseOp = getOperationSpec(input.measureKind === 'EVENT' ? 'SUM' : 'AVERAGE');
  const baseSeries = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, items]) => ({ group, val: scalarOf(baseOp, items, input), items }));

  if (baseSeries.length < spec.minObservations) {
    throw new BadRequestException(`Operation ${spec.id} requires at least ${spec.minObservations} ordered periods (got ${baseSeries.length})`);
  }

  if (spec.id === 'CUMULATIVE') {
    let running = decimal('0');
    const seen: ObservationRecord[] = [];
    const rows: AnalysisRow[] = baseSeries.map((point) => {
      running = plus(running, point.val);
      for (const item of point.items) seen.push(item);
      return { group: point.group, label: point.group, value: fractionText(running), count: seen.length, ...pageOf(seen, point.group, input, observationSource) };
    });
    return { rows, outputUnit, explanation: `CUMULATIVE v${spec.version} · order=date,id · points=${rows.length} · missingSkipped=${skippedMissingCount}` };
  }

  if (spec.id === 'MOVING_AVERAGE') {
    const windowSize = input.windowSize ?? 3;
    if (!Number.isInteger(windowSize) || windowSize < 2 || windowSize > 30) throw new BadRequestException('Choose a moving average window between 2 and 30');
    const rows: AnalysisRow[] = baseSeries.map((point, index) => {
      const slice = baseSeries.slice(Math.max(0, index - windowSize + 1), index + 1);
      const avg = divide(slice.reduce((acc, s) => plus(acc, s.val), decimal('0')), decimal(String(slice.length)));
      const windowItems = slice.flatMap((s) => s.items);
      return { group: point.group, label: point.group, value: fractionText(avg), count: windowItems.length, ...pageOf(windowItems, point.group, input, observationSource) };
    });
    return { rows, outputUnit, explanation: `MOVING_AVERAGE v${spec.version} · window=${windowSize} · order=date,id · missingSkipped=${skippedMissingCount}` };
  }

  if (spec.id === 'LINEAR_TREND') {
    const n = baseSeries.length;
    const ys = baseSeries.map((p) => toNumber(p.val));
    const meanX = (n - 1) / 2;
    const meanY = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (i - meanX) * (ys[i] - meanY);
      den += (i - meanX) * (i - meanX);
    }
    const slopeNum = den === 0 ? 0 : num / den;
    const interceptNum = meanY - slopeNum * meanX;
    const slopeText = formatFloat(slopeNum);
    const interceptText = formatFloat(interceptNum);
    const rows: AnalysisRow[] = baseSeries.map((point, index) => ({ group: point.group, label: point.group, value: formatFloat(interceptNum + slopeNum * index), count: point.items.length, ...pageOf(point.items, point.group, input, observationSource) }));
    return { rows, outputUnit, slope: slopeText, explanation: `LINEAR_TREND v${spec.version} · slope=${slopeText}${outputUnit ? ` ${outputUnit}/period` : '/period'} · intercept=${interceptText} · periods=${baseSeries[0].group}..${baseSeries[n - 1].group}` };
  }
  throw new BadRequestException(`Unsupported sequence operation ${spec.id}`);
}

export function executeRegisteredOperation(
  spec: AnalysisOperationSpec,
  observations: ObservationRecord[],
  input: AnalysisInput,
  baseUnit?: string,
  skippedMissingCount = 0,
  isComparison = false,
): RegistryComputationOutput {
  if (spec.requiresDateOrder) {
    const empty = emptyResult(spec, observations.length, baseUnit, isComparison);
    return empty ?? executeSequenceOperation(spec, observations, input, outputUnitFor(spec, input, baseUnit), skippedMissingCount);
  }
  const accumulator = new ObservationAccumulator(spec, input);
  for (const item of observations) accumulator.add(item);
  return accumulator.finish(baseUnit, skippedMissingCount, isComparison);
}
