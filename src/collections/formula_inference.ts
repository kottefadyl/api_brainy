import { BadRequestException } from '@nestjs/common';
import { Collection, CollectionField, CollectionFormat, FieldKind } from './collection.schema';
import { BooleanExpression, Expression, FormulaNode, isDateExpression, isRelatedAggregate, isTextExpression, ObjectPath, parseFormulaDate } from './formula_nodes';
import { Rational, resolveUnit } from './unit_math';

export type UnitInfo = { unit?: string; dimension?: string; root?: string; factor?: Rational };
type NumberType = { type: 'NUMBER'; unknownUnit?: boolean } & UnitInfo;
export type StaticType = NumberType | { type: 'TEXT' } | { type: 'DATE' } | { type: 'DATETIME' } | { type: 'BOOLEAN' };

const unitParts = ({ unit, dimension, root, factor }: UnitInfo): UnitInfo => ({ unit, dimension, root, factor });

const unitPair = (left: UnitInfo, right: UnitInfo): string => `${left.unit ?? 'no unit'} and ${right.unit ?? 'no unit'}`;

export const assertComparable = (left: UnitInfo, right: UnitInfo): void => {
  if (left.dimension !== right.dimension || left.root !== right.root || !!left.unit !== !!right.unit) throw new BadRequestException(`Cannot compare incompatible units: ${unitPair(left, right)}`);
  if (left.unit === right.unit) return;
  if (left.dimension === 'CURRENCY') throw new BadRequestException('Convert currencies with an explicit dated rate first');
  if (left.dimension === 'TEMPERATURE') throw new BadRequestException('Convert temperatures before comparing them');
  // Composite units such as EUR·kg carry no conversion factor.
  if (!left.factor || !right.factor) throw new BadRequestException(`Cannot compare incompatible units: ${unitPair(left, right)}`);
};

export const assertAddable = (left: UnitInfo, right: UnitInfo): void => {
  if (left.dimension !== right.dimension || left.root !== right.root || !!left.unit !== !!right.unit) throw new BadRequestException(`Cannot add incompatible units: ${unitPair(left, right)}`);
  if (left.unit === right.unit) return;
  if (left.dimension === 'CURRENCY') throw new BadRequestException('Convert currencies with an explicit dated rate first');
  if (left.dimension === 'TEMPERATURE') throw new BadRequestException('Convert temperatures before adding them');
  if (!left.factor || !right.factor) throw new BadRequestException(`Cannot add incompatible units: ${unitPair(left, right)}`);
};

export const isDuration = (quantity: UnitInfo): boolean => quantity.dimension === 'TIME' && quantity.root === 'TIME' && !!quantity.factor;
export const isUnitlessZero = (node: Expression): boolean => node.kind === 'number' && !node.unit && /^[+-]?0+(?:\.0+)?$/.test(node.value);

const symbolOf = (unit: string, collection: Collection): string => {
  try { return resolveUnit(unit, collection.units ?? []).unit.symbol; } catch { return unit; }
};

/** A combined unit is real only if the collection defines it, by identifier or by symbol. */
function findLocalUnit(names: string[], collection: Collection): UnitInfo | undefined {
  const found = (collection.units ?? []).find((item) => names.includes(item.id) || names.includes(item.symbol));
  if (!found) return undefined;
  try {
    const resolved = resolveUnit(found.id, collection.units ?? []);
    return { unit: found.id, dimension: resolved.dimension, root: resolved.root, factor: resolved.factor };
  } catch {
    return undefined;
  }
}

export function multiplyUnits(left: UnitInfo, right: UnitInfo, collection: Collection): UnitInfo {
  if (!left.unit || !right.unit) return unitParts(left.unit ? left : right);
  const [a, b] = [symbolOf(left.unit, collection), symbolOf(right.unit, collection)];
  const same = left.unit === right.unit;
  const names = same ? [`${left.unit}²`, `${a}²`] : [`${left.unit}·${right.unit}`, `${a}·${b}`, `${b}·${a}`];
  return findLocalUnit(names, collection) ?? { unit: same ? `${left.unit}²` : `${left.unit}·${right.unit}`, dimension: `${left.dimension}·${right.dimension}` };
}

