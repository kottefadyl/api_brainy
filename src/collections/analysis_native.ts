import { BadRequestException } from '@nestjs/common';
import { Model, PipelineStage, Types } from 'mongoose';
import { AnalysisInput, AnalysisOperationSpec, AnalysisRow, AnalysisSource } from './analysis.input';
import { distributionReader, emptyResult, GroupStats, groupExplanation, needsDistribution, needsSquares, outputUnitFor, RegistryComputationOutput, scalarFromStats } from './analysis_stats';
import { EntryFilterOperator } from './collection.input';
import { Collection, CollectionField, CollectionFormat, FieldKind } from './collection.schema';
import { Entry } from './entry.schema';
import { inferStaticType } from './formula_inference';
import { Expression, isDateExpression, isTextExpression } from './formula_nodes';
import { fractionText, Rational, resolveUnit } from './unit_math';

type Mql = Record<string, unknown> | unknown[] | string | number | null;
export type PreparedFilter = { field: CollectionField; operator: EntryFilterOperator; value: string };
export type NativeRequest = { collection: Collection; format: CollectionFormat; spec: AnalysisOperationSpec; input: AnalysisInput; field?: CollectionField; formulaExpression?: string; date?: CollectionField; groupField?: CollectionField; filters: PreparedFilter[] };
type Measure = { expression?: Mql; unit: Mql; };
type Plan = { slots: Map<string, string>; measure: Measure; key: Mql; filters: Mql[] };
type StatsDocument = { _id: string | null; count: number; sum?: unknown; squares?: unknown; min?: unknown; max?: unknown; units?: { id: string | null; dimension: string | null }[]; sources: { entryId: string; value: unknown }[] };

const MAX_GROUPS = 1000;
const NATIVE_OPERATIONS = new Set(['COUNT', 'SUM', 'AVERAGE', 'MIN', 'MAX', 'RANGE', 'MEDIAN', 'PERCENTILE', 'PERCENTILE_25', 'PERCENTILE_75', 'PERCENTILE_95', 'VARIANCE', 'STDDEV', 'STDDEV_SAMPLE', 'MODE']);
const literal = (value: unknown): Mql => ({ $literal: value });
const decimalOf = (input: Mql): Mql => ({ $convert: { input, to: 'decimal', onError: null, onNull: null } });
const storedNumber = (slot: string): Mql => decimalOf({ $ifNull: [`$${slot}.numberValue`, `$${slot}.value`] });

/** MongoDB answers in Decimal128, whose text form may use an exponent (1.5E+3). */
function rationalFrom(value: unknown): Rational | undefined {
  if (value === null || value === undefined) return undefined;
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:E([+-]?\d+))?$/i.exec(String(value));
  if (!match) throw new BadRequestException('Invalid numeric result');
  const fraction = match[3] ?? '';
  const exponent = Number(match[4] ?? 0) - fraction.length;
  const digits = BigInt(`${match[2]}${fraction}`) * (match[1] === '-' ? -1n : 1n);
  return exponent >= 0 ? { n: digits * 10n ** BigInt(exponent), d: 1n } : { n: digits, d: 10n ** BigInt(-exponent) };
}

/**
 * Translates a formula when the database can give exactly the same answer.
 * Anything else returns null and is calculated entry by entry, in a stream.
 */
