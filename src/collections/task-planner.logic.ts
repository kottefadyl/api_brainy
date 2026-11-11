/**
 * T49: pure scheduling rules of the Task list planner. Dates are local calendar days (YYYY-MM-DD).
 * - Once: the task shows on every day of its period until it is checked; once checked it shows only on the
 *   day it was done. Past its end and still open, it shows on "today" as overdue.
 * - Repeating: each occurrence has its own check; a missed day stays missed (nothing is carried over).
 */
export type Repeat = 'ONCE' | 'DAILY' | 'EVERY_N_DAYS' | 'WEEKDAYS' | 'WEEKLY' | 'MONTHLY';
export type TaskRule = { id: string; repeat: Repeat; start?: string; end?: string; interval: number; weekdays: number[]; done: boolean; doneDate?: string; completions: string[]; createdDate: string };
export type Occurrence = { entryId: string; date: string; done: boolean; overdue: boolean; repeating: boolean };

export const repeatLabels: Record<Repeat, [string, string]> = {
  ONCE: ['Once', 'Une seule fois'],
  DAILY: ['Every day', 'Chaque jour'],
  EVERY_N_DAYS: ['Every N days', 'Tous les N jours'],
  WEEKDAYS: ['Some weekdays', 'Certains jours de la semaine'],
  WEEKLY: ['Every week', 'Chaque semaine'],
  MONTHLY: ['Every month', 'Chaque mois'],
};
export const weekdayLabels: [string, string][] = [['Monday', 'Lundi'], ['Tuesday', 'Mardi'], ['Wednesday', 'Mercredi'], ['Thursday', 'Jeudi'], ['Friday', 'Vendredi'], ['Saturday', 'Samedi'], ['Sunday', 'Dimanche']];

const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

/** Choice labels are matched in English or French, so renaming the order of choices does not break schedules. */
export function parseRepeat(value: string | undefined): Repeat {
  if (!value) return 'ONCE';
  const key = fold(value);
  return (Object.entries(repeatLabels).find(([, labels]) => labels.some((label) => fold(label) === key))?.[0] as Repeat | undefined) ?? 'ONCE';
}

/** ISO weekday 1 (Monday) to 7 (Sunday). */
export function parseWeekdays(values: string[]): number[] {
  const days = new Set<number>();
  for (const value of values) {
    const key = fold(value).slice(0, 3);
    const index = weekdayLabels.findIndex(([en, fr]) => fold(en).slice(0, 3) === key || fold(fr).slice(0, 3) === key);
    if (index >= 0) days.add(index + 1);
  }
  return [...days].sort();
}

export const validDay = (value: string | undefined): value is string => !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const toTime = (day: string) => Date.parse(`${day}T00:00:00Z`);
export const addDays = (day: string, count: number) => new Date(toTime(day) + count * 86_400_000).toISOString().slice(0, 10);
export const dayDiff = (from: string, to: string) => Math.round((toTime(to) - toTime(from)) / 86_400_000);
const isoWeekday = (day: string) => ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

export function occursOn(rule: TaskRule, day: string): boolean {
  const start = rule.start ?? rule.createdDate;
  if (day < start || (rule.end && day > rule.end)) return false;
  switch (rule.repeat) {
    case 'DAILY': return true;
    case 'EVERY_N_DAYS': return dayDiff(start, day) % Math.max(1, rule.interval) === 0;
    case 'WEEKDAYS': return (rule.weekdays.length ? rule.weekdays : [isoWeekday(start)]).includes(isoWeekday(day));
    case 'WEEKLY': return isoWeekday(day) === isoWeekday(start);
    case 'MONTHLY': {
      const wanted = Number(start.slice(8, 10));
      const [year, month] = [Number(day.slice(0, 4)), Number(day.slice(5, 7))];
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      return Number(day.slice(8, 10)) === Math.min(wanted, lastDay);
    }
    default: return false;
  }
}

export function occurrences(rules: TaskRule[], from: string, to: string, today: string): Occurrence[] {
  const result: Occurrence[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    for (const rule of rules) {
      if (rule.repeat === 'ONCE') {
        const start = rule.start ?? rule.end, end = rule.end ?? rule.start;
        if (rule.done) {
          const doneDay = rule.doneDate ?? end ?? today;
          if (day === doneDay) result.push({ entryId: rule.id, date: day, done: true, overdue: false, repeating: false });
        } else if (!start || !end) {
          if (day === today) result.push({ entryId: rule.id, date: day, done: false, overdue: false, repeating: false });
        } else if (day >= start && day <= end) {
          result.push({ entryId: rule.id, date: day, done: false, overdue: false, repeating: false });
        } else if (day === today && today > end) {
          result.push({ entryId: rule.id, date: day, done: false, overdue: true, repeating: false });
        }
      } else if (occursOn(rule, day)) {
        result.push({ entryId: rule.id, date: day, done: rule.completions.includes(day), overdue: false, repeating: true });
      }
    }
  }
  return result;
}
