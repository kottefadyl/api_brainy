import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { AnalysisInput, AnalysisResult, AnalysisRow, FormulaInput, FormulaPreview, FormulaResult, FormulaStaticType } from './analysis.input';
import { runNativeAnalysis } from './analysis_native';
import { executeRegisteredOperation, getOperationSpec, ObservationRecord } from './analysis_registry';
import { ObservationAccumulator } from './analysis_stats';
import { EntryFieldFilterInput, EntryFilterOperator } from './collection.input';
import { Collection, CollectionField, CollectionFormula, FieldKind } from './collection.schema';
import { codeAtDepth } from './classification.logic';
import { ZoneAnalysisService } from './zone-analysis.service';
import { CollaborationService } from './collaboration.service';
import { assertSensitiveAnalysisRequest, enforceSensitiveAggregate } from './sensitivity.logic';
import { recordSensitiveAggregate } from './sensitive-aggregate-watch';
import { Entry, EntryValue } from './entry.schema';
import { decimal, divide, fractionText, multiply, Rational, resolveUnit } from './unit_math';
import { assertAddable, assertComparable, divideUnits, inferStaticType, isDuration, isUnitlessZero, multiplyUnits, pathProperty, relatedTarget, UnitInfo } from './formula_inference';
import { addDaysToDate, BooleanExpression, DateExpression, datePart, describeNode, endOfMonth, Expression, formatDate, formatFormulaDate, formatNumber, FormulaDate, FormulaNode, isDateExpression, isDatePattern, isNumberPattern, isRelatedAggregate, isTextExpression, ObjectPath, parseFormulaDate, RelatedAggregate, splitCharacters, startOfMonth, TextExpression, toProperCase, wholeMonthsBetween } from './formula_nodes';
import { CodeListStore } from './code-list-store.service';

type Quantity = UnitInfo & { value: Rational };
const plus = (a: Rational, b: Rational): Rational => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
const negate = (a: Rational): Rational => ({ n: -a.n, d: a.d });
const inLeftUnit = (left: Quantity, right: Quantity): Rational => (left.unit !== right.unit ? divide(multiply(right.value, right.factor!), left.factor!) : right.value);
const compareRational = (a: Rational, b: Rational): number => { const gap = a.n * b.d - b.n * a.d; return gap < 0n ? -1 : gap > 0n ? 1 : 0; };
const compareQuantities = (left: Quantity, right: Quantity): number => { assertComparable(left, right); return compareRational(left.value, inLeftUnit(left, right)); };
type LinkedValue = { raw: string; unitSnapshot?: EntryValue['unitSnapshot']; field?: CollectionField };
const textFieldKinds = [FieldKind.TEXT, FieldKind.TITLE, FieldKind.CODE, FieldKind.LINK];
const numericOnly = (node: FormulaNode): Expression => {
  if (isDateExpression(node)) throw new BadRequestException('This formula gives a date, not a number');
  if (isTextExpression(node)) throw new BadRequestException('This formula gives text, not a number');
  return node;
};
const wholeNumber = (quantity: Quantity, minimum: bigint): bigint => {
  if (quantity.unit || quantity.value.n % quantity.value.d !== 0n || quantity.value.n / quantity.value.d < minimum) throw new BadRequestException('Use whole numbers for the start (from 1) and the length (from 0)');
  return quantity.value.n / quantity.value.d;
};
const wholeDays = (quantity: Quantity): bigint => {
  let days = quantity.value;
  if (quantity.unit) {
    if (!isDuration(quantity)) throw new BadRequestException('Give the number of days as a plain number or a duration');
    days = divide(multiply(quantity.value, quantity.factor!), { n: 86400n, d: 1n });
  }
  if (days.n % days.d !== 0n) throw new BadRequestException('Use a whole number of days');
  return days.n / days.d;
};
/** Floored remainder: the result takes the sign of the divisor, as MOD does in spreadsheets. */
const modulo = (a: Rational, b: Rational): Rational => {
  if (b.n === 0n) throw new BadRequestException('Cannot divide by zero');
  const divisor = b.n * a.d;
  const remainder = (a.n * b.d) % divisor;
  return { n: remainder !== 0n && remainder < 0n !== divisor < 0n ? remainder + divisor : remainder, d: a.d * b.d };
};

@Injectable()
export class AnalysisService {
  constructor(@InjectModel(Collection.name) private readonly collections: Model<Collection>, @InjectModel(Entry.name) private readonly entries: Model<Entry>, private readonly zoneAnalysis: ZoneAnalysisService, private readonly collaboration: CollaborationService, private readonly codeLists: CodeListStore) {}

  private async collection(collectionId: string, ownerId: string): Promise<Collection> {
    if (!Types.ObjectId.isValid(collectionId)) throw new NotFoundException('Collection not found');
    const collection = await this.collections.findOne({ _id: collectionId, ownerId }).exec();
    if (!collection) throw new NotFoundException('Collection not found');
    return collection;
  }

  private parse(text: string): FormulaNode {
    if (text.length > 8000) throw new BadRequestException('Formula is too long');
    let expression: unknown;
    try { expression = JSON.parse(text); } catch { throw new BadRequestException('Invalid formula expression'); }
    if (!expression || typeof expression !== 'object' || Array.isArray(expression)) throw new BadRequestException('Invalid formula expression');
    return expression as FormulaNode;
  }

  private parseNumeric(text: string): Expression {
    return numericOnly(this.parse(text));
  }

