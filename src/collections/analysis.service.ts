import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { AnalysisInput, AnalysisResult, AnalysisRow, FormulaInput, FormulaResult } from './analysis.input';
import { executeRegisteredOperation, getOperationSpec, ObservationRecord } from './analysis_registry';
import { EntryFieldFilterInput, EntryFilterOperator } from './collection.input';
import { Collection, CollectionField, CollectionFormula, FieldKind } from './collection.schema';
import { codeAtDepth } from './classification.logic';
import { Entry } from './entry.schema';
import { decimal, divide, fractionText, multiply, Rational, resolveUnit } from './unit_math';

type Expression = { kind: 'number'; value: string; unit?: string } | { kind: 'field'; fieldId: string } | { kind: 'property'; referenceFieldId: string; propertyFieldId: string } | { kind: 'formula'; formulaId: string } | { kind: 'dateDifference'; fromFieldId: string; toFieldId: string; unit: 'd' | 'h' } | { kind: 'round'; digits: number; mode: 'HALF_UP' | 'HALF_EVEN'; value: Expression } | { kind: 'operation'; operator: 'ADD' | 'SUBTRACT' | 'MULTIPLY' | 'DIVIDE'; args: Expression[] };
type Quantity = { value: Rational; unit?: string; dimension?: string; root?: string; factor?: Rational };
const plus = (a: Rational, b: Rational): Rational => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
const negate = (a: Rational): Rational => ({ n: -a.n, d: a.d });

@Injectable()
export class AnalysisService {
  constructor(@InjectModel(Collection.name) private readonly collections: Model<Collection>, @InjectModel(Entry.name) private readonly entries: Model<Entry>) {}

  private async collection(collectionId: string, ownerId: string): Promise<Collection> {
    if (!Types.ObjectId.isValid(collectionId)) throw new NotFoundException('Collection not found');
    const collection = await this.collections.findOne({ _id: collectionId, ownerId }).exec();
    if (!collection) throw new NotFoundException('Collection not found');
    return collection;
  }

  private parse(text: string): Expression {
    if (text.length > 8000) throw new BadRequestException('Formula is too long');
    let expression: unknown;
    try { expression = JSON.parse(text); } catch { throw new BadRequestException('Invalid formula expression'); }
    if (!expression || typeof expression !== 'object' || Array.isArray(expression)) throw new BadRequestException('Invalid formula expression');
    return expression as Expression;
  }