function vectorize(node: Expression, request: NativeRequest, slotFor: (fieldId: string) => string, depth = 0): Mql | undefined {
  if (depth > 16) return undefined;
  const { collection, format } = request;
  const unitOf = (child: Expression): string | undefined | null => { const type = inferStaticType(child, collection, format.id); return type.type === 'NUMBER' && !type.unknownUnit ? type.unit : null; };
  const child = (item: Expression): Mql | undefined => vectorize(item, request, slotFor, depth + 1);
  if (node.kind === 'number') return node.unit ? undefined : literal(Types.Decimal128.fromString(node.value));
  if (node.kind === 'field') return format.fields.some((item) => item.id === node.fieldId && item.kind === FieldKind.NUMBER) ? storedNumber(slotFor(node.fieldId)) : undefined;
  if (node.kind === 'abs' || node.kind === 'floor' || node.kind === 'ceil') {
    const inner = child(node.value);
    return inner === undefined ? undefined : { [`$${node.kind}`]: inner };
  }
  if (node.kind === 'formula') {
    const target = (collection.formulas ?? []).find((item) => item.id === node.formulaId && item.formatId === format.id);
    if (!target) return undefined;
    const parsed = JSON.parse(target.expression) as Expression;
    return isDateExpression(parsed) || isTextExpression(parsed) ? undefined : child(parsed);
  }
  if (node.kind !== 'operation') return undefined;
  const [left, right] = node.args;
  const [leftUnit, rightUnit] = [unitOf(left), unitOf(right)];
  if (leftUnit === null || rightUnit === null) return undefined;
  // Values in different units would need converting first.
  if ((node.operator === 'ADD' || node.operator === 'SUBTRACT') && leftUnit !== rightUnit) return undefined;
  if (node.operator === 'DIVIDE' && rightUnit && leftUnit !== rightUnit) return undefined;
  const [a, b] = [child(left), child(right)];
  if (a === undefined || b === undefined) return undefined;
  return { [{ ADD: '$add', SUBTRACT: '$subtract', MULTIPLY: '$multiply', DIVIDE: '$divide' }[node.operator]]: [a, b] };
}

function keyExpression(request: NativeRequest, slotFor: (fieldId: string) => string): Mql | undefined {
  const { input, date, groupField, collection } = request;
  if (input.groupBy === 'NONE') return literal('All');
  if (input.groupBy === 'DAY' || input.groupBy === 'MONTH') {
    const slot = slotFor(date!.id);
    return { $cond: [{ $eq: [{ $type: `$${slot}.value` }, 'string'] }, { $substrCP: [`$${slot}.value`, 0, input.groupBy === 'DAY' ? 10 : 7] }, 'Missing date'] };
  }
  const slot = slotFor(groupField!.id);
  if (input.groupBy === 'OBJECT') return { $ifNull: [{ $arrayElemAt: [`$${slot}.objectIds`, 0] }, 'Missing object'] };
  // A depth in a code list needs the hierarchy of the list, which only the API knows.
  if (input.groupDepth !== undefined && collection.codeLists?.some((item) => item.id === groupField!.codeListId)) return undefined;
  return { $cond: [{ $in: [{ $ifNull: [`$${slot}.value`, ''] }, ['']] }, 'Missing category', `$${slot}.value`] };
}

function filterExpression({ field, operator, value }: PreparedFilter, slotFor: (fieldId: string) => string): Mql {
  const slot = slotFor(field.id);
  const present = { $ne: [{ $type: `$${slot}` }, 'missing'] };
  const compare = (left: Mql, right: Mql): Mql => ({ [{ [EntryFilterOperator.EQ]: '$eq', [EntryFilterOperator.GT]: '$gt', [EntryFilterOperator.GTE]: '$gte', [EntryFilterOperator.LT]: '$lt', [EntryFilterOperator.LTE]: '$lte' }[operator as EntryFilterOperator.EQ]]: [left, right] });
  let test: Mql;
  if (operator === EntryFilterOperator.CONTAINS) test = { $regexMatch: { input: { $ifNull: [`$${slot}.value`, ''] }, regex: literal(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), options: 'i' } };
  else if (field.kind === FieldKind.MULTI_SELECT || field.kind === FieldKind.OBJECT_REF) test = operator === EntryFilterOperator.EQ ? { $in: [literal(value), { $ifNull: [field.kind === FieldKind.OBJECT_REF ? `$${slot}.objectIds` : `$${slot}.selectedValues`, []] }] } : false as unknown as Mql;
  else if (field.kind === FieldKind.NUMBER) test = { $and: [{ $ne: [storedNumber(slot), null] }, compare(storedNumber(slot), literal(Types.Decimal128.fromString(value.replace(',', '.'))))] };
  else test = compare(`$${slot}.value`, literal(value));
  return { $and: [present, test] };
}