  private inspect(node: Expression, collection: Collection, formatId: string, references: Set<string>, depth = 0, budget = { count: 0 }): void {
    if (++budget.count > 64 || depth > 12 || !node || typeof node !== 'object') throw new BadRequestException('Formula is too complex');
    const format = collection.formats.find((item) => item.id === formatId);
    if (!format) throw new BadRequestException('Data format not found');
    numericOnly(node);
    if (node.kind === 'number') {
      decimal(node.value);
      if (node.unit) resolveUnit(node.unit, collection.units ?? []);
    } else if (node.kind === 'field') {
      if (!format.fields.some((field) => field.id === node.fieldId && field.kind === FieldKind.NUMBER)) throw new BadRequestException('Choose a numeric field in this data format');
    } else if (node.kind === 'property') {
      const property = pathProperty(node, collection, formatId);
      if (!property) throw new BadRequestException('This property does not exist on the linked object');
      if (property.kind !== FieldKind.NUMBER) throw new BadRequestException('Choose one numeric property from a single object reference');
    } else if (isRelatedAggregate(node)) {
      if (relatedTarget(node.referenceFieldId, collection, formatId)?.fields.find((field) => field.id === node.propertyFieldId)?.kind !== FieldKind.NUMBER) throw new BadRequestException('Choose a numeric property from an object reference');
    } else if (node.kind === 'countRelated') {
      const target = relatedTarget(node.referenceFieldId, collection, formatId);
      if (!target || (node.propertyFieldId !== undefined && !target.fields.some((field) => field.id === node.propertyFieldId))) throw new BadRequestException('Choose an object reference and one of its properties');
    } else if (node.kind === 'coalesce') {
      if (!Array.isArray(node.args) || node.args.length < 2) throw new BadRequestException('Choose a value and at least one fallback');
      for (const argument of node.args) this.inspect(argument, collection, formatId, references, depth + 1, budget);
    } else if (node.kind === 'formula') {
      if (typeof node.formulaId !== 'string') throw new BadRequestException('Invalid formula reference');
      references.add(node.formulaId);
      const target = (collection.formulas ?? []).find((item) => item.id === node.formulaId);
      if (target) this.parseNumeric(target.expression);
    } else if (node.kind === 'textLength') {
      this.inspectText(node.text, collection, formatId, references, depth + 1, budget);
    } else if (node.kind === 'dateDiff') {
      if (!['DAYS', 'HOURS', 'MONTHS'].includes(node.unit)) throw new BadRequestException('Choose days, hours or months');
      this.inspectDate(node.end, collection, formatId, references, depth + 1, budget);
      this.inspectDate(node.start, collection, formatId, references, depth + 1, budget);
    } else if (node.kind === 'datePart') {
      if (!['YEAR', 'MONTH', 'DAY', 'WEEKDAY'].includes(node.part)) throw new BadRequestException('Choose year, month, day or weekday');
      this.inspectDate(node.date, collection, formatId, references, depth + 1, budget);
    } else if (node.kind === 'durationField') {
      if (!format.fields.some((field) => field.id === node.fieldId && field.kind === FieldKind.DURATION)) throw new BadRequestException('Choose a duration field in this data format');
    } else if (node.kind === 'durationIn') {
      if (!['MINUTES', 'HOURS'].includes(node.unit)) throw new BadRequestException('Choose minutes or hours');
      this.inspect(node.duration, collection, formatId, references, depth + 1, budget);
    } else if (node.kind === 'dateDifference') {
      const from = format.fields.find((field) => field.id === node.fromFieldId);
      const to = format.fields.find((field) => field.id === node.toFieldId);
      if (!from || !to || from.kind !== to.kind || ![FieldKind.DATE, FieldKind.DATETIME].includes(from.kind) || !['d', 'h'].includes(node.unit)) throw new BadRequestException('Choose two compatible date fields and a time unit');
    } else if (node.kind === 'round') {
      if (!Number.isInteger(node.digits) || node.digits < 0 || node.digits > 6 || !['HALF_UP', 'HALF_EVEN'].includes(node.mode)) throw new BadRequestException('Choose 0 to 6 decimal places and a rounding rule');
      this.inspect(node.value, collection, formatId, references, depth + 1, budget);
    } else if (node.kind === 'operation') {
      if (!['ADD', 'SUBTRACT', 'MULTIPLY', 'DIVIDE'].includes(node.operator) || !Array.isArray(node.args) || node.args.length !== 2) throw new BadRequestException('Choose a binary arithmetic operation');
      for (const argument of node.args) this.inspect(argument, collection, formatId, references, depth + 1, budget);
    } else if (node.kind === 'conditional') {
      this.inspectBoolean(node.condition, collection, formatId, references, depth + 1, budget);
      this.inspect(node.then, collection, formatId, references, depth + 1, budget);
      this.inspect(node.else, collection, formatId, references, depth + 1, budget);
    } else if (node.kind === 'min' || node.kind === 'max') {
      if (!Array.isArray(node.args) || node.args.length < 2) throw new BadRequestException('Choose at least two values to compare');
      for (const argument of node.args) this.inspect(argument, collection, formatId, references, depth + 1, budget);
    } else if (node.kind === 'abs' || node.kind === 'floor' || node.kind === 'ceil') {
      this.inspect(node.value, collection, formatId, references, depth + 1, budget);
    } else if (node.kind === 'modulo') {
      this.inspect(node.left, collection, formatId, references, depth + 1, budget);
      this.inspect(node.right, collection, formatId, references, depth + 1, budget);
    } else if (describeNode(node) === 'a condition') {
      throw new BadRequestException('Expected a number but found a condition');
    } else throw new BadRequestException('Unknown formula operation');
  }

  private inspectDate(node: DateExpression, collection: Collection, formatId: string, references: Set<string>, depth: number, budget: { count: number }): void {
    if (++budget.count > 64 || depth > 12 || !node || typeof node !== 'object') throw new BadRequestException('Formula is too complex');
    if (node.kind === 'dateField') {
      const format = collection.formats.find((item) => item.id === formatId);
      if (!format?.fields.some((field) => field.id === node.fieldId && [FieldKind.DATE, FieldKind.DATETIME].includes(field.kind))) throw new BadRequestException('Choose a date field in this data format');
    } else if (node.kind === 'dateLiteral') {
      if (!parseFormulaDate(node.value)) throw new BadRequestException('Use a valid date');
    } else if (node.kind === 'startOfMonth' || node.kind === 'endOfMonth') {
      this.inspectDate(node.date, collection, formatId, references, depth + 1, budget);
    } else if (node.kind === 'addDays') {
      this.inspectDate(node.date, collection, formatId, references, depth + 1, budget);
      this.inspect(node.days, collection, formatId, references, depth + 1, budget);
      if (node.days.kind === 'number') wholeDays(this.quantity(node.days.value, node.days.unit, collection));
    } else throw new BadRequestException(describeNode(node) ? `Expected a date but found ${describeNode(node)}` : 'Unknown date operation');
  }

  private inspectText(node: TextExpression, collection: Collection, formatId: string, references: Set<string>, depth: number, budget: { count: number }): void {
    if (++budget.count > 64 || depth > 12 || !node || typeof node !== 'object') throw new BadRequestException('Formula is too complex');
    if (node.kind === 'textField') {
      const format = collection.formats.find((item) => item.id === formatId);
      if (!format?.fields.some((field) => field.id === node.fieldId && textFieldKinds.includes(field.kind))) throw new BadRequestException('Choose a text, title, code or link field in this data format');
    } else if (node.kind === 'textProperty') {
      const property = pathProperty(node, collection, formatId);
      if (!property) throw new BadRequestException('This property does not exist on the linked object');
      if (!textFieldKinds.includes(property.kind)) throw new BadRequestException('Choose a text, title, code or link property');
    } else if (node.kind === 'unitOf') {
      this.inspect(node.value, collection, formatId, references, depth + 1, budget);
    } else if (node.kind === 'coalesceText') {
      if (!Array.isArray(node.args) || node.args.length < 2) throw new BadRequestException('Choose a value and at least one fallback');
      for (const argument of node.args) this.inspectText(argument, collection, formatId, references, depth + 1, budget);
    } else if (node.kind === 'textLiteral') {
      if (typeof node.value !== 'string' || node.value.length > 1000) throw new BadRequestException('Use a text of at most 1000 characters');
    } else if (node.kind === 'upper' || node.kind === 'lower' || node.kind === 'proper') {
      this.inspectText(node.text, collection, formatId, references, depth + 1, budget);
    } else if (node.kind === 'concat') {
      if (!Array.isArray(node.args) || node.args.length < 2) throw new BadRequestException('Choose at least two texts to join');
      for (const argument of node.args) this.inspectText(argument, collection, formatId, references, depth + 1, budget);
    } else if (node.kind === 'substring') {
      this.inspectText(node.text, collection, formatId, references, depth + 1, budget);
      for (const [position, minimum] of [[node.start, 1n], [node.length, 0n]] as const) {
        this.inspect(position, collection, formatId, references, depth + 1, budget);
        if (position.kind === 'number') wholeNumber(this.quantity(position.value, position.unit, collection), minimum);
      }
    } else if (node.kind === 'formatText') {
      if (!node.value || typeof node.value !== 'object') throw new BadRequestException('Choose a number or a date to format');
      if (node.locale !== undefined && !['en', 'fr'].includes(node.locale)) throw new BadRequestException('Choose English or French formatting');
      if (isDateExpression(node.value)) {
        if (!isDatePattern(node.pattern)) throw new BadRequestException('Use a date format such as DD/MM/YYYY');
        this.inspectDate(node.value, collection, formatId, references, depth + 1, budget);
      } else {
        if (!isNumberPattern(node.pattern)) throw new BadRequestException('Use a number format such as 0.00 or #,##0.00');
        this.inspect(node.value, collection, formatId, references, depth + 1, budget);
      }
    } else throw new BadRequestException(describeNode(node) ? `Expected text but found ${describeNode(node)}` : 'Unknown text operation');
  }

