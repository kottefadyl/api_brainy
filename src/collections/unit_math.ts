import { BadRequestException } from '@nestjs/common';
import { CollectionUnit } from './unit.schema.js';

export type Rational = { n: bigint; d: bigint };
export const builtInUnits: CollectionUnit[] = [
  ['km', 'Kilometre', 'km', 'DISTANCE', '1000'], ['m', 'Metre', 'm', 'DISTANCE', '1'], ['cm', 'Centimetre', 'cm', 'DISTANCE', '0.01'], ['mm', 'Millimetre', 'mm', 'DISTANCE', '0.001'], ['mi', 'Mile', 'mi', 'DISTANCE', '1609.344'], ['ft', 'Foot', 'ft', 'DISTANCE', '0.3048'], ['in', 'Inch', 'in', 'DISTANCE', '0.0254'],
  ['kg', 'Kilogram', 'kg', 'MASS', '1'], ['g', 'Gram', 'g', 'MASS', '0.001'], ['lb', 'Pound', 'lb', 'MASS', '0.45359237'],
  ['L', 'Litre', 'L', 'VOLUME', '1'], ['mL', 'Millilitre', 'mL', 'VOLUME', '0.001'],
  ['d', 'Day', 'd', 'TIME', '86400'], ['h', 'Hour', 'h', 'TIME', '3600'], ['min', 'Minute', 'min', 'TIME', '60'], ['s', 'Second', 's', 'TIME', '1'],
  ['bpm', 'Beats per minute', 'bpm', 'FREQUENCY', '1'],
  ['item', 'Item', 'item', 'COUNT', '1'], ['%', 'Percent', '%', 'RATIO', '0.01'],
  ['°C', 'Celsius', '°C', 'TEMPERATURE', '1'], ['°F', 'Fahrenheit', '°F', 'TEMPERATURE', '1'],
  ['EUR', 'Euro', '€', 'CURRENCY', '1'], ['USD', 'US dollar', '$', 'CURRENCY', '1'], ['GBP', 'British pound', '£', 'CURRENCY', '1'], ['NGN', 'Nigerian naira', '₦', 'CURRENCY', '1'], ['FCFA', 'CFA franc', 'FCFA', 'CURRENCY', '1'],
].map(([id, name, symbol, dimension, factor]) => ({ id, name, symbol, dimension, factor, version: 1 }));

export function decimal(value: string, positive = false): Rational {
  if (!/^[+-]?(?:\d+)(?:\.\d{1,12})?$/.test(value) || value.length > 40) throw new BadRequestException('Use a decimal number with at most 12 decimal places');
  const negative = value.startsWith('-');
  const clean = value.replace(/^[+-]/, '');
  const [whole, fraction = ''] = clean.split('.');
  const d = 10n ** BigInt(fraction.length);
  const n = (BigInt(whole) * d + BigInt(fraction || '0')) * (negative ? -1n : 1n);
  if (positive && n <= 0n) throw new BadRequestException('Factor or rate must be positive');
  return { n, d };
}

export function multiply(a: Rational, b: Rational): Rational { return { n: a.n * b.n, d: a.d * b.d }; }
export function divide(a: Rational, b: Rational): Rational {
  if (b.n === 0n) throw new BadRequestException('Cannot divide by zero');
  const sign = b.n < 0n ? -1n : 1n;
  return { n: a.n * b.d * sign, d: a.d * b.n * sign };
}
export function fractionText(value: Rational): string {
  const negative = value.n < 0n;
  const absolute = negative ? -value.n : value.n;
  const scale = 10n ** 12n;
  const rounded = (absolute * scale * 2n + value.d) / (2n * value.d);
  const whole = rounded / scale;
  const tail = (rounded % scale).toString().padStart(12, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${tail ? `.${tail}` : ''}`;
}

export type ResolvedUnit = { unit: CollectionUnit; factor: Rational; root: string; dimension: string; objectFormatId?: string };
export function resolveUnit(id: string, locals: CollectionUnit[], visited = new Set<string>()): ResolvedUnit {
  const builtIn = builtInUnits.find((item) => item.id === id);
  if (builtIn) return { unit: builtIn, factor: decimal(builtIn.factor, true), root: builtIn.dimension, dimension: builtIn.dimension };
  const unit = locals.find((item) => item.id === id);
  if (!unit) throw new BadRequestException(`Unknown unit: ${id}`);
  if (visited.has(id)) throw new BadRequestException('Unit definitions cannot form a cycle');
  visited.add(id);
  const factor = decimal(unit.factor, true);
  if (!unit.baseUnitId) return { unit, factor, root: unit.id, dimension: unit.dimension, objectFormatId: unit.objectFormatId };
  const base = resolveUnit(unit.baseUnitId, locals, visited);
  if (unit.dimension !== base.dimension) throw new BadRequestException('Base unit must have the same dimension');
  if (base.objectFormatId && unit.objectFormatId !== base.objectFormatId) throw new BadRequestException('Count units must refer to the same object model');
  return { unit, factor: multiply(factor, base.factor), root: base.root, dimension: unit.dimension, objectFormatId: unit.objectFormatId ?? base.objectFormatId };
}
