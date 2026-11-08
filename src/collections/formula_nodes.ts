export type BooleanExpression = { kind: 'boolean'; value: boolean } | { kind: 'comparison'; operator: 'EQ' | 'NEQ' | 'LT' | 'LTE' | 'GT' | 'GTE'; left: Expression; right: Expression } | { kind: 'logical'; operator: 'AND' | 'OR'; args: BooleanExpression[] } | { kind: 'not'; arg: BooleanExpression };
export type DateExpression = { kind: 'dateField'; fieldId: string } | { kind: 'dateLiteral'; value: string } | { kind: 'addDays'; date: DateExpression; days: Expression } | { kind: 'startOfMonth'; date: DateExpression } | { kind: 'endOfMonth'; date: DateExpression };
export type Expression = { kind: 'number'; value: string; unit?: string } | { kind: 'field'; fieldId: string } | { kind: 'property'; referenceFieldId: string; propertyFieldId: string } | { kind: 'formula'; formulaId: string } | { kind: 'dateDifference'; fromFieldId: string; toFieldId: string; unit: 'd' | 'h' } | { kind: 'round'; digits: number; mode: 'HALF_UP' | 'HALF_EVEN'; value: Expression } | { kind: 'operation'; operator: 'ADD' | 'SUBTRACT' | 'MULTIPLY' | 'DIVIDE'; args: Expression[] } | { kind: 'conditional'; condition: BooleanExpression; then: Expression; else: Expression } | { kind: 'min'; args: Expression[] } | { kind: 'max'; args: Expression[] } | { kind: 'abs'; value: Expression } | { kind: 'floor'; value: Expression } | { kind: 'ceil'; value: Expression } | { kind: 'modulo'; left: Expression; right: Expression } | { kind: 'dateDiff'; unit: 'DAYS' | 'HOURS' | 'MONTHS'; end: DateExpression; start: DateExpression } | { kind: 'datePart'; part: 'YEAR' | 'MONTH' | 'DAY' | 'WEEKDAY'; date: DateExpression } | { kind: 'durationField'; fieldId: string } | { kind: 'durationIn'; unit: 'MINUTES' | 'HOURS'; duration: Expression };
/** A saved formula gives either a quantity or a date. */
export type FormulaNode = Expression | DateExpression;

/** Keys holding one nested formula node. Everything that rewrites or scans a stored expression must follow them, as well as `args`. */
export const formulaChildKeys: readonly string[] = ['value', 'condition', 'then', 'else', 'left', 'right', 'arg', 'date', 'days', 'end', 'start', 'duration'];

const dateKinds: readonly string[] = ['dateField', 'dateLiteral', 'addDays', 'startOfMonth', 'endOfMonth'];
export const isDateExpression = (node: FormulaNode): node is DateExpression => dateKinds.includes(node.kind);

/** Calendar values are read in UTC, the form in which date-time fields are stored. */
export type FormulaDate = { ms: number; hasTime: boolean };
const dateText = /^(\d{4})-(\d{2})-(\d{2})(T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const earliest = Date.UTC(100, 0, 1);
const latest = Date.UTC(10000, 0, 1) - 1;
const MS_PER_DAY = 86400000;
const MAX_DAY_SHIFT = 4000000n;

export function parseFormulaDate(text: unknown): FormulaDate | undefined {
  const match = typeof text === 'string' ? dateText.exec(text) : null;
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const calendar = new Date(Date.UTC(year, month - 1, day));
  // Date.parse would roll 31 February over to March.
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return undefined;
  if (!match[4]) return { ms: calendar.getTime(), hasTime: false };
  const ms = Date.parse(text as string);
  return Number.isNaN(ms) ? undefined : { ms, hasTime: true };
}

export const formatFormulaDate = (date: FormulaDate): string => (date.hasTime ? new Date(date.ms).toISOString() : new Date(date.ms).toISOString().slice(0, 10));

/** Gives undefined when the result falls outside the years 100 to 9999. */
export function addDaysToDate(date: FormulaDate, days: bigint): FormulaDate | undefined {
  if (days > MAX_DAY_SHIFT || days < -MAX_DAY_SHIFT) return undefined;
  const ms = date.ms + Number(days) * MS_PER_DAY;
  return ms < earliest || ms > latest ? undefined : { ms, hasTime: date.hasTime };
}

export function startOfMonth(date: FormulaDate): FormulaDate {
  const value = new Date(date.ms);
  return { ms: Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1), hasTime: false };
}

export function endOfMonth(date: FormulaDate): FormulaDate {
  const value = new Date(date.ms);
  return { ms: Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0), hasTime: false };
}

/** WEEKDAY follows ISO 8601: Monday is 1 and Sunday is 7. */
export function datePart(date: FormulaDate, part: 'YEAR' | 'MONTH' | 'DAY' | 'WEEKDAY'): number {
  const value = new Date(date.ms);
  if (part === 'YEAR') return value.getUTCFullYear();
  if (part === 'MONTH') return value.getUTCMonth() + 1;
  return part === 'DAY' ? value.getUTCDate() : value.getUTCDay() || 7;
}

/** Complete calendar months, negative when end precedes start: 31 January to 28 February is 0. */
export function wholeMonthsBetween(start: FormulaDate, end: FormulaDate): number {
  if (end.ms < start.ms) return -wholeMonthsBetween(end, start);
  const from = new Date(start.ms);
  const to = new Date(end.ms);
  const intoMonth = (value: Date): number => value.getTime() - Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1);
  const months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth();
  return intoMonth(to) < intoMonth(from) ? months - 1 : months;
}