/** An empty result means a plain ratio, as when dividing two lengths. */
export function divideUnits(left: UnitInfo, right: UnitInfo, collection: Collection): UnitInfo {
  if (!right.unit) return unitParts(left);
  if (left.unit && (left.unit === right.unit || (left.dimension === right.dimension && left.root === right.root && left.factor && right.factor))) return {};
  const [a, b] = [left.unit ? symbolOf(left.unit, collection) : '1', symbolOf(right.unit, collection)];
  const found = left.unit ? findLocalUnit([`${left.unit}/${right.unit}`, `${a}/${b}`], collection) : undefined;
  if (!found) throw new BadRequestException(`Dividing by a unit requires compatible quantities, or the unit ${a}/${b} in this collection`);
  return found;
}

export function pathProperty(node: ObjectPath, collection: Collection, formatId: string): CollectionField | undefined {
  if (node.through !== undefined && (!Array.isArray(node.through) || node.through.length > 4 || node.through.some((id) => typeof id !== 'string'))) throw new BadRequestException('Follow at most five linked objects');
  const hops = [node.referenceFieldId, ...(node.through ?? [])];
  let format = collection.formats.find((item) => item.id === formatId);
  for (const [index, fieldId] of hops.entries()) {
    const reference = format?.fields.find((field) => field.id === fieldId && field.kind === FieldKind.OBJECT_REF && !field.multiple);
    if (!reference) throw new BadRequestException('Choose one numeric property from a single object reference');
    // A snapshot keeps only the referenced object's own values: anything further would be today's data.
    if (reference.referenceMode === 'SNAPSHOT' && index < hops.length - 1) throw new BadRequestException('A snapshot reference cannot be followed further');
    format = collection.formats.find((item) => item.id === reference.targetObjectFormatId);
  }
  return format?.fields.find((field) => field.id === node.propertyFieldId);
}

export function relatedTarget(referenceFieldId: string, collection: Collection, formatId: string): CollectionFormat | undefined {
  const reference = collection.formats.find((item) => item.id === formatId)?.fields.find((field) => field.id === referenceFieldId && field.kind === FieldKind.OBJECT_REF);
  return collection.formats.find((item) => item.id === reference?.targetObjectFormatId);
}

function numberWithUnit(unit: string | undefined, collection: Collection): NumberType {
  if (!unit) return { type: 'NUMBER' };
  try {
    const resolved = resolveUnit(unit, collection.units ?? []);
    return { type: 'NUMBER', unit, dimension: resolved.dimension, root: resolved.root, factor: resolved.factor };
  } catch {
    return { type: 'NUMBER', unknownUnit: true };
  }
}

const UNKNOWN: NumberType = { type: 'NUMBER', unknownUnit: true };

/**
 * Deduces what a formula gives without reading any entry, and refuses what can never work.
 * A unit that cannot be known before evaluation is left open and is still checked then.
 * Call after the structure has been validated.
 */