/** Builds the database plan, or returns null when the analysis must be calculated entry by entry. */
function planFor(request: NativeRequest): Plan | null {
  const { spec, input, field, formulaExpression, collection, format } = request;
  if (!NATIVE_OPERATIONS.has(spec.id) || input.weightFieldId || input.denominatorFieldId || spec.requiresDateOrder) return null;
  if (field?.kind === FieldKind.MEASURE) return null;
  const slots = new Map<string, string>();
  const slotFor = (fieldId: string): string => { if (!slots.has(fieldId)) slots.set(fieldId, `_f${slots.size}`); return slots.get(fieldId)!; };
  const key = keyExpression(request, slotFor);
  if (key === undefined) return null;
  let measure: Measure = { unit: null };
  if (field) {
    let dimension: string | null = null;
    if (field.unit) {
      try { dimension = resolveUnit(field.unit, collection.units ?? []).dimension; } catch { return null; }
    }
    const slot = slotFor(field.id);
    measure = { expression: storedNumber(slot), unit: { id: { $ifNull: [`$${slot}.unitSnapshot.id`, literal(field.unit ?? null)] }, dimension: { $ifNull: [`$${slot}.unitSnapshot.dimension`, literal(dimension)] } } };
  } else if (formulaExpression) {
    try {
      const node = JSON.parse(formulaExpression) as Expression;
      if (isDateExpression(node) || isTextExpression(node)) return null;
      const inferred = inferStaticType(node, collection, format.id);
      if (inferred.type !== 'NUMBER' || inferred.unknownUnit) return null;
      const expression = vectorize(node, request, slotFor);
      if (expression === undefined) return null;
      measure = { expression, unit: { id: literal(inferred.unit ?? null), dimension: literal(inferred.dimension ?? null) } };
    } catch {
      return null;
    }
  }
  return { slots, measure, key, filters: request.filters.map((item) => filterExpression(item, slotFor)) };
}

function baseStages(plan: Plan, spec: AnalysisOperationSpec, match: Record<string, unknown>): PipelineStage[] {
  const elements = Object.fromEntries([...plan.slots].map(([fieldId, slot]) => [slot, { $first: { $filter: { input: '$values', as: 'item', cond: { $eq: ['$$item.fieldId', literal(fieldId)] }, limit: 1 } } }]));
  const number = plan.measure.expression;
  const key = spec.requiresNumeric ? { $cond: [{ $eq: ['$_n', null] }, null, plan.key] } : plan.key;
  return [
    { $match: match },
    { $project: { 'values.attachmentData': 0 } },
    ...(plan.slots.size ? [{ $set: elements }] : []),
    ...(plan.filters.length ? [{ $match: { $expr: { $and: plan.filters } } }] : []),
    ...(number === undefined ? [] : [{ $set: { _n: number } }]),
    { $set: { _k: key } },
    { $project: { _k: 1, _n: 1, ...Object.fromEntries([...plan.slots.values()].map((slot) => [`${slot}.unitSnapshot`, 1])) } },
  ] as PipelineStage[];
}

function statsGroup(plan: Plan, spec: AnalysisOperationSpec, sourceCount: number): PipelineStage {
  const number = plan.measure.expression !== undefined;
  const needsTotals = spec.id === 'SUM' || spec.id === 'AVERAGE' || needsSquares(spec);
  const needsBounds = ['MIN', 'MAX', 'RANGE'].includes(spec.id);
  return {
    $group: {
      _id: '$_k',
      count: { $sum: 1 },
      ...(needsTotals ? { sum: { $sum: '$_n' } } : {}),
      ...(needsSquares(spec) ? { squares: { $sum: { $multiply: ['$_n', '$_n'] } } } : {}),
      ...(needsBounds ? { min: { $min: '$_n' }, max: { $max: '$_n' } } : {}),
      ...(number ? { units: { $addToSet: { $cond: [{ $eq: ['$_n', null] }, '$$REMOVE', plan.measure.unit] } } } : {}),
      sources: { $topN: { n: sourceCount, sortBy: { _id: 1 }, output: { entryId: { $toString: '$_id' }, value: number ? '$_n' : literal(null) } } },
    },
  } as PipelineStage;
}

const toSource = (item: { entryId: string; value: unknown }): AnalysisSource => {
  const value = rationalFrom(item.value);
  return { entryId: item.entryId, value: value ? fractionText(value) : '1' };
};

