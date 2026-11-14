import { BadRequestException } from '@nestjs/common';

export type LocalTime = { year: number; month: number; day: number; hour: number; minute: number; second: number };
const formatters = new Map<string, Intl.DateTimeFormat>();

export function validTimeZone(zone: string): boolean {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; }
}

export function localTime(instant: Date, zone: string): LocalTime {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    formatters.set(zone, formatter);
  }
  const values = Object.fromEntries(formatter.formatToParts(instant).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
  return { year: values.year, month: values.month, day: values.day, hour: values.hour, minute: values.minute, second: values.second };
}

export function localDate(value: LocalTime): string {
  return `${value.year.toString().padStart(4, '0')}-${value.month.toString().padStart(2, '0')}-${value.day.toString().padStart(2, '0')}`;
}

function naive(value: LocalTime): number { return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second); }
function same(a: LocalTime, b: LocalTime): boolean { return naive(a) === naive(b); }

// Ambiguous local time: earliest instant. Missing local time: first valid minute after the gap.
export function localToInstant(value: LocalTime, zone: string): Date {
  const wanted = naive(value);
  for (let shift = 0; shift <= 180; shift++) {
    const shifted = new Date(wanted + shift * 60_000);
    const target: LocalTime = { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes(), second: shifted.getUTCSeconds() };
    const offsets = new Set<number>();
    for (const sample of [wanted - 86_400_000, wanted, wanted + 86_400_000]) {
      offsets.add(naive(localTime(new Date(sample), zone)) - sample);
    }
    const matching = [...offsets].map((offset) => new Date(naive(target) - offset)).filter((candidate) => same(localTime(candidate, zone), target)).sort((a, b) => a.getTime() - b.getTime());
    if (matching.length) return matching[0];
  }
  throw new BadRequestException('This local time cannot be scheduled');
}

export function addLocalDays(value: LocalTime, days: number): LocalTime {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day + days, value.hour, value.minute, value.second));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds() };
}

export function addLocalMonths(value: LocalTime, months: number): LocalTime | undefined {
  const date = new Date(Date.UTC(value.year, value.month - 1 + months, value.day, value.hour, value.minute, value.second));
  const monthIndex = value.year * 12 + value.month - 1 + months;
  if (date.getUTCFullYear() * 12 + date.getUTCMonth() !== monthIndex) return undefined;
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds() };
}

export function nextRecurrenceStart(start: Date, rule: { timeZone: string; frequency: string; interval: number; untilDate?: string; excludedDates: string[] }, after: Date): Date | undefined {
  const base = localTime(start, rule.timeZone);
  const near = localTime(after, rule.timeZone);
  const days = Math.floor((Date.UTC(near.year, near.month - 1, near.day) - Date.UTC(base.year, base.month - 1, base.day)) / 86_400_000);
  const months = (near.year - base.year) * 12 + near.month - base.month;
  const first = rule.frequency === 'MONTHLY' ? Math.max(0, Math.floor(months / rule.interval) - 1) : Math.max(0, Math.floor(days / (rule.interval * (rule.frequency === 'WEEKLY' ? 7 : 1))) - 1);
  for (let index = first; index < first + 500; index++) {
    const candidate = rule.frequency === 'MONTHLY' ? addLocalMonths(base, index * rule.interval) : addLocalDays(base, index * rule.interval * (rule.frequency === 'WEEKLY' ? 7 : 1));
    if (!candidate) continue;
    const date = localDate(candidate);
    if (rule.untilDate && date > rule.untilDate) return;
    if (rule.excludedDates.includes(date)) continue;
    const instant = localToInstant(candidate, rule.timeZone);
    if (instant > after) return instant;
  }
  return;
}

/** Midnight of a YYYY-MM-DD day in a time zone (UTC when the zone is missing or unknown). */
export function dayStart(date: string, zone?: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const value = { year, month, day, hour: 0, minute: 0, second: 0 };
  if (Number.isNaN(Date.UTC(year, month - 1, day)) || month < 1 || month > 12 || day < 1 || day > 31) throw new BadRequestException('Choose a valid date');
  return zone && validTimeZone(zone) ? localToInstant(value, zone) : new Date(Date.UTC(year, month - 1, day));
}