  private inspectBoolean(node: BooleanExpression, collection: Collection, formatId: string, references: Set<string>, depth: number, budget: { count: number }): void {
    if (++budget.count > 64 || depth > 12 || !node || typeof node !== 'object') throw new BadRequestException('Formula is too complex');
    if (node.kind === 'boolean') {
      if (typeof node.value !== 'boolean') throw new BadRequestException('Invalid formula condition');
    } else if (node.kind === 'comparison') {
      if (!['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE'].includes(node.operator)) throw new BadRequestException('Choose a comparison operator');
      const [left, right] = [describeNode(node.left), describeNode(node.right)];
      if (left && right && left !== right) throw new BadRequestException(`Cannot compare ${left} with ${right}`);
      if (left === 'a condition') throw new BadRequestException('Conditions cannot be compared');
      if (left === 'text' && !['EQ', 'NEQ'].includes(node.operator)) throw new BadRequestException('Text can only be tested for equal or different');
      this.inspectValue(node.left, collection, formatId, references, depth + 1, budget);
      this.inspectValue(node.right, collection, formatId, references, depth + 1, budget);
    } else if (node.kind === 'logical') {
      if (!['AND', 'OR'].includes(node.operator) || !Array.isArray(node.args) || node.args.length < 1) throw new BadRequestException('Choose a logical operator and its conditions');
      for (const argument of node.args) this.inspectBoolean(argument, collection, formatId, references, depth + 1, budget);
    } else if (node.kind === 'not') {
      this.inspectBoolean(node.arg, collection, formatId, references, depth + 1, budget);
    } else throw new BadRequestException(describeNode(node) ? `Expected a condition but found ${describeNode(node)}` : 'Invalid formula condition');
  }

  private inspectValue(node: FormulaNode, collection: Collection, formatId: string, references: Set<string>, depth: number, budget: { count: number }): void {
    if (node && typeof node === 'object' && isDateExpression(node)) this.inspectDate(node, collection, formatId, references, depth, budget);
    else if (node && typeof node === 'object' && isTextExpression(node)) this.inspectText(node, collection, formatId, references, depth, budget);
    else this.inspect(node, collection, formatId, references, depth, budget);
  }

  private inspectRoot(parsed: FormulaNode, collection: Collection, formatId: string, dependencies: Set<string>): void {
    this.inspectValue(parsed, collection, formatId, dependencies, 0, { count: 0 });
  }

  /** Reports what a formula would give, with the same refusals as saving it. */
  async inferFormula(collectionId: string, ownerId: string, formatId: string, expression: string): Promise<FormulaStaticType> {
    const collection = await this.collection(collectionId, ownerId);
    if (!collection.formats.some((item) => item.id === formatId)) throw new BadRequestException('Data format not found');
    const parsed = this.parse(expression);
    this.inspectRoot(parsed, collection, formatId, new Set<string>());
    const inferred = inferStaticType(parsed, collection, formatId);
    return inferred.type === 'NUMBER' ? { type: 'NUMBER', unit: inferred.unit, dimension: inferred.dimension, unitOpen: !!inferred.unknownUnit } : { type: inferred.type, unitOpen: false };
  }

  async saveFormula(collectionId: string, ownerId: string, input: FormulaInput, formulaId?: string): Promise<Collection> {
    const collection = await this.collection(collectionId, ownerId);
    const name = input.name.trim();
    if (!name || name.length > 80) throw new BadRequestException('Formula name must be 1 to 80 characters');
    if (!collection.formats.some((item) => item.id === input.formatId)) throw new BadRequestException('Data format not found');
    const existing = (collection.formulas ?? []).find((item) => item.id === formulaId);
    if (formulaId && (!existing || existing.version !== input.expectedVersion)) throw new BadRequestException('Formula changed. Refresh and try again');
    if ((collection.formulas ?? []).some((item) => item.id !== formulaId && item.name.toLocaleLowerCase() === name.toLocaleLowerCase() && item.formatId === input.formatId)) throw new BadRequestException('Formula names must be unique in a data format');
    const dependencies = new Set<string>();
    const parsed = this.parse(input.expression);
    this.inspectRoot(parsed, collection, input.formatId, dependencies);
    const id = formulaId ?? randomUUID();
    const draft: CollectionFormula = { id, name, formatId: input.formatId, expression: input.expression, version: (existing?.version ?? 0) + 1, dependencies: [...dependencies] };
    const formulas = [...(collection.formulas ?? []).filter((item) => item.id !== id), draft];
    if (formulas.length > 100) throw new BadRequestException('This collection has 100 formulas');
    const settled = new Set<string>();
    const path: CollectionFormula[] = [];
    const visit = (formula: CollectionFormula): void => {
      const repeated = path.findIndex((item) => item.id === formula.id);
      if (repeated >= 0) throw new BadRequestException(`Formula cycle detected: ${[...path.slice(repeated), formula].map((item) => item.name).join(' -> ')}`);
      if (settled.has(formula.id)) return;
      path.push(formula);
      for (const dependencyId of formula.dependencies) {
        const dependency = formulas.find((candidate) => candidate.id === dependencyId && candidate.formatId === formula.formatId);
        if (!dependency) throw new BadRequestException('Formula dependency is missing or belongs to another data format');
        visit(dependency);
      }
      path.pop();
      settled.add(formula.id);
    };
    // Starting from the saved formula makes the reported cycle read from the one being edited.
    for (const item of [draft, ...formulas]) visit(item);
    // Runs after the cycle check, so that inference only ever walks an acyclic graph.
    inferStaticType(parsed, collection, input.formatId);
    const updated = await this.collections.findOneAndUpdate({ _id: collectionId, ownerId, ...(formulaId ? { formulas: { $elemMatch: { id: formulaId, version: input.expectedVersion } } } : {}) }, { $set: { formulas } }, { new: true }).exec();
    if (!updated) throw new BadRequestException('Formula changed. Refresh and try again');
    return updated;
  }

  async deleteFormula(collectionId: string, ownerId: string, formulaId: string): Promise<Collection> {
    const collection = await this.collection(collectionId, ownerId);
    if (!(collection.formulas ?? []).some((item) => item.id === formulaId)) throw new NotFoundException('Formula not found');
    if (collection.formulas.some((item) => item.dependencies.includes(formulaId))) throw new BadRequestException('Another formula uses this formula');
    const updated = await this.collections.findOneAndUpdate({ _id: collectionId, ownerId }, { $pull: { formulas: { id: formulaId } } }, { new: true }).exec();
    if (!updated) throw new NotFoundException('Collection not found');
    return updated;
  }

  private quantity(value: string, unit: string | undefined, collection: Collection, snapshot?: { id: string; dimension: string; root: string; factor: string }): Quantity {
    const result: Quantity = { value: decimal(value) };
    if (snapshot) {
      Object.assign(result, { unit: snapshot.id, dimension: snapshot.dimension, root: snapshot.root, factor: decimal(snapshot.factor, true) });
    } else if (unit) {
      const resolved = resolveUnit(unit, collection.units ?? []);
      Object.assign(result, { unit, dimension: resolved.dimension, root: resolved.root, factor: resolved.factor });
    }
    return result;
  }

