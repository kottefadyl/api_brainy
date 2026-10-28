import { BadRequestException } from '@nestjs/common';
import { AnalysisInput, AnalysisOperationSpec, AnalysisRow, AnalysisSource } from './analysis.input';
import { decimal, divide, fractionText, multiply, Rational } from './unit_math';

const plus = (a: Rational, b: Rational): Rational => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
const negate = (a: Rational): Rational => ({ n: -a.n, d: a.d });
const compareRational = (a: Rational, b: Rational): number => {
  const diff = a.n * b.d - b.n * a.d;
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
};
const toNumber = (r: Rational): number => Number(r.n) / Number(r.d);
const formatFloat = (n: number): string => {
  if (!Number.isFinite(n)) throw new BadRequestException('Invalid numeric result');
  const rounded = Math.round(n * 1_000_000) / 1_000_000;
  return fractionText(decimal(rounded.toFixed(6)));
};

export const ANALYSIS_REGISTRY: readonly AnalysisOperationSpec[] = [
  { id: 'COUNT', version: 1, acceptedMeasureKinds: ['EVENT', 'SNAPSHOT', 'RATE'], requiresNumeric: false, requiresDateOrder: false, missingValuePolicy: 'COUNT_ONLY', minObservations: 0, outputKind: 'COUNT' },
  { id: 'SUM', version: 1, acceptedMeasureKinds: ['EVENT'], requiresNumeric: true, requiresDateOrder: false, missingValuePolicy: 'SKIP', minObservations: 1, outputKind: 'SAME_UNIT' },
  { id: 'AVERAGE', version: 1, acceptedMeasureKinds: ['EVENT', 'SNAPSHOT', 'RATE'], requiresNumeric: true, requiresDateOrder: false, missingValuePolicy: 'SKIP', minObservations: 1, outputKind: 'SAME_UNIT' },
  { id: 'MIN', version: 1, acceptedMeasureKinds: ['EVENT', 'SNAPSHOT', 'RATE'], requiresNumeric: true, requiresDateOrder: false, missingValuePolicy: 'SKIP', minObservations: 1, outputKind: 'SAME_UNIT' },
  { id: 'MAX', version: 1, acceptedMeasureKinds: ['EVENT', 'SNAPSHOT', 'RATE'], requiresNumeric: true, requiresDateOrder: false, missingValuePolicy: 'SKIP', minObservations: 1, outputKind: 'SAME_UNIT' },
  { id: 'MEDIAN', version: 1, acceptedMeasureKinds: ['EVENT', 'SNAPSHOT', 'RATE'], requiresNumeric: true, requiresDateOrder: false, missingValuePolicy: 'SKIP', minObservations: 1, outputKind: 'SAME_UNIT' },
  { id: 'PERCENTILE', version: 1, acceptedMeasureKinds: ['EVENT', 'SNAPSHOT', 'RATE'], requiresNumeric: true, requiresDateOrder: false, missingValuePolicy: 'SKIP', minObservations: 1, outputKind: 'SAME_UNIT' },
  { id: 'VARIANCE', version: 1, acceptedMeasureKinds: ['EVENT', 'SNAPSHOT', 'RATE'], requiresNumeric: true, requiresDateOrder: false, missingValuePolicy: 'SKIP', minObservations: 2, outputKind: 'SQUARED_UNIT' },
  { id: 'STDDEV', version: 1, acceptedMeasureKinds: ['EVENT', 'SNAPSHOT', 'RATE'], requiresNumeric: true, requiresDateOrder: false, missingValuePolicy: 'SKIP', minObservations: 2, outputKind: 'SAME_UNIT' },
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

function paginateSources(allSources: AnalysisSource[], key: string, input: AnalysisInput): { sources: AnalysisSource[]; sourcesHasMore: boolean } {
  const offset = input.sourceGroup === key ? (input.sourceOffset ?? 0) : 0;
  const page = (!input.sourceGroup || input.sourceGroup === key) ? allSources.slice(offset, offset + 100) : allSources.slice(0, 20);
  return { sources: page, sourcesHasMore: allSources.length > offset + page.length };
}

function computeGroupScalar(
  spec: AnalysisOperationSpec,
  observations: ObservationRecord[],
  input: AnalysisInput,
): Rational {
  if (spec.id === 'COUNT') return decimal(String(observations.length));
  if (observations.length < spec.minObservations) {
    throw new BadRequestException(`Operation ${spec.id} requires at least ${spec.minObservations} observations (got ${observations.length})`);
  }
  const values = observations.map((item) => item.value!);
  const hasWeights = !!input.weightFieldId;

  if (spec.id === 'SUM' || spec.id === 'CROSSTAB') {
    if (spec.id === 'CROSSTAB' && input.measureKind !== 'EVENT') {
      // Snapshot/Rate crosstab uses average
      return computeGroupScalar(getOperationSpec('AVERAGE'), observations, input);
    }
    if (hasWeights) {
      return observations.reduce((acc, item) => plus(acc, multiply(item.value!, item.weight ?? decimal('1'))), decimal('0'));
    }
    return values.reduce((acc, v) => plus(acc, v), decimal('0'));
  }

  if (spec.id === 'AVERAGE') {
    if (hasWeights) {
      const weightedSum = observations.reduce((acc, item) => plus(acc, multiply(item.value!, item.weight ?? decimal('0'))), decimal('0'));
      const totalWeight = observations.reduce((acc, item) => plus(acc, item.weight ?? decimal('0')), decimal('0'));
      if (totalWeight.n <= 0n) throw new BadRequestException('Total weight must be strictly positive');
      return divide(weightedSum, totalWeight);
    }
    const sum = values.reduce((acc, v) => plus(acc, v), decimal('0'));
    return divide(sum, decimal(String(values.length)));
  }

  const sorted = [...values].sort(compareRational);
  if (spec.id === 'MIN') return sorted[0];
  if (spec.id === 'MAX') return sorted[sorted.length - 1];
  if (spec.id === 'RANGE') return plus(sorted[sorted.length - 1], negate(sorted[0]));

  if (spec.id === 'MEDIAN') {
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
      ? sorted[mid]
      : divide(plus(sorted[mid - 1], sorted[mid]), decimal('2'));
  }

  if (spec.id === 'PERCENTILE') {
    const p = input.percentile ?? 95;
    if (!Number.isInteger(p) || p < 1 || p > 99) throw new BadRequestException('Choose a percentile between 1 and 99');
    const rankIndex = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[rankIndex];
  }

  if (spec.id === 'VARIANCE' || spec.id === 'STDDEV') {
    const mean = divide(values.reduce((acc, v) => plus(acc, v), decimal('0')), decimal(String(values.length)));
    const sqSum = values.reduce((acc, v) => {
      const diff = plus(v, negate(mean));
      return plus(acc, multiply(diff, diff));
    }, decimal('0'));
    const variance = divide(sqSum, decimal(String(values.length)));
    if (spec.id === 'VARIANCE') return variance;
    return decimal(formatFloat(Math.sqrt(Math.max(0, toNumber(variance)))));
  }

  if (spec.id === 'RATE_PER_N') {
    const base = input.rateBase ?? 1000;
    if (!Number.isInteger(base) || base <= 0 || base > 1_000_000_000) throw new BadRequestException('Choose a positive rate base (e.g. 1000)');
    const numerator = hasWeights
      ? observations.reduce((acc, item) => plus(acc, multiply(item.value!, item.weight ?? decimal('1'))), decimal('0'))
      : values.reduce((acc, v) => plus(acc, v), decimal('0'));
    let denominator: Rational;
    if (input.denominatorValue?.trim()) {
      denominator = decimal(input.denominatorValue.trim().replace(',', '.'));
    } else if (input.denominatorFieldId) {
      denominator = observations.reduce((acc, item) => plus(acc, item.denominator ?? decimal('0')), decimal('0'));
    } else {
      throw new BadRequestException('Choose a positive denominator value or field for rate calculation');
    }
    if (denominator.n <= 0n) throw new BadRequestException('Denominator must be strictly positive');
    return multiply(divide(numerator, denominator), decimal(String(base)));
  }

  throw new BadRequestException(`Unsupported scalar operation ${spec.id}`);
}

export function executeRegisteredOperation(
  spec: AnalysisOperationSpec,
  observations: ObservationRecord[],
  input: AnalysisInput,
  baseUnit?: string,
  skippedMissingCount = 0,
  isComparison = false,
): RegistryComputationOutput {
  if (observations.length === 0 && (isComparison || spec.minObservations <= 1)) {
    return { rows: [], outputUnit: spec.outputKind === 'COUNT' ? undefined : baseUnit, explanation: `${spec.id} v${spec.version} · empty` };
  }
  if (spec.id !== 'COUNT' && observations.length < spec.minObservations) {
    throw new BadRequestException(`Not enough observations for ${spec.id} (minimum ${spec.minObservations}, found ${observations.length})`);
  }

  let outputUnit = baseUnit;
  if (spec.outputKind === 'COUNT') outputUnit = undefined;
  else if (spec.outputKind === 'SQUARED_UNIT') outputUnit = baseUnit ? `${baseUnit}²` : undefined;
  else if (spec.outputKind === 'PERCENT') outputUnit = '%';
  else if (spec.outputKind === 'RATE_PER_N') {
    const base = input.rateBase ?? 1000;
    outputUnit = baseUnit ? `${baseUnit}/${base}` : `/${base}`;
  }

  // 1. Sequence Operations (ordered by dateValue asc, entryId asc)
  if (spec.requiresDateOrder) {
    const ordered = [...observations].sort((a, b) => {
      const dateCmp = (a.dateValue ?? '').localeCompare(b.dateValue ?? '');
      return dateCmp !== 0 ? dateCmp : a.entryId.localeCompare(b.entryId);
    });

    if (spec.id === 'SUCCESSIVE_DIFF' || spec.id === 'SUCCESSIVE_VARIATION') {
      const deltas = new Map<string, { values: Rational[]; sources: AnalysisSource[] }>();
      for (let i = 1; i < ordered.length; i++) {
        const prev = ordered[i - 1];
        const curr = ordered[i];
        const rawDiff = plus(curr.value!, negate(prev.value!));
        let stepValue: Rational;
        if (spec.id === 'SUCCESSIVE_DIFF') {
          if (rawDiff.n < 0n) {
            if (curr.counterReset) {
              stepValue = curr.value!;
            } else {
              throw new BadRequestException('Counter decreased without a declared counter reset');
            }
          } else {
            stepValue = rawDiff;
          }
        } else {
          if (prev.value!.n === 0n) throw new BadRequestException('Cannot compute percentage variation from zero');
          const absPrev: Rational = { n: prev.value!.n < 0n ? -prev.value!.n : prev.value!.n, d: prev.value!.d };
          stepValue = multiply(divide(rawDiff, absPrev), decimal('100'));
        }
        const key = input.groupBy === 'NONE' ? 'All' : curr.primaryKey;
        const bucket = deltas.get(key) ?? { values: [], sources: [] };
        bucket.values.push(stepValue);
        bucket.sources.push({ entryId: curr.entryId, value: fractionText(stepValue) });
        deltas.set(key, bucket);
      }
      const rows = [...deltas.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, data]) => {
        const val = spec.id === 'SUCCESSIVE_DIFF'
          ? data.values.reduce((acc, v) => plus(acc, v), decimal('0'))
          : divide(data.values.reduce((acc, v) => plus(acc, v), decimal('0')), decimal(String(data.values.length)));
        const paged = paginateSources(data.sources, group, input);
        return { group, label: group, value: fractionText(val), count: data.values.length, ...paged };
      });
      return {
        rows,
        outputUnit,
        explanation: `${spec.id} v${spec.version} · order=date,id · pairs=${ordered.length - 1} · missingSkipped=${skippedMissingCount}`,
      };
    }

    // Group ordered observations into chronological buckets for CUMULATIVE, MOVING_AVERAGE, LINEAR_TREND
    const buckets = new Map<string, ObservationRecord[]>();
    for (const obs of ordered) {
      const key = input.groupBy === 'NONE' ? `${obs.dateValue ?? ''}#${obs.entryId.slice(-6)}` : obs.primaryKey;
      const list = buckets.get(key) ?? [];
      list.push(obs);
      buckets.set(key, list);
    }
    const baseSeries = [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, items]) => {
      const baseOp = input.measureKind === 'EVENT' ? getOperationSpec('SUM') : getOperationSpec('AVERAGE');
      const val = computeGroupScalar(baseOp, items, input);
      const allSources = items.map((item) => ({ entryId: item.entryId, value: fractionText(item.value!) }));
      return { group, val, count: items.length, allSources };
    });

    if (baseSeries.length < spec.minObservations) {
      throw new BadRequestException(`Operation ${spec.id} requires at least ${spec.minObservations} ordered periods (got ${baseSeries.length})`);
    }

    if (spec.id === 'CUMULATIVE') {
      let running = decimal('0');
      const seenSources: AnalysisSource[] = [];
      const rows: AnalysisRow[] = baseSeries.map((point) => {
        running = plus(running, point.val);
        seenSources.push(...point.allSources);
        const paged = paginateSources([...seenSources], point.group, input);
        return { group: point.group, label: point.group, value: fractionText(running), count: seenSources.length, ...paged };
      });
      return {
        rows,
        outputUnit,
        explanation: `CUMULATIVE v${spec.version} · order=date,id · points=${rows.length} · missingSkipped=${skippedMissingCount}`,
      };
    }

    if (spec.id === 'MOVING_AVERAGE') {
      const windowSize = input.windowSize ?? 3;
      if (!Number.isInteger(windowSize) || windowSize < 2 || windowSize > 30) {
        throw new BadRequestException('Choose a moving average window between 2 and 30');
      }
      const rows: AnalysisRow[] = baseSeries.map((point, index) => {
        const start = Math.max(0, index - windowSize + 1);
        const slice = baseSeries.slice(start, index + 1);
        const avg = divide(slice.reduce((acc, s) => plus(acc, s.val), decimal('0')), decimal(String(slice.length)));
        const windowSources = slice.flatMap((s) => s.allSources);
        const paged = paginateSources(windowSources, point.group, input);
        return { group: point.group, label: point.group, value: fractionText(avg), count: windowSources.length, ...paged };
      });
      return {
        rows,
        outputUnit,
        explanation: `MOVING_AVERAGE v${spec.version} · window=${windowSize} · order=date,id · missingSkipped=${skippedMissingCount}`,
      };
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
      const rows: AnalysisRow[] = baseSeries.map((point, index) => {
        const fitted = formatFloat(interceptNum + slopeNum * index);
        const paged = paginateSources(point.allSources, point.group, input);
        return { group: point.group, label: point.group, value: fitted, count: point.count, ...paged };
      });
      return {
        rows,
        outputUnit,
        slope: slopeText,
        explanation: `LINEAR_TREND v${spec.version} · slope=${slopeText}${outputUnit ? ` ${outputUnit}/period` : '/period'} · intercept=${interceptText} · periods=${baseSeries[0].group}..${baseSeries[n - 1].group}`,
      };
    }
  }

  // 2. Cross-tabulation (rowKey × columnKey)
  if (spec.id === 'CROSSTAB') {
    if (!input.secondaryGroupBy || input.groupBy === 'NONE' || input.secondaryGroupBy === 'NONE') {
      throw new BadRequestException('Cross-tabulation requires both primary and secondary groupings');
    }
    const cells = new Map<string, { rowKey: string; columnKey: string; items: ObservationRecord[] }>();
    for (const obs of observations) {
      const rowKey = obs.primaryKey;
      const columnKey = obs.secondaryKey ?? 'Missing';
      const cellKey = `${rowKey} × ${columnKey}`;
      const cell = cells.get(cellKey) ?? { rowKey, columnKey, items: [] };
      cell.items.push(obs);
      cells.set(cellKey, cell);
    }
    const rows: AnalysisRow[] = [...cells.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, cell]) => {
      const val = computeGroupScalar(spec, cell.items, input);
      const allSources = cell.items.map((item) => ({ entryId: item.entryId, value: fractionText(item.value!) }));
      const paged = paginateSources(allSources, group, input);
      return {
        group,
        label: group,
        rowKey: cell.rowKey,
        columnKey: cell.columnKey,
        value: fractionText(val),
        count: cell.items.length,
        ...paged,
      };
    });
    return {
      rows,
      outputUnit,
      explanation: `CROSSTAB v${spec.version} · ${input.groupBy} × ${input.secondaryGroupBy} · cells=${rows.length} · missingSkipped=${skippedMissingCount}`,
    };
  }

  // 3. Standard & Extended Group Aggregations
  const groups = new Map<string, ObservationRecord[]>();
  for (const obs of observations) {
    const list = groups.get(obs.primaryKey) ?? [];
    list.push(obs);
    groups.set(obs.primaryKey, list);
  }
  const rows: AnalysisRow[] = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, items]) => {
    const val = computeGroupScalar(spec, items, input);
    const allSources = items.map((item) => ({
      entryId: item.entryId,
      value: item.value ? fractionText(item.value) : '1',
    }));
    const paged = paginateSources(allSources, group, input);
    return {
      group,
      label: group,
      value: fractionText(val),
      count: items.length,
      ...paged,
    };
  });

  const hasEstimated = observations.some((item) => item.status === 'ESTIMATED');
  let uncertaintyNote = '';
  let propagatedUncertainty: string | undefined;
  if (['SUM', 'AVERAGE'].includes(spec.id)) {
    const withUncertainty = observations.filter((item) => item.uncertainty !== undefined && item.uncertainty !== '');
    if (withUncertainty.length > 0) {
      if (withUncertainty.length === observations.length && withUncertainty.every((u) => u.uncertaintyType === 'ABSOLUTE' || !u.uncertaintyType)) {
        const uValues = withUncertainty.map((u) => Number(u.uncertainty));
        const sumSq = uValues.reduce((acc, u) => acc + u * u, 0);
        const res = spec.id === 'SUM' ? Math.sqrt(sumSq) : Math.sqrt(sumSq) / observations.length;
        propagatedUncertainty = (Math.round(res * 1000000) / 1000000).toString();
        uncertaintyNote = ` · ± ${propagatedUncertainty}`;
      } else {
        uncertaintyNote = ' · incertitude non propagée';
      }
    }
  }

  return {
    rows,
    outputUnit,
    explanation: `${spec.id} v${spec.version}${input.weightFieldId ? ' · weighted' : ''}${spec.id === 'PERCENTILE' ? ` · p=${input.percentile ?? 95}` : ''}${spec.id === 'RATE_PER_N' ? ` · per ${input.rateBase ?? 1000}` : ''} · missingSkipped=${skippedMissingCount}${hasEstimated ? ' · inclut des valeurs estimées' : ''}${uncertaintyNote}`,
    hasEstimated,
    propagatedUncertainty,
  };
}