export function inferStaticType(node: FormulaNode | BooleanExpression, collection: Collection, formatId: string, memo = new Map<string, StaticType>()): StaticType {
  const infer = (child: FormulaNode | BooleanExpression): StaticType => inferStaticType(child, collection, formatId, memo);
  const number = (child: Expression): NumberType => { const result = infer(child); return result.type === 'NUMBER' ? result : UNKNOWN; };
  const compared = (items: NumberType[]): NumberType[] => {
    const known = items.filter((item) => !item.unknownUnit);
    for (const other of known.slice(1)) assertComparable(known[0], other);
    return known;
  };
  /** Alternatives give one value or another, so a plain 0 may stand in for any unit. */
  const alternatives = (nodes: Expression[]): NumberType => {
    const typed = nodes.filter((item) => !isUnitlessZero(item)).map(number);
    return compared(typed)[0] ?? typed[0] ?? { type: 'NUMBER' };
  };

  if (node.kind === 'boolean') return { type: 'BOOLEAN' };
  if (node.kind === 'not') { infer(node.arg); return { type: 'BOOLEAN' }; }
  if (node.kind === 'logical') { node.args.forEach(infer); return { type: 'BOOLEAN' }; }
  if (node.kind === 'comparison') {
    const [left, right] = [infer(node.left), infer(node.right)];
    if (left.type === 'NUMBER' && right.type === 'NUMBER') compared([left, right]);
    return { type: 'BOOLEAN' };
  }

  if (isDateExpression(node)) {
    if (node.kind === 'dateField') return { type: collection.formats.find((item) => item.id === formatId)?.fields.find((field) => field.id === node.fieldId)?.kind === FieldKind.DATETIME ? 'DATETIME' : 'DATE' };
    if (node.kind === 'dateLiteral') return { type: parseFormulaDate(node.value)?.hasTime ? 'DATETIME' : 'DATE' };
    const base = infer(node.date);
    if (node.kind !== 'addDays') return { type: 'DATE' };
    const days = number(node.days);
    if (!days.unknownUnit && days.unit && !isDuration(days)) throw new BadRequestException('Give the number of days as a plain number or a duration');
    return base;
  }

  if (isTextExpression(node)) {
    if (node.kind === 'unitOf' || node.kind === 'formatText') infer(node.value);
    else if (node.kind === 'concat' || node.kind === 'coalesceText') node.args.forEach(infer);
    else if (node.kind === 'substring') {
      infer(node.text);
      if (number(node.start).unit || number(node.length).unit) throw new BadRequestException('Use whole numbers for the start (from 1) and the length (from 0)');
    } else if (node.kind === 'upper' || node.kind === 'lower' || node.kind === 'proper') infer(node.text);
    return { type: 'TEXT' };
  }

  if (node.kind === 'number') return numberWithUnit(node.unit, collection);
  if (node.kind === 'field') {
    const field = collection.formats.find((item) => item.id === formatId)?.fields.find((item) => item.id === node.fieldId);
    return field ? numberWithUnit(field.unit, collection) : UNKNOWN;
  }
  if (node.kind === 'property' || isRelatedAggregate(node)) {
    try {
      const property = node.kind === 'property' ? pathProperty(node, collection, formatId) : relatedTarget(node.referenceFieldId, collection, formatId)?.fields.find((field) => field.id === node.propertyFieldId);
      return property ? numberWithUnit(property.unit, collection) : UNKNOWN;
    } catch {
      return UNKNOWN;
    }
  }
  if (node.kind === 'countRelated') return { type: 'NUMBER' };
  if (node.kind === 'textLength') { infer(node.text); return { type: 'NUMBER' }; }
  if (node.kind === 'datePart') { infer(node.date); return { type: 'NUMBER' }; }
  if (node.kind === 'dateDifference') return numberWithUnit(node.unit, collection);
  if (node.kind === 'dateDiff') {
    infer(node.end);
    infer(node.start);
    return node.unit === 'MONTHS' ? { type: 'NUMBER' } : numberWithUnit(node.unit === 'DAYS' ? 'd' : 'h', collection);
  }
  if (node.kind === 'durationField') return numberWithUnit('s', collection);
  if (node.kind === 'durationIn') {
    const duration = number(node.duration);
    if (!duration.unknownUnit && !isDuration(duration)) throw new BadRequestException('Choose a duration');
    return numberWithUnit(node.unit === 'MINUTES' ? 'min' : 'h', collection);
  }
  if (node.kind === 'round' || node.kind === 'abs' || node.kind === 'floor' || node.kind === 'ceil') return number(node.value);
  if (node.kind === 'coalesce') return alternatives(node.args);
  if (node.kind === 'conditional') { infer(node.condition); return alternatives([node.then, node.else]); }
  if (node.kind === 'min' || node.kind === 'max') { const typed = node.args.map(number); return compared(typed)[0] ?? typed[0]; }
  if (node.kind === 'modulo') { const left = number(node.left); compared([left, number(node.right)]); return left; }
  if (node.kind === 'formula') {
    const known = memo.get(node.formulaId);
    if (known) return known;
    memo.set(node.formulaId, UNKNOWN);
    const target = (collection.formulas ?? []).find((item) => item.id === node.formulaId && item.formatId === formatId);
    if (!target) return UNKNOWN;
    let parsed: FormulaNode;
    try { parsed = JSON.parse(target.expression) as FormulaNode; } catch { return UNKNOWN; }
    const result = infer(parsed);
    memo.set(node.formulaId, result);
    return result;
  }

  const [left, right] = [number(node.args[0]), number(node.args[1])];
  if (left.unknownUnit || right.unknownUnit) return UNKNOWN;
  if (node.operator === 'ADD' || node.operator === 'SUBTRACT') { assertAddable(left, right); return left; }
  return { type: 'NUMBER', ...(node.operator === 'MULTIPLY' ? multiplyUnits(left, right, collection) : divideUnits(left, right, collection)) };
}
