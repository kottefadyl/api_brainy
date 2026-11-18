// T57: pure helpers for learning progress (days in the person's own time zone, streaks, forecast).
const DAY = 86_400_000;
export const MATURE_DAYS = 21;

/** Keeps a time zone offset within real limits (minutes east of UTC). */
export function cleanOffset(offsetMinutes?: number | null): number {
  return Number.isInteger(offsetMinutes) ? Math.max(-840, Math.min(840, offsetMinutes!)) : 0;
}

/** The person's local day (YYYY-MM-DD) of an instant. */
export function localDay(at: Date, offsetMinutes: number): string {
  return new Date(at.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

/** The day [delta] days after [day] (YYYY-MM-DD). */
export function shiftDay(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY).toISOString().slice(0, 10);
}

/**
 * Days in a row whose count reaches [goal] (or at least one card without a goal), ending today,
 * or yesterday when today is not reached yet (the day is not over).
 */
export function streak(countByDay: Map<string, number>, today: string, goal?: number | null): number {
  const target = goal && goal > 0 ? goal : 1;
  let day = (countByDay.get(today) ?? 0) >= target ? today : shiftDay(today, -1);
  let days = 0;
  while ((countByDay.get(day) ?? 0) >= target && days < 3660) { days++; day = shiftDay(day, -1); }
  return days;
}

/** Cards due on each of the next [days] local days; overdue cards count for today. */
export function dueForecast(dues: Date[], now: Date, offsetMinutes: number, days = 7): number[] {
  const today = localDay(now, offsetMinutes);
  const counts = new Array<number>(days).fill(0);
  for (const due of dues) {
    const day = localDay(due, offsetMinutes);
    const index = due <= now || day <= today ? 0 : Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);
    if (index < days) counts[index]++;
  }
  return counts;
}

/** How many new cards a session may still show today; null means no limit. */
export function newAllowance(limit: number | null | undefined, seenToday: number): number | null {
  return limit == null ? null : Math.max(0, limit - seenToday);
}

/** Checks a goal value: empty, or a whole number from 1 to 9999. */
export function goalValue(value: number | null | undefined, label: string): number | null {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 1 || value > 9999) throw new Error(`${label} must be a whole number from 1 to 9999`);
  return value;
}
