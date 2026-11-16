// Durations: one exact number of seconds, typed in a unit chosen on the field (seconds to weeks).
// Months are left out on purpose: they are 28 to 31 days long, so they cannot be added up exactly.
export const DURATION_UNITS = { s: 1, min: 60, h: 3600, d: 86400, w: 604800 } as const;
export type DurationUnit = keyof typeof DURATION_UNITS;
export const MAX_DURATION_SECONDS = 999999 * 3600;

export const isDurationUnit = (unit: string | undefined | null): unit is DurationUnit => !!unit && unit in DURATION_UNITS;

const words: [RegExp, DurationUnit][] = [
  [/^(w|wk|wks|week|weeks|sem|sems|semaine|semaines)$/, 'w'],
  [/^(d|day|days|j|jr|jrs|jour|jours)$/, 'd'],
  [/^(h|hr|hrs|hour|hours|heure|heures)$/, 'h'],
  [/^(m|mn|min|mins|minute|minutes)$/, 'min'],
  [/^(s|sec|secs|second|seconds|seconde|secondes)$/, 's'],
];
const order: DurationUnit[] = ['w', 'd', 'h', 'min', 's'];

/**
 * Seconds in a typed duration, or null. Accepts "45" (in the field unit, hours without one), "1:30"
 * (hours:minutes), "2 h 30", "1d 4h", "1,5 h", "3 j", "2 sem". A bare number after a unit is the next unit down.
 */
export function parseDuration(text: string, unit?: string | null): number | null {
  const clean = text.trim().toLowerCase().replace(/,/g, '.');
  if (!clean || clean.length > 80) return null;
  const clock = /^(\d{1,6}):([0-5]\d)(?::([0-5]\d))?$/.exec(clean);
  let seconds: number;
  if (clock) seconds = Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3] ?? 0);
  else if (/^\d+(\.\d+)?$/.test(clean)) seconds = Number(clean) * DURATION_UNITS[isDurationUnit(unit) ? unit : 'h'];
  else {
    const parts = clean.match(/\d+(?:\.\d+)?|[a-zéè]+/g);
    if (!parts || parts.join('') !== clean.replace(/\s+/g, '')) return null;
    seconds = 0;
    let last: DurationUnit | null = null;
    for (let index = 0; index < parts.length; index++) {
      const amount = Number(parts[index]);
      if (!Number.isFinite(amount)) return null;
      const word = parts[index + 1];
      let found: DurationUnit | undefined;
      if (word !== undefined && !/^\d/.test(word)) { found = words.find(([pattern]) => pattern.test(word))?.[1]; if (!found) return null; index++; }
      else if (last && last !== 's') found = order[order.indexOf(last) + 1];
      else return null;
      if (last && order.indexOf(found) <= order.indexOf(last)) return null;
      seconds += amount * DURATION_UNITS[found];
      last = found;
    }
  }
  seconds = Math.round(seconds);
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= MAX_DURATION_SECONDS ? seconds : null;
}

/** Stored text: "h:mm" for a field without a unit (as before), otherwise "1w 2d 3h 30min 15s". */
export function durationValue(seconds: number, unit?: string | null): string {
  if (!isDurationUnit(unit)) { const minutes = Math.round(seconds / 60); return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`; }
  if (seconds === 0) return `0${unit}`;
  let rest = seconds;
  const parts: string[] = [];
  for (const key of order) { const count = Math.floor(rest / DURATION_UNITS[key]); if (count) { parts.push(`${count}${key}`); rest -= count * DURATION_UNITS[key]; } }
  return parts.join(' ');
}
