// T56: spaced repetition for flash cards. After turning a card the person answers Again, Hard, Good or Easy;
// the answer sets when the card comes back. Brainy's own simple rules (in the family of SM-2):
// a forgotten card comes back soon, a well-known card comes back later and later.

export type CardGrade = 'AGAIN' | 'HARD' | 'GOOD' | 'EASY';
export const CARD_GRADES: CardGrade[] = ['AGAIN', 'HARD', 'GOOD', 'EASY'];

export type CardSchedule = { intervalDays: number; ease: number; reps: number; lapses: number };

const DAY = 86_400_000;
const MINUTE = 60_000;
export const START_EASE = 2.5;
const MIN_EASE = 1.3;
const MAX_INTERVAL_DAYS = 3650;

/** Next state and due time of a card answered with [grade]; [previous] is null for a card never reviewed. */
export function nextReview(previous: CardSchedule | null, grade: CardGrade, now = new Date()): CardSchedule & { due: Date } {
  const learning = !previous || previous.reps === 0;
  const ease = previous?.ease ?? START_EASE;
  const interval = previous?.intervalDays ?? 0;
  let next: CardSchedule;
  let dueMs: number;
  if (grade === 'AGAIN') {
    // Forgotten: back in 10 minutes (it is also shown again later in the same session), then from 1 day.
    next = { intervalDays: 0, ease: learning ? ease : Math.max(MIN_EASE, ease - 0.2), reps: 0, lapses: (previous?.lapses ?? 0) + (learning ? 0 : 1) };
    dueMs = now.getTime() + 10 * MINUTE;
    return { ...next, due: new Date(dueMs) };
  }
  if (learning) {
    const days = grade === 'EASY' ? 4 : 1;
    next = { intervalDays: days, ease: grade === 'EASY' ? ease + 0.15 : grade === 'HARD' ? Math.max(MIN_EASE, ease - 0.15) : ease, reps: 1, lapses: previous?.lapses ?? 0 };
  } else {
    const base = Math.max(1, interval);
    const days = grade === 'HARD' ? Math.max(base + 1, Math.round(base * 1.2))
      : grade === 'GOOD' ? Math.max(base + 1, Math.round(base * ease))
      : Math.max(base + 2, Math.round(base * ease * 1.3));
    next = { intervalDays: Math.min(MAX_INTERVAL_DAYS, days), ease: grade === 'HARD' ? Math.max(MIN_EASE, ease - 0.15) : grade === 'EASY' ? ease + 0.15 : ease, reps: (previous?.reps ?? 0) + 1, lapses: previous?.lapses ?? 0 };
  }
  dueMs = now.getTime() + next.intervalDays * DAY;
  return { ...next, due: new Date(dueMs) };
}

/** Time each answer would give, for the hints under the buttons ("10 min", "1 d", "4 d"...), in minutes. */
export function previewMinutes(previous: CardSchedule | null, now = new Date()): Record<CardGrade, number> {
  return Object.fromEntries(CARD_GRADES.map((grade) => [grade, Math.round((nextReview(previous, grade, now).due.getTime() - now.getTime()) / MINUTE)])) as Record<CardGrade, number>;
}

/** Fisher–Yates shuffle (random order of a review). */
export function shuffled<T>(items: T[], random = Math.random): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}