  private async evaluateNode(node: Expression, collection: Collection, entry: Entry, ownerId: string, depth = 0): Promise<Quantity | undefined> {
    if (depth > 16) throw new BadRequestException('Formula is too deep');
    const format = collection.formats.find((item) => item.id === entry.formatId);
    if (!format) throw new BadRequestException('Data format not found');
    if (node.kind === 'number') return this.quantity(node.value, node.unit, collection);
    if (node.kind === 'field') {
      const field = format.fields.find((item) => item.id === node.fieldId && item.kind === FieldKind.NUMBER);
      const value = entry.values.find((item) => item.fieldId === node.fieldId);
      return field && value ? this.quantity(value.numberValue ?? value.value, value.unitSnapshot?.id ?? field.unit, collection, value.unitSnapshot) : undefined;
    }
    if (node.kind === 'dateDifference') {
      const from = entry.values.find((item) => item.fieldId === node.fromFieldId)?.value;
      const to = entry.values.find((item) => item.fieldId === node.toFieldId)?.value;
      if (!from || !to) return undefined;
      const fromTime = Date.parse(from.length === 10 ? `${from}T00:00:00Z` : from);
      const toTime = Date.parse(to.length === 10 ? `${to}T00:00:00Z` : to);
      if (!Number.isFinite(fromTime) || !Number.isFinite(toTime)) throw new BadRequestException('Invalid date value in entry');
      const milliseconds = BigInt(toTime - fromTime);
      const unit = resolveUnit(node.unit, collection.units ?? []);
      return { value: { n: milliseconds, d: node.unit === 'd' ? 86400000n : 3600000n }, unit: node.unit, dimension: unit.dimension, root: unit.root, factor: unit.factor };
    }
    if (node.kind === 'round') {
      const quantity = await this.evaluateNode(node.value, collection, entry, ownerId, depth + 1);
      if (!quantity) return undefined;
      const scale = 10n ** BigInt(node.digits);
      const sign = quantity.value.n < 0n ? -1n : 1n;
      const absolute = quantity.value.n * sign * scale;
      const quotient = absolute / quantity.value.d;
      const remainder = absolute % quantity.value.d;
      const tie = remainder * 2n === quantity.value.d;
      const increment = remainder * 2n > quantity.value.d || (tie && (node.mode === 'HALF_UP' || quotient % 2n !== 0n)) ? 1n : 0n;
      return { ...quantity, value: { n: sign * (quotient + increment), d: scale } };
    }
    if (node.kind === 'property') {
      const found = await this.followPath(node, collection, entry, ownerId);
      return found && this.linkedQuantity(found, collection);
    }
    if (isRelatedAggregate(node)) return this.aggregateRelated(node, collection, entry, ownerId);
    if (node.kind === 'countRelated') {
      const linked = await this.relatedValues(node, collection, entry, ownerId);
      return { value: { n: BigInt(node.propertyFieldId === undefined ? linked.length : linked.filter(Boolean).length), d: 1n } };
    }
    if (node.kind === 'coalesce') {
      for (const argument of node.args) {
        const value = await this.evaluateNode(argument, collection, entry, ownerId, depth + 1);
        if (value) return isUnitlessZero(argument) ? this.withInferredUnit(value, node, collection, format.id) : value;
      }
      return undefined;
    }
    if (node.kind === 'formula') {
      const formula = (collection.formulas ?? []).find((item) => item.id === node.formulaId && item.formatId === entry.formatId);
      if (!formula) throw new BadRequestException('Formula dependency is missing');
      return this.evaluateNode(this.parseNumeric(formula.expression), collection, entry, ownerId, depth + 1);
    }
    if (node.kind === 'textLength') {
      const text = await this.evaluateText(node.text, collection, entry, ownerId, depth + 1);
      return text === undefined ? undefined : { value: { n: BigInt(splitCharacters(text).length), d: 1n } };
    }
    if (node.kind === 'dateDiff') {
      const end = await this.evaluateDate(node.end, collection, entry, ownerId, depth + 1);
      const start = await this.evaluateDate(node.start, collection, entry, ownerId, depth + 1);
      if (!end || !start) return undefined;
      if (node.unit === 'MONTHS') return { value: { n: BigInt(wholeMonthsBetween(start, end)), d: 1n } };
      const unit = node.unit === 'DAYS' ? 'd' : 'h';
      const resolved = resolveUnit(unit, collection.units ?? []);
      return { value: { n: BigInt(end.ms - start.ms), d: node.unit === 'DAYS' ? 86400000n : 3600000n }, unit, dimension: resolved.dimension, root: resolved.root, factor: resolved.factor };
    }
    if (node.kind === 'datePart') {
      const date = await this.evaluateDate(node.date, collection, entry, ownerId, depth + 1);
      return date ? { value: { n: BigInt(datePart(date, node.part)), d: 1n } } : undefined;
    }
    if (node.kind === 'durationField') {
      const seconds = format.fields.some((item) => item.id === node.fieldId && item.kind === FieldKind.DURATION) ? entry.values.find((item) => item.fieldId === node.fieldId)?.durationSeconds : undefined;
      if (!Number.isSafeInteger(seconds)) return undefined;
      const resolved = resolveUnit('s', collection.units ?? []);
      return { value: { n: BigInt(seconds!), d: 1n }, unit: 's', dimension: resolved.dimension, root: resolved.root, factor: resolved.factor };
    }
    if (node.kind === 'durationIn') {
      const duration = await this.evaluateNode(node.duration, collection, entry, ownerId, depth + 1);
      if (!duration) return undefined;
      if (!isDuration(duration)) throw new BadRequestException('Choose a duration');
      const unit = node.unit === 'MINUTES' ? 'min' : 'h';
      const resolved = resolveUnit(unit, collection.units ?? []);
      return { value: divide(multiply(duration.value, duration.factor!), resolved.factor), unit, dimension: resolved.dimension, root: resolved.root, factor: resolved.factor };
    }
    if (node.kind === 'conditional') {
      const condition = await this.evaluateBoolean(node.condition, collection, entry, ownerId, depth + 1);
      if (condition === undefined) return undefined;
      const branch = condition ? node.then : node.else;
      const value = await this.evaluateNode(branch, collection, entry, ownerId, depth + 1);
      return value && isUnitlessZero(branch) ? this.withInferredUnit(value, node, collection, format.id) : value;
    }
    if (node.kind === 'min' || node.kind === 'max') {
      const values: Quantity[] = [];
      let missing = false;
      for (const argument of node.args) {
        const value = await this.evaluateNode(argument, collection, entry, ownerId, depth + 1);
        if (value) values.push(value); else missing = true;
      }
      if (missing) return undefined;
      const wanted = node.kind === 'min' ? -1 : 1;
      return values.reduce((best, candidate) => (compareQuantities(candidate, best) === wanted ? candidate : best));
    }
    if (node.kind === 'abs' || node.kind === 'floor' || node.kind === 'ceil') {
      const quantity = await this.evaluateNode(node.value, collection, entry, ownerId, depth + 1);
      if (!quantity) return undefined;
      const { n, d } = quantity.value;
      if (node.kind === 'abs') return { ...quantity, value: { n: n < 0n ? -n : n, d } };
      const hasFraction = n % d !== 0n;
      const adjustment = node.kind === 'floor' ? (n < 0n && hasFraction ? -1n : 0n) : (n > 0n && hasFraction ? 1n : 0n);
      return { ...quantity, value: { n: n / d + adjustment, d: 1n } };
    }
    if (node.kind === 'modulo') {
      const dividend = await this.evaluateNode(node.left, collection, entry, ownerId, depth + 1);
      const divisor = await this.evaluateNode(node.right, collection, entry, ownerId, depth + 1);
      if (!dividend || !divisor) return undefined;
      assertComparable(dividend, divisor);
      return { ...dividend, value: modulo(dividend.value, inLeftUnit(dividend, divisor)) };
    }
    const left = await this.evaluateNode(node.args[0], collection, entry, ownerId, depth + 1);
    const right = await this.evaluateNode(node.args[1], collection, entry, ownerId, depth + 1);
    if (!left || !right) return undefined;
    if (node.operator === 'ADD' || node.operator === 'SUBTRACT') {
      assertAddable(left, right);
      const adjusted = left.unit && right.unit && left.unit !== right.unit ? divide(multiply(right.value, right.factor!), left.factor!) : right.value;
      return { ...left, value: plus(left.value, node.operator === 'SUBTRACT' ? negate(adjusted) : adjusted) };
    }
    if (node.operator === 'MULTIPLY') return { ...multiplyUnits(left, right, collection), value: multiply(left.value, right.value) };
    const units = divideUnits(left, right, collection);
    // Only a plain ratio of different units needs converting; a combined unit such as km/h keeps the values as given.
    const converted = right.unit && !units.unit && left.unit !== right.unit;
    return { ...units, value: converted ? divide(multiply(left.value, left.factor!), multiply(right.value, right.factor!)) : divide(left.value, right.value) };
  }

