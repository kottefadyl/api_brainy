import type { Entry } from './entry.schema.js';
import { parseRepeat, parseWeekdays, validDay, type TaskRule } from './task-planner.logic.js';
import type { TaskPlanner } from './task-planner.schema.js';
import { localDate, localTime } from './time_math.js';

/** T49: scheduling rule of a task entry. A once task done on a day keeps that day (sent by the device). */
export function taskRule(entry: Entry, planner: TaskPlanner, timeZone: string): TaskRule {
  const value = (id?: string) => id ? entry.values.find((item) => item.fieldId === id) : undefined;
  const day = (id: string) => { const text = value(id)?.value; return validDay(text) ? text : undefined; };
  const completedAt = value(planner.completedFieldId)?.value;
  const created = (entry as unknown as { createdAt?: Date }).createdAt ?? new Date();
  const repeat = parseRepeat(value(planner.repeatFieldId)?.value);
  const completions = entry.taskCompletions ?? [];
  const checkedDay = repeat === 'ONCE' ? completions.at(-1) : undefined;
  return {
    id: String((entry as unknown as { _id?: unknown })._id ?? entry.id),
    repeat,
    start: day(planner.startFieldId),
    end: day(planner.endFieldId),
    interval: Math.min(365, Math.max(1, Math.floor(Number(value(planner.intervalFieldId)?.value) || 1))),
    weekdays: parseWeekdays(value(planner.weekdaysFieldId)?.selectedValues ?? []),
    done: value(planner.doneFieldId)?.value === 'true',
    doneDate: checkedDay ?? (completedAt && !Number.isNaN(Date.parse(completedAt)) ? localDate(localTime(new Date(completedAt), timeZone)) : undefined),
    completions: repeat === 'ONCE' ? [] : completions,
    createdDate: localDate(localTime(new Date(created), timeZone)),
  };
}