  private inspect(node: Expression, collection: Collection, formatId: string, references: Set<string>, depth = 0, budget = { count: 0 }): void {
    if (++budget.count > 64 || depth > 12 || !node || typeof node !== 'object') throw new BadRequestException('Formula is too complex');
    const format = collection.formats.find((item) => item.id === formatId);
    if (!format) throw new BadRequestException('Data format not found');
    if (node.kind === 'number') {
      decimal(node.value);
      if (node.unit) resolveUnit(node.unit, collection.units ?? []);
    } else if (node.kind === 'field') {
      if (!format.fields.some((field) => field.id === node.fieldId && field.kind === FieldKind.NUMBER)) throw new BadRequestException('Choose a numeric field in this data format');
    } else if (node.kind === 'property') {
      const ref = format.fields.find((field) => field.id === node.referenceFieldId && field.kind === FieldKind.OBJECT_REF && !field.multiple);
      const target = collection.formats.find((item) => item.id === ref?.targetObjectFormatId);
      if (!target?.fields.some((field) => field.id === node.propertyFieldId && field.kind === FieldKind.NUMBER)) throw new BadRequestException('Choose one numeric property from a single object reference');
    } else if (node.kind === 'formula') {
      if (typeof node.formulaId !== 'string') throw new BadRequestException('Invalid formula reference');
      references.add(node.formulaId);
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
    } else throw new BadRequestException('Unknown formula operation');
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
    this.inspect(this.parse(input.expression), collection, input.formatId, dependencies);
    const id = formulaId ?? randomUUID();
    if (dependencies.has(id)) throw new BadRequestException('Formula cannot refer to itself');
    const formulas = [...(collection.formulas ?? []).filter((item) => item.id !== id), { id, name, formatId: input.formatId, expression: input.expression, version: (existing?.version ?? 0) + 1, dependencies: [...dependencies] }];
    if (formulas.length > 100) throw new BadRequestException('This collection has 100 formulas');
    for (const item of formulas) {
      const visited = new Set<string>();
      const visit = (formula: CollectionFormula): void => {
        if (visited.has(formula.id)) throw new BadRequestException('Formula cycle detected');
        visited.add(formula.id);
        for (const dependencyId of formula.dependencies) {
          const dependency = formulas.find((candidate) => candidate.id === dependencyId && candidate.formatId === formula.formatId);
          if (!dependency) throw new BadRequestException('Formula dependency is missing or belongs to another data format');
          visit(dependency);
        }
        visited.delete(formula.id);
      };
      visit(item);
    }
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
      const reference = entry.values.find((item) => item.fieldId === node.referenceFieldId);
      const objectId = reference?.objectIds?.[0];
      if (!objectId || reference?.objectIds?.length !== 1) return undefined;
      const referenceField = format.fields.find((item) => item.id === node.referenceFieldId);
      let property = referenceField?.referenceMode === 'SNAPSHOT' ? reference.objectSnapshots?.[0]?.properties.find((item) => item.fieldId === node.propertyFieldId) : undefined;
      // A missing historical value must stay missing; reading the current object would rewrite the past.
      if (referenceField?.referenceMode === 'SNAPSHOT' && !property) return undefined;
      let unit = property?.unitSnapshot?.id;
      if (!property) {
        const source = await this.entries.findOne({ _id: objectId, ownerId, collectionId: collection.id, formatId: referenceField?.targetObjectFormatId }).exec();
        const value = source?.values.find((item) => item.fieldId === node.propertyFieldId);
        if (!value) return undefined;
        const sourceFormat = collection.formats.find((item) => item.id === source?.formatId);
        unit = value.unitSnapshot?.id ?? sourceFormat?.fields.find((item) => item.id === node.propertyFieldId)?.unit;
        return this.quantity(value.numberValue ?? value.value, unit, collection, value.unitSnapshot);
      }
      unit ??= collection.formats.find((item) => item.id === referenceField?.targetObjectFormatId)?.fields.find((item) => item.id === node.propertyFieldId)?.unit;
      return this.quantity(property.value, unit, collection, property.unitSnapshot);
    }
    if (node.kind === 'formula') {
      const formula = (collection.formulas ?? []).find((item) => item.id === node.formulaId && item.formatId === entry.formatId);
      if (!formula) throw new BadRequestException('Formula dependency is missing');
      return this.evaluateNode(this.parse(formula.expression), collection, entry, ownerId, depth + 1);
    }
    const left = await this.evaluateNode(node.args[0], collection, entry, ownerId, depth + 1);
    const right = await this.evaluateNode(node.args[1], collection, entry, ownerId, depth + 1);
    if (!left || !right) return undefined;
    if (node.operator === 'ADD' || node.operator === 'SUBTRACT') {
      if (left.dimension !== right.dimension || left.root !== right.root || (!!left.unit !== !!right.unit)) throw new BadRequestException('Cannot add incompatible units');
      if (left.unit !== right.unit && left.dimension === 'CURRENCY') throw new BadRequestException('Convert currencies with an explicit dated rate first');
      if (left.unit !== right.unit && left.dimension === 'TEMPERATURE') throw new BadRequestException('Convert temperatures before adding them');
      const adjusted = left.unit && right.unit && left.unit !== right.unit ? divide(multiply(right.value, right.factor!), left.factor!) : right.value;
      return { ...left, value: plus(left.value, node.operator === 'SUBTRACT' ? negate(adjusted) : adjusted) };
    }
    if (node.operator === 'MULTIPLY') {
      if (left.unit && right.unit) return { value: multiply(left.value, right.value), unit: `${left.unit}·${right.unit}`, dimension: `${left.dimension}·${right.dimension}` };
      return { ...(left.unit ? left : right), value: multiply(left.value, right.value) };
    }
    const value = divide(left.value, right.value);
    if (right.unit) {
      if (!left.unit || left.dimension !== right.dimension || left.root !== right.root) throw new BadRequestException('Dividing by a unit requires compatible quantities');
      return { value: divide(multiply(left.value, left.factor!), multiply(right.value, right.factor!)) };
    }
    return { ...left, value };
  }

  async calculate(collectionId: string, ownerId: string, formulaId: string, entryId: string): Promise<FormulaResult> {
    const collection = await this.collection(collectionId, ownerId);
    const formula = (collection.formulas ?? []).find((item) => item.id === formulaId);
    if (!formula) throw new NotFoundException('Formula not found');
    const entry = await this.entries.findOne({ _id: entryId, collectionId, ownerId, formatId: formula.formatId }).exec();
    if (!entry) throw new NotFoundException('Entry not found');
    const result = await this.evaluateNode(this.parse(formula.expression), collection, entry, ownerId);
    return { entryId, ...(result ? { value: fractionText(result.value), unit: result.unit, dimension: result.dimension } : { missing: 'A source value is missing' }) };
  }

  async analyse(collectionId: string, ownerId: string, input: AnalysisInput): Promise<AnalysisResult> {
    const collection = await this.collection(collectionId, ownerId);
    const format = collection.formats.find((item) => item.id === input.formatId);
    if (!format) throw new BadRequestException('Data format not found');
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
    if (input.sourceOffset !== undefined && (!Number.isInteger(input.sourceOffset) || input.sourceOffset < 0 || input.sourceOffset > 100000 || !input.sourceGroup)) throw new BadRequestException('Invalid source offset');
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
      const observations: ObservationRecord[] = [];
      const distinctGroups = new Set<string>();
      let scanned = 0;
      let skippedMissingCount = 0;
      for await (const entry of this.entries.find({ ownerId, collectionId, formatId: format.id }).sort({ _id: 1 }).cursor()) {
        if (++scanned > 100000) throw new BadRequestException('Narrow the analysis to at most 100000 entries');
        if (!matches(entry)) continue;
        const rawDate = date ? entry.values.find((item) => item.fieldId === date.id)?.value : undefined;
        const dateValue = rawDate?.slice(0, 10);
        if (spec.requiresDateOrder && !dateValue) { skippedMissingCount++; continue; }
        if ((from && (!dateValue || dateValue < from)) || (to && (!dateValue || dateValue > to))) continue;
        const primaryKey = keyFor(entry, dateValue, input.groupBy, groupField, input.groupDepth);
        const secondaryKey = spec.id === 'CROSSTAB' && input.secondaryGroupBy ? keyFor(entry, dateValue, input.secondaryGroupBy, secondaryGroupField, input.secondaryGroupDepth) : undefined;
        const quantity = formula
          ? await this.evaluateNode(this.parse(formula.expression), collection, entry, ownerId)
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
        observations.push({
          entryId: entry.id,
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
        });
      }
      return {
        ...executeRegisteredOperation(spec, observations, input, unit, skippedMissingCount, isComparison),
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
    return {
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
  }
}