  /** A plain 0 means "zero of whatever this is", so that it can still be added to the other operands. */
  private withInferredUnit(value: Quantity, node: Expression, collection: Collection, formatId: string): Quantity {
    const inferred = inferStaticType(node, collection, formatId);
    return inferred.type === 'NUMBER' && inferred.unit ? { value: value.value, unit: inferred.unit, dimension: inferred.dimension, root: inferred.root, factor: inferred.factor } : value;
  }

  private linkedQuantity(found: LinkedValue, collection: Collection): Quantity {
    return this.quantity(found.raw, found.unitSnapshot?.id ?? found.field?.unit, collection, found.unitSnapshot);
  }

  /** Follows single references. A SNAPSHOT step reads only what the holding entry froze, never the current object. */
  private async followPath(node: ObjectPath, collection: Collection, entry: Entry, ownerId: string): Promise<LinkedValue | undefined> {
    const hops = [node.referenceFieldId, ...(node.through ?? [])];
    let holder = entry;
    let format = collection.formats.find((item) => item.id === entry.formatId);
    for (const [index, fieldId] of hops.entries()) {
      const field = format?.fields.find((item) => item.id === fieldId && item.kind === FieldKind.OBJECT_REF);
      const reference = holder.values.find((item) => item.fieldId === fieldId);
      const objectId = reference?.objectIds?.length === 1 ? reference.objectIds[0] : undefined;
      const target = collection.formats.find((item) => item.id === field?.targetObjectFormatId);
      if (!field || !reference || !objectId || !target || !Types.ObjectId.isValid(objectId)) return undefined;
      if (field.referenceMode === 'SNAPSHOT') {
        if (index < hops.length - 1) return undefined;
        const property = reference.objectSnapshots?.[0]?.properties.find((item) => item.fieldId === node.propertyFieldId);
        return property?.value ? { raw: property.value, unitSnapshot: property.unitSnapshot, field: target.fields.find((item) => item.id === node.propertyFieldId) } : undefined;
      }
      const next = await this.entries.findOne({ _id: objectId, ownerId, collectionId: collection.id, formatId: target.id }).exec();
      if (!next) return undefined;
      holder = next;
      format = target;
    }
    const value = holder.values.find((item) => item.fieldId === node.propertyFieldId);
    const raw = value?.numberValue ?? value?.value;
    return raw ? { raw, unitSnapshot: value?.unitSnapshot, field: format?.fields.find((item) => item.id === node.propertyFieldId) } : undefined;
  }

  /** One slot per linked object, `undefined` when that object has no value for the property. */
  private async relatedValues(node: { referenceFieldId: string; propertyFieldId?: string }, collection: Collection, entry: Entry, ownerId: string): Promise<(LinkedValue | undefined)[]> {
    const field = collection.formats.find((item) => item.id === entry.formatId)?.fields.find((item) => item.id === node.referenceFieldId && item.kind === FieldKind.OBJECT_REF);
    const target = collection.formats.find((item) => item.id === field?.targetObjectFormatId);
    const reference = entry.values.find((item) => item.fieldId === node.referenceFieldId);
    const ids = reference?.objectIds ?? [];
    if (!field || !target || !ids.length) return [];
    const propertyField = target.fields.find((item) => item.id === node.propertyFieldId);
    const linked = (raw: string | undefined, unitSnapshot: EntryValue['unitSnapshot']): LinkedValue | undefined => (raw ? { raw, unitSnapshot, field: propertyField } : undefined);
    if (field.referenceMode === 'SNAPSHOT') {
      return ids.map((id) => {
        const property = reference?.objectSnapshots?.find((item) => item.objectId === id)?.properties.find((item) => item.fieldId === node.propertyFieldId);
        return linked(property?.value, property?.unitSnapshot);
      });
    }
    const objects = await this.entries.find({ _id: { $in: ids.filter((id) => Types.ObjectId.isValid(id)) }, ownerId, collectionId: collection.id, formatId: target.id }).exec();
    return objects.map((object) => {
      const value = object.values.find((item) => item.fieldId === node.propertyFieldId);
      return linked(value?.numberValue ?? value?.value, value?.unitSnapshot);
    });
  }

  /** Objects without the property are left out, as in collection analyses. With no value at all the result is absent. */
  private async aggregateRelated(node: RelatedAggregate, collection: Collection, entry: Entry, ownerId: string): Promise<Quantity | undefined> {
    const quantities = (await this.relatedValues(node, collection, entry, ownerId)).filter((item): item is LinkedValue => !!item).map((item) => this.linkedQuantity(item, collection));
    if (!quantities.length) return undefined;
    if (node.kind === 'minRelated' || node.kind === 'maxRelated') {
      const wanted = node.kind === 'minRelated' ? -1 : 1;
      return quantities.reduce((best, candidate) => (compareQuantities(candidate, best) === wanted ? candidate : best));
    }
    const total = quantities.reduce((sum, item) => { assertComparable(sum, item); return { ...sum, value: plus(sum.value, inLeftUnit(sum, item)) }; });
    return node.kind === 'sumRelated' ? total : { ...total, value: divide(total.value, { n: BigInt(quantities.length), d: 1n }) };
  }

  /** `undefined` means a source value is missing; an empty literal stays a real, empty text. */
  private async evaluateText(node: TextExpression, collection: Collection, entry: Entry, ownerId: string, depth: number): Promise<string | undefined> {
    if (depth > 16) throw new BadRequestException('Formula is too deep');
    if (node.kind === 'textLiteral') return node.value;
    if (node.kind === 'textField') return entry.values.find((item) => item.fieldId === node.fieldId)?.value || undefined;
    if (node.kind === 'textProperty') return (await this.followPath(node, collection, entry, ownerId))?.raw;
    if (node.kind === 'unitOf') {
      const quantity = await this.evaluateNode(node.value, collection, entry, ownerId, depth + 1);
      return quantity && (quantity.unit ?? '');
    }
    if (node.kind === 'coalesceText') {
      for (const argument of node.args) {
        const value = await this.evaluateText(argument, collection, entry, ownerId, depth + 1);
        if (value !== undefined) return value;
      }
      return undefined;
    }
    if (node.kind === 'concat') {
      let joined = '';
      for (const argument of node.args) {
        const part = await this.evaluateText(argument, collection, entry, ownerId, depth + 1);
        if (part === undefined) return undefined;
        joined += part;
      }
      return joined;
    }
    if (node.kind === 'formatText') {
      if (isDateExpression(node.value)) {
        const date = await this.evaluateDate(node.value, collection, entry, ownerId, depth + 1);
        return date && formatDate(date, node.pattern);
      }
      const quantity = await this.evaluateNode(node.value, collection, entry, ownerId, depth + 1);
      if (!quantity) return undefined;
      return formatNumber(quantity.value, node.pattern, node.locale);
    }
    const text = await this.evaluateText(node.text, collection, entry, ownerId, depth + 1);
    if (text === undefined) return undefined;
    if (node.kind === 'upper') return text.toUpperCase();
    if (node.kind === 'lower') return text.toLowerCase();
    if (node.kind === 'proper') return toProperCase(text);
    const start = await this.evaluateNode(node.start, collection, entry, ownerId, depth + 1);
    const length = await this.evaluateNode(node.length, collection, entry, ownerId, depth + 1);
    if (!start || !length) return undefined;
    const first = wholeNumber(start, 1n) - 1n;
    const count = wholeNumber(length, 0n);
    const characters = splitCharacters(text);
    if (first >= BigInt(characters.length)) return '';
    return characters.slice(Number(first), first + count >= BigInt(characters.length) ? undefined : Number(first + count)).join('');
  }