/** Reads each group's values in order through a cursor, keeping only the ranks asked for and the most frequent value. */
async function collectDistribution(entries: Model<Entry>, base: PipelineStage[], spec: AnalysisOperationSpec, input: AnalysisInput, stats: Map<string, GroupStats>): Promise<void> {
  const cursor = entries.aggregate<{ _id: { k: string; n: unknown }; c: number }>([
    ...base,
    { $match: { _k: { $ne: null } } },
    { $group: { _id: { k: '$_k', n: '$_n' }, c: { $sum: 1 } } },
    { $sort: { '_id.k': 1, '_id.n': 1 } },
  ]).option({ allowDiskUse: true }).cursor({ batchSize: 2000 });
  let current: string | undefined;
  let reader: ReturnType<typeof distributionReader> | undefined;
  const flush = () => { if (current !== undefined && reader) Object.assign(stats.get(current)!, reader.result()); };
  for await (const row of cursor) {
    const group = stats.get(row._id.k);
    if (!group) continue;
    if (row._id.k !== current) {
      flush();
      current = row._id.k;
      reader = distributionReader(spec, group.count, input);
    }
    const value = rationalFrom(row._id.n);
    if (value) reader!.read(value, row.c);
  }
  flush();
}

/** Returns null when the request cannot be delegated to the database. */
export async function runNativeAnalysis(entries: Model<Entry>, request: NativeRequest, match: Record<string, unknown>, isComparison: boolean): Promise<(RegistryComputationOutput & { skippedMissingCount: number; unit?: string; dimension?: string }) | null> {
  const plan = planFor(request);
  if (!plan) return null;
  const { spec, input } = request;
  const base = baseStages(plan, spec, match);
  try {
    const documents = await entries.aggregate<StatsDocument>([...base, statsGroup(plan, spec, input.sourceGroup ? 20 : 100), { $limit: MAX_GROUPS + 2 }]).option({ allowDiskUse: true }).exec();
    const skippedMissingCount = documents.find((item) => item._id === null)?.count ?? 0;
    const groups = documents.filter((item): item is StatsDocument & { _id: string } => item._id !== null);
    if (groups.length > MAX_GROUPS) throw new BadRequestException(`Narrow the analysis to at most ${MAX_GROUPS} groups`);
    const units = new Map(groups.flatMap((item) => item.units ?? []).map((item) => [`${item.id ?? ''}|${item.dimension ?? ''}`, item]));
    if (units.size > 1) throw new BadRequestException('Analysis has mixed units; convert before grouping');
    const unit = [...units.values()][0];
    const total = groups.reduce((sum, item) => sum + item.count, 0);
    const empty = emptyResult(spec, total, unit?.id ?? undefined, isComparison);
    if (empty) return { ...empty, skippedMissingCount, unit: unit?.id ?? undefined, dimension: unit?.dimension ?? undefined };
    const stats = new Map<string, GroupStats>(groups.map((item) => [item._id, { count: item.count, sum: rationalFrom(item.sum), squares: rationalFrom(item.squares), min: rationalFrom(item.min), max: rationalFrom(item.max) }]));
    if (needsDistribution(spec)) await collectDistribution(entries, base, spec, input, stats);
    const rows: AnalysisRow[] = [];
    for (const item of [...groups].sort((a, b) => a._id.localeCompare(b._id))) {
      let sources = item.sources.map(toSource);
      let shown = sources.length;
      if (input.sourceGroup === item._id) {
        const offset = input.sourceOffset ?? 0;
        const page = await entries.aggregate<{ _id: Types.ObjectId; _n?: unknown }>([...base, { $match: { _k: item._id } }, { $sort: { _id: 1 } }, { $skip: offset }, { $limit: 100 }]).option({ allowDiskUse: true }).exec();
        sources = page.map((row) => toSource({ entryId: row._id.toString(), value: row._n }));
        shown = offset + sources.length;
      }
      rows.push({ group: item._id, label: item._id, value: fractionText(scalarFromStats(spec, stats.get(item._id)!, input)), count: item.count, sources, sourcesHasMore: item.count > shown });
    }
    return { rows, outputUnit: outputUnitFor(spec, input, unit?.id ?? undefined), explanation: groupExplanation(spec, input, skippedMissingCount), skippedMissingCount, unit: unit?.id ?? undefined, dimension: unit?.dimension ?? undefined };
  } catch (cause) {
    if (cause instanceof Error && !(cause instanceof BadRequestException) && /divide by zero/i.test(cause.message)) throw new BadRequestException('Cannot divide by zero');
    throw cause;
  }
}