  /** `undefined` means the date is missing, unreadable in the entry, or out of range. */
  private async evaluateDate(node: DateExpression, collection: Collection, entry: Entry, ownerId: string, depth: number): Promise<FormulaDate | undefined> {
    if (depth > 16) throw new BadRequestException('Formula is too deep');
    if (node.kind === 'dateLiteral') return parseFormulaDate(node.value);
    if (node.kind === 'dateField') return parseFormulaDate(entry.values.find((item) => item.fieldId === node.fieldId)?.value);
    const date = await this.evaluateDate(node.date, collection, entry, ownerId, depth + 1);
    if (!date) return undefined;
    if (node.kind === 'startOfMonth') return startOfMonth(date);
    if (node.kind === 'endOfMonth') return endOfMonth(date);
    const days = await this.evaluateNode(node.days, collection, entry, ownerId, depth + 1);
    return days ? addDaysToDate(date, wholeDays(days)) : undefined;
  }

  /** Dates compare by instant. Texts compare exactly, without regard to how accents are encoded. */
  private async compareOperands(leftNode: FormulaNode, rightNode: FormulaNode, collection: Collection, entry: Entry, ownerId: string, depth: number): Promise<number | undefined> {
    if (isDateExpression(leftNode) && isDateExpression(rightNode)) {
      const left = await this.evaluateDate(leftNode, collection, entry, ownerId, depth);
      const right = await this.evaluateDate(rightNode, collection, entry, ownerId, depth);
      return left && right ? Math.sign(left.ms - right.ms) : undefined;
    }
    if (isTextExpression(leftNode) && isTextExpression(rightNode)) {
      const left = await this.evaluateText(leftNode, collection, entry, ownerId, depth);
      const right = await this.evaluateText(rightNode, collection, entry, ownerId, depth);
      return left === undefined || right === undefined ? undefined : Number(left.normalize('NFC') !== right.normalize('NFC'));
    }
    const left = await this.evaluateNode(numericOnly(leftNode), collection, entry, ownerId, depth);
    const right = await this.evaluateNode(numericOnly(rightNode), collection, entry, ownerId, depth);
    return left && right ? compareQuantities(left, right) : undefined;
  }

  /** Three-valued: `undefined` means a source value is missing, so a condition never treats an absent value as false. */
  private async evaluateBoolean(node: BooleanExpression, collection: Collection, entry: Entry, ownerId: string, depth: number): Promise<boolean | undefined> {
    if (depth > 16) throw new BadRequestException('Formula is too deep');
    if (node.kind === 'boolean') return node.value;
    if (node.kind === 'not') {
      const value = await this.evaluateBoolean(node.arg, collection, entry, ownerId, depth + 1);
      return value === undefined ? undefined : !value;
    }
    if (node.kind === 'logical') {
      const deciding = node.operator === 'OR';
      let unknown = false;
      for (const argument of node.args) {
        const value = await this.evaluateBoolean(argument, collection, entry, ownerId, depth + 1);
        if (value === deciding) return deciding;
        if (value === undefined) unknown = true;
      }
      return unknown ? undefined : !deciding;
    }
    const order = await this.compareOperands(node.left, node.right, collection, entry, ownerId, depth + 1);
    if (order === undefined) return undefined;
    return { EQ: order === 0, NEQ: order !== 0, LT: order < 0, LTE: order <= 0, GT: order > 0, GTE: order >= 0 }[node.operator];
  }

  async calculate(collectionId: string, ownerId: string, formulaId: string, entryId: string): Promise<FormulaResult> {
    const collection = await this.collection(collectionId, ownerId);
    const formula = (collection.formulas ?? []).find((item) => item.id === formulaId);
    if (!formula) throw new NotFoundException('Formula not found');
    const entry = await this.entries.findOne({ _id: entryId, collectionId, ownerId, formatId: formula.formatId }).exec();
    if (!entry) throw new NotFoundException('Entry not found');
    return this.evaluateFormula(this.parse(formula.expression), collection, entry, ownerId);
  }

  /** Calculates an unsaved formula on the first entry of the data format; null when the format has no entry yet. */
  async previewFormula(collectionId: string, ownerId: string, formatId: string, expression: string): Promise<FormulaPreview | null> {
    const collection = await this.collection(collectionId, ownerId);
    const format = collection.formats.find((item) => item.id === formatId);
    if (!format) throw new BadRequestException('Data format not found');
    const parsed = this.parse(expression);
    this.inspectRoot(parsed, collection, formatId, new Set<string>());
    inferStaticType(parsed, collection, formatId);
    const entry = await this.entries.findOne({ collectionId, ownerId, formatId }).sort({ _id: 1 }).exec();
    if (!entry) return null;
    const titleId = format.fields.find((field) => field.kind === FieldKind.TITLE)?.id;
    return { ...(await this.evaluateFormula(parsed, collection, entry, ownerId)), entryLabel: entry.values.find((item) => item.fieldId === titleId)?.value };
  }

  private async evaluateFormula(parsed: FormulaNode, collection: Collection, entry: Entry, ownerId: string): Promise<FormulaResult> {
    const entryId = entry.id as string;
    if (isDateExpression(parsed)) {
      const date = await this.evaluateDate(parsed, collection, entry, ownerId, 0);
      return { entryId, ...(date ? { value: formatFormulaDate(date), dimension: 'DATE' } : { missing: 'A source value is missing' }) };
    }
    if (isTextExpression(parsed)) {
      const text = await this.evaluateText(parsed, collection, entry, ownerId, 0);
      return { entryId, ...(text === undefined ? { missing: 'A source value is missing' } : { value: text, dimension: 'TEXT' }) };
    }
    const result = await this.evaluateNode(parsed, collection, entry, ownerId);
    return { entryId, ...(result ? { value: fractionText(result.value), unit: result.unit, dimension: result.dimension } : { missing: 'A source value is missing' }) };
  }

  async analyse(collectionId: string, ownerId: string, input: AnalysisInput): Promise<AnalysisResult> {
    const collection = await this.collection(collectionId, ownerId);
    const format = collection.formats.find((item) => item.id === input.formatId);
    if (!format) throw new BadRequestException('Data format not found');
    const minimum = collection.minAggregateSize ?? 5;
    const refuse = async (error: unknown) => {
      await recordSensitiveAggregate(this.collaboration, { collectionId, userId: ownerId, formatId: format.id, input, minimum, refused: error instanceof Error ? error.message : 'Refused' });
      return error;
    };
    let sensitive: boolean;
    try { sensitive = assertSensitiveAnalysisRequest(format, input); } catch (error) { throw await refuse(error); }
    if (input.groupBy === 'ZONE') return this.zoneAnalysis.analyse(collection, ownerId, input);
    const spec = getOperationSpec(input.operation);
    if (!['NONE', 'DAY', 'MONTH', 'CATEGORY', 'OBJECT'].includes(input.groupBy) || !['EVENT', 'SNAPSHOT', 'RATE'].includes(input.measureKind)) {
      throw new BadRequestException('Choose a valid analysis');
    }
    if (!spec.acceptedMeasureKinds.includes(input.measureKind)) {
      throw new BadRequestException(`${spec.id} needs ${spec.acceptedMeasureKinds.join(' or ')} values; adjust the value meaning or operation`);
    }
    const field = format.fields.find((item) => item.id === input.fieldId && (item.kind === FieldKind.NUMBER || item.kind === FieldKind.MEASURE));
    const formula = (collection.formulas ?? []).find((item) => item.id === input.formulaId && item.formatId === format.id);
    if (spec.requiresNumeric && (!!field === !!formula)) throw new BadRequestException('Choose one numeric field or formula');
    const date = format.fields.find((item) => item.id === input.dateFieldId && [FieldKind.DATE, FieldKind.DATETIME].includes(item.kind));
    const needsDate = spec.requiresDateOrder || ['DAY', 'MONTH'].includes(input.groupBy) || ['DAY', 'MONTH'].includes(input.secondaryGroupBy ?? '') || !!(input.from || input.to || input.comparisonFrom || input.comparisonTo);
    if (needsDate && !date) throw new BadRequestException('Choose a date field');
    const groupField = format.fields.find((item) => item.id === input.groupFieldId && (input.groupBy === 'CATEGORY' ? [FieldKind.SELECT, FieldKind.TEXT, FieldKind.CODE].includes(item.kind) : input.groupBy === 'OBJECT' && item.kind === FieldKind.OBJECT_REF));
    if (['CATEGORY', 'OBJECT'].includes(input.groupBy) && !groupField) throw new BadRequestException('Choose a compatible group field');
    let secondaryGroupField: CollectionField | undefined;
    if (spec.id === 'CROSSTAB') {
      if (!input.secondaryGroupBy || !['DAY', 'MONTH', 'CATEGORY', 'OBJECT'].includes(input.secondaryGroupBy) || input.groupBy === 'NONE') {
        throw new BadRequestException('Choose both row and column groupings for a cross-tabulation');
      }
      if (['CATEGORY', 'OBJECT'].includes(input.secondaryGroupBy)) {
        secondaryGroupField = format.fields.find((item) => item.id === input.secondaryGroupFieldId && (input.secondaryGroupBy === 'CATEGORY' ? [FieldKind.SELECT, FieldKind.TEXT, FieldKind.CODE].includes(item.kind) : item.kind === FieldKind.OBJECT_REF));
        if (!secondaryGroupField) throw new BadRequestException('Choose a compatible secondary group field');
      }
    }
    const weightField = input.weightFieldId ? format.fields.find((item) => item.id === input.weightFieldId && item.kind === FieldKind.NUMBER) : undefined;
    if (input.weightFieldId && !weightField) throw new BadRequestException('Choose a numeric weight field');
    const denominatorField = input.denominatorFieldId ? format.fields.find((item) => item.id === input.denominatorFieldId && item.kind === FieldKind.NUMBER) : undefined;
    if (input.denominatorFieldId && !denominatorField) throw new BadRequestException('Choose a numeric denominator field');
    const counterResetField = input.counterResetFieldId ? format.fields.find((item) => item.id === input.counterResetFieldId && item.kind === FieldKind.BOOLEAN) : undefined;
    if (input.counterResetFieldId && !counterResetField) throw new BadRequestException('Choose a boolean counter reset field');

    const filters = input.filters ?? [];
    if (input.sourceGroup !== undefined && (typeof input.sourceGroup !== 'string' || input.sourceGroup.length > 200)) throw new BadRequestException('Invalid source group');
    if (input.sourceOffset !== undefined && (!Number.isInteger(input.sourceOffset) || input.sourceOffset < 0 || input.sourceOffset > 10_000_000 || !input.sourceGroup)) throw new BadRequestException('Invalid source offset');
    if (filters.length > 8) throw new BadRequestException('Choose at most 8 analysis filters');
    const prepared = filters.map((filter) => {
      const selected = format.fields.find((item) => item.id === filter.fieldId);
      if (!selected || !filter.value?.trim() || filter.value.length > 200 || !Object.values(EntryFilterOperator).includes(filter.operator)) throw new BadRequestException('Invalid analysis filter');
      if (filter.operator === EntryFilterOperator.CONTAINS && ![FieldKind.TITLE, FieldKind.TEXT, FieldKind.LONG_TEXT, FieldKind.LINK].includes(selected.kind)) throw new BadRequestException('Contains needs a text field');
      if ([EntryFilterOperator.GT, EntryFilterOperator.GTE, EntryFilterOperator.LT, EntryFilterOperator.LTE].includes(filter.operator) && ![FieldKind.NUMBER, FieldKind.DATE, FieldKind.DATETIME].includes(selected.kind)) throw new BadRequestException('Choose a numeric or date field for comparison');
      if (selected.kind === FieldKind.NUMBER) decimal(filter.value.trim().replace(',', '.'));
      return { field: selected, operator: filter.operator, value: filter.value.trim() };
    });
    const matches = (entry: Entry): boolean => prepared.every(({ field: selected, operator, value }) => {
      const stored = entry.values.find((item) => item.fieldId === selected.id);
      if (!stored) return false;
      if (operator === EntryFilterOperator.CONTAINS) return stored.value.toLocaleLowerCase().includes(value.toLocaleLowerCase());
      if (selected.kind === FieldKind.MULTI_SELECT) return operator === EntryFilterOperator.EQ && (stored.selectedValues ?? []).includes(value);
      if (selected.kind === FieldKind.OBJECT_REF) return operator === EntryFilterOperator.EQ && (stored.objectIds ?? []).includes(value);
      let compare: number;
      if (selected.kind === FieldKind.NUMBER) {
        const left = decimal(stored.numberValue ?? stored.value), right = decimal(value.replace(',', '.'));
        const difference = left.n * right.d - right.n * left.d;
        compare = difference < 0n ? -1 : difference > 0n ? 1 : 0;
      } else compare = stored.value.localeCompare(value);
      return operator === EntryFilterOperator.EQ ? compare === 0 : operator === EntryFilterOperator.GT ? compare > 0 : operator === EntryFilterOperator.GTE ? compare >= 0 : operator === EntryFilterOperator.LT ? compare < 0 : compare <= 0;
    });
    const validDate = (value?: string) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
    if (![input.from, input.to, input.comparisonFrom, input.comparisonTo].every(validDate)) throw new BadRequestException('Use ISO dates for analysis ranges');
    let unit: string | undefined;
    let dimension: string | undefined;
    let unitKnown = false;
    // Large code lists (T39/3) are loaded once for grouping by level and labels.
    const largeLists = [groupField, secondaryGroupField].filter((item) => item?.kind === FieldKind.CODE && collection.codeLists?.some((list) => list.id === item.codeListId && list.external)).map((item) => item!.codeListId!);
    if (largeLists.length) collection.codeLists = await this.codeLists.materialize(collection, largeLists);
    const keyFor = (entry: Entry, dateValue: string | undefined, mode: string, targetField?: CollectionField, depth?: number): string => {
      if (mode === 'DAY' || mode === 'MONTH') return dateValue?.slice(0, mode === 'DAY' ? 10 : 7) ?? 'Missing date';
      if (mode === 'CATEGORY') {
        const value = entry.values.find((item) => item.fieldId === targetField!.id)?.value;
        const list = collection.codeLists?.find((item) => item.id === targetField?.codeListId);
        return value && list && depth !== undefined ? codeAtDepth(list, value, depth) : value || 'Missing category';
      }
      if (mode === 'OBJECT') return entry.values.find((item) => item.fieldId === targetField!.id)?.objectIds?.[0] || 'Missing object';
      return 'All';
    };
    const build = async (from?: string, to?: string, isComparison = false) => {
      // Only operations that depend on chronological order keep one record per entry, to sort them.
      const observations: ObservationRecord[] = [];
      const accumulator = spec.requiresDateOrder ? undefined : new ObservationAccumulator(spec, input);
      const distinctGroups = new Set<string>();
      let skippedMissingCount = 0;
      const dateBounds = { ...(from ? { $gte: from } : {}), ...(to ? { $lt: `${to}\uffff` } : {}) };
      const query = date && (from || to)
        ? { ownerId, collectionId, formatId: format.id, values: { $elemMatch: { fieldId: date.id, value: dateBounds } } }
        : { ownerId, collectionId, formatId: format.id };
      const native = await runNativeAnalysis(this.entries, { collection, format, spec, input, field, formulaExpression: formula?.expression, date, groupField, filters: prepared }, query, isComparison);
      if (native) {
        if (native.unit !== undefined || native.dimension !== undefined) { unit = native.unit; dimension = native.dimension; unitKnown = true; }
        return native;
      }
      for await (const stored of this.entries.find(query).select('-values.attachmentData').sort({ _id: 1 }).lean().cursor({ batchSize: 1000 })) {
        const entry = { ...stored, id: String(stored._id) } as unknown as Entry;
        if (!matches(entry)) continue;
        const rawDate = date ? entry.values.find((item) => item.fieldId === date.id)?.value : undefined;
        const dateValue = rawDate?.slice(0, 10);
        if (spec.requiresDateOrder && !dateValue) { skippedMissingCount++; continue; }
        if ((from && (!dateValue || dateValue < from)) || (to && (!dateValue || dateValue > to))) continue;
        const primaryKey = keyFor(entry, dateValue, input.groupBy, groupField, input.groupDepth);
        const secondaryKey = spec.id === 'CROSSTAB' && input.secondaryGroupBy ? keyFor(entry, dateValue, input.secondaryGroupBy, secondaryGroupField, input.secondaryGroupDepth) : undefined;
        const quantity = formula
          ? await this.evaluateNode(this.parseNumeric(formula.expression), collection, entry, ownerId)
          : field
            ? (() => {
                const value = entry.values.find((item) => item.fieldId === field.id);
                if (field.kind === FieldKind.MEASURE && value?.measureValue?.status === 'ABSENT') {
                  return undefined;
                }
                const raw = (value?.numberValue ?? value?.value)?.trim();
                return value && raw ? this.quantity(raw, value.unitSnapshot?.id ?? field.unit, collection, value.unitSnapshot) : undefined;
              })()
            : undefined;
        if (spec.requiresNumeric && !quantity) {
          skippedMissingCount++;
          continue;
        }
        if (quantity) {
          if (unitKnown && (quantity.unit !== unit || quantity.dimension !== dimension)) {
            throw new BadRequestException('Analysis has mixed units; convert before grouping');
          }
          unit = quantity.unit;
          dimension = quantity.dimension;
          unitKnown = true;
        }
        let weight: Rational | undefined;
        if (weightField) {
          const wVal = entry.values.find((item) => item.fieldId === weightField.id);
          const wRaw = (wVal?.numberValue ?? wVal?.value)?.trim();
          if (!wRaw) { skippedMissingCount++; continue; }
          if (weightField.unit && quantity?.unit && weightField.unit !== quantity.unit) {
            throw new BadRequestException('Cannot weight values with an incompatible unit');
          }
          weight = decimal(wRaw.replace(',', '.'));
          if (weight.n < 0n) throw new BadRequestException('Weight values cannot be negative');
        }
        let denominator: Rational | undefined;
        if (denominatorField) {
          const dVal = entry.values.find((item) => item.fieldId === denominatorField.id);
          const dRaw = (dVal?.numberValue ?? dVal?.value)?.trim();
          if (!dRaw) { skippedMissingCount++; continue; }
          denominator = decimal(dRaw.replace(',', '.'));
          if (denominator.n < 0n) throw new BadRequestException('Denominator values cannot be negative');
        }
        const counterReset = counterResetField
          ? entry.values.find((item) => item.fieldId === counterResetField.id)?.value === 'true'
          : false;
        distinctGroups.add(secondaryKey ? `${primaryKey} × ${secondaryKey}` : primaryKey);
        if (distinctGroups.size > 1000) throw new BadRequestException('Narrow the analysis to at most 1000 groups');
        const observation: ObservationRecord = {
          entryId: entry.id as string,
          dateValue: rawDate ?? dateValue,
          primaryKey,
          secondaryKey,
          value: quantity?.value,
          weight,
          denominator,
          counterReset,
          status: field?.kind === FieldKind.MEASURE ? (entry.values.find((item) => item.fieldId === field.id)?.measureValue?.status || 'MEASURED') : undefined,
          uncertainty: field?.kind === FieldKind.MEASURE ? entry.values.find((item) => item.fieldId === field.id)?.measureValue?.uncertainty : undefined,
          uncertaintyType: field?.kind === FieldKind.MEASURE ? entry.values.find((item) => item.fieldId === field.id)?.measureValue?.uncertaintyType : undefined,
        };
        if (accumulator) accumulator.add(observation);
        else observations.push(observation);
      }
      return {
        ...(accumulator ? accumulator.finish(unit, skippedMissingCount, isComparison) : executeRegisteredOperation(spec, observations, input, unit, skippedMissingCount, isComparison)),
        skippedMissingCount,
      };
    };
    const primaryOut = await build(input.from, input.to, false);
    const rows = primaryOut.rows;
    const comparisonRows = input.comparisonFrom || input.comparisonTo ? (await build(input.comparisonFrom, input.comparisonTo, true)).rows : undefined;
    if (input.groupBy === 'OBJECT' || input.secondaryGroupBy === 'OBJECT') {
      const candidateIds = new Set<string>();
      for (const row of [...rows, ...(comparisonRows ?? [])]) {
        if (Types.ObjectId.isValid(row.group)) candidateIds.add(row.group);
        if (row.rowKey && Types.ObjectId.isValid(row.rowKey)) candidateIds.add(row.rowKey);
        if (row.columnKey && Types.ObjectId.isValid(row.columnKey)) candidateIds.add(row.columnKey);
      }
      const objects = await this.entries.find({ ownerId, collectionId, _id: { $in: [...candidateIds] } }).exec();
      const names = new Map(objects.map((object) => {
        const definition = collection.formats.find((item) => item.id === object.formatId);
        const titleId = definition?.fields.find((item) => item.kind === FieldKind.TITLE)?.id;
        return [object.id, object.values.find((value) => value.fieldId === titleId)?.value] as const;
      }));
      for (const row of [...rows, ...(comparisonRows ?? [])]) {
        if (row.rowKey && row.columnKey) {
          const rLabel = names.get(row.rowKey) || row.rowKey;
          const cLabel = names.get(row.columnKey) || row.columnKey;
          row.label = `${rLabel} × ${cLabel}`;
        } else {
          row.label = names.get(row.group) || row.group;
        }
      }
    }
    if (groupField?.kind === FieldKind.CODE || secondaryGroupField?.kind === FieldKind.CODE) {
      const labelFor = (field: CollectionField | undefined, code: string): string => {
        if (field?.kind !== FieldKind.CODE) return code;
        const item = collection.codeLists?.find((list) => list.id === field.codeListId)?.codes.find((candidate) => candidate.code === code);
        return item ? (input.language === 'fr' ? item.labelFr : item.labelEn) : code;
      };
      for (const row of [...rows, ...(comparisonRows ?? [])]) row.label = row.rowKey && row.columnKey
        ? `${labelFor(groupField, row.rowKey)} × ${labelFor(secondaryGroupField, row.columnKey)}`
        : labelFor(groupField, row.group);
    }
    const result: AnalysisResult = {
      operation: input.operation,
      operationVersion: spec.version,
      groupBy: input.groupBy,
      secondaryGroupBy: input.secondaryGroupBy,
      unit: primaryOut.outputUnit,
      dimension,
      skippedMissingCount: primaryOut.skippedMissingCount,
      slope: primaryOut.slope,
      explanation: primaryOut.explanation,
      hasEstimated: primaryOut.hasEstimated,
      propagatedUncertainty: primaryOut.propagatedUncertainty,
      refreshedAt: new Date().toISOString(),
      rows,
      comparisonRows,
    };
    if (!sensitive) return result;
    let safe: AnalysisResult;
    try { safe = enforceSensitiveAggregate(result, minimum); } catch (error) { throw await refuse(error); }
    await recordSensitiveAggregate(this.collaboration, { collectionId, userId: ownerId, formatId: format.id, input, minimum, observationCount: safe.rows.reduce((sum, row) => sum + row.count, 0) });
    return safe;
  }
}
