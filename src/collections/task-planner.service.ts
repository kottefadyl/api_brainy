import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Collection, FieldKind } from './collection.schema.js';
import { CollectionRole } from './collaboration.schema.js';
import { CollaborationService } from './collaboration.service.js';
import { CollectionsService } from './collections.service.js';
import { Entry } from './entry.schema.js';
import { occurrences, repeatLabels, validDay, weekdayLabels, dayDiff, occursOn, type TaskRule } from './task-planner.logic.js';
import { TaskAgenda, TaskPlanner } from './task-planner.schema.js';
import { localDate, localTime, validTimeZone } from './time_math.js';
import { taskRule } from './task-planner.rule.js';
import { ReminderService } from './reminder.service.js';

type TemplateField = { name: string; kind: FieldKind; options?: string[] };

/** Fields of the Task list template (T49). Order matters: the planner maps them by position. */
export function taskTemplateFields(fr: boolean): TemplateField[] {
  return [
    { name: fr ? 'Titre' : 'Title', kind: FieldKind.TITLE },
    { name: fr ? 'Terminée' : 'Done', kind: FieldKind.BOOLEAN },
    { name: fr ? 'Début' : 'Start', kind: FieldKind.DATE },
    { name: fr ? 'Fin ou échéance' : 'End or due date', kind: FieldKind.DATE },
    { name: fr ? 'Répétition' : 'Repeat', kind: FieldKind.SELECT, options: Object.values(repeatLabels).map((labels) => labels[fr ? 1 : 0]) },
    { name: fr ? 'Tous les N jours' : 'Every N days', kind: FieldKind.NUMBER },
    { name: fr ? 'Jours de la semaine' : 'Weekdays', kind: FieldKind.MULTI_SELECT, options: weekdayLabels.map((labels) => labels[fr ? 1 : 0]) },
    { name: fr ? 'Terminée le' : 'Completed at', kind: FieldKind.DATETIME },
  ];
}

@Injectable()
export class TaskPlannerService {
  constructor(
    private readonly collections: CollectionsService,
    private readonly collaboration: CollaborationService,
    @InjectModel(Collection.name) private readonly collectionModel: Model<Collection>,
    @InjectModel(Entry.name) private readonly entries: Model<Entry>,
    private readonly reminders: ReminderService,
  ) {}

  /** Records the planner on the collection and adds the Day and Calendar views. */
  async setUp(collectionId: string, formatId: string, ownerId: string, language?: string): Promise<Collection> {
    const fr = language === 'fr';
    const collection = await this.collections.one(collectionId, ownerId);
    const format = collection.formats.find((item) => item.id === formatId)!;
    const byName = (name: string, kind: FieldKind) => format.fields.find((field) => field.name === name && field.kind === kind)?.id;
    const names = taskTemplateFields(fr);
    const ids = names.map((field) => byName(field.name, field.kind));
    if (ids.slice(0, 7).some((id) => !id)) throw new BadRequestException('The task data format misses planner fields');
    const planner: TaskPlanner = { formatId, doneFieldId: ids[1]!, startFieldId: ids[2]!, endFieldId: ids[3]!, repeatFieldId: ids[4]!, intervalFieldId: ids[5]!, weekdaysFieldId: ids[6]!, completedFieldId: ids[7] };
    await this.collectionModel.updateOne({ _id: collectionId }, { $set: { taskPlanner: planner, templateId: 'tasks' } }).exec();
    let updated = await this.collections.one(collectionId, ownerId);
    const view = (name: string, layout: string) => ({ name, layout, formatIds: [formatId], columnFieldIds: format.fields.map((field) => field.id), sort: 'NEWEST', groupByFormat: false });
    if (!updated.savedViews.some((item) => item.layout === 'TASK_DAY')) updated = await this.collections.saveView(collectionId, ownerId, view(fr ? 'Tâches du jour' : 'Tasks by day', 'TASK_DAY'));
    if (!updated.savedViews.some((item) => item.layout === 'TASK_CALENDAR')) updated = await this.collections.saveView(collectionId, ownerId, view(fr ? 'Calendrier des tâches' : 'Task calendar', 'TASK_CALENDAR'));
    return updated;
  }

  /** Upgrades a Task list made before T49: adds the missing planner fields, keeps every entry. */
  async enableForLegacy(collectionId: string, ownerId: string, language?: string): Promise<Collection> {
    const fr = language === 'fr';
    const collection = await this.collections.one(collectionId, ownerId);
    this.collaboration.checkAccess(collection, ownerId, CollectionRole.OWNER);
    if (collection.taskPlanner) return collection;
    if (collection.templateId && collection.templateId !== 'tasks') throw new BadRequestException('Only a Task list collection can use the task planner');
    const format = collection.formats.find((item) => item.fields.some((field) => field.kind === FieldKind.TITLE) && item.fields.some((field) => field.kind === FieldKind.BOOLEAN));
    if (!format) throw new BadRequestException('Only a Task list collection can use the task planner');
    const wanted = taskTemplateFields(fr);
    const used = new Set<string>();
    const pick = (kind: FieldKind, names: string[]) => {
      const field = format.fields.find((item) => item.kind === kind && !used.has(item.id) && names.some((name) => name.toLowerCase() === item.name.toLowerCase())) ?? (names.length ? undefined : format.fields.find((item) => item.kind === kind && !used.has(item.id)));
      if (field) used.add(field.id);
      return field;
    };
    const title = pick(FieldKind.TITLE, []), done = pick(FieldKind.BOOLEAN, []);
    const end = pick(FieldKind.DATE, ['Due', 'Échéance', 'End or due date', 'Fin ou échéance']) ?? pick(FieldKind.DATE, []);
    const completed = pick(FieldKind.DATETIME, ['Completed at', 'Terminée le']) ?? pick(FieldKind.DATETIME, []);
    const fields = format.fields.map((field) => ({ id: field.id, name: field.name, kind: field.kind, unit: field.unit, options: field.options, targetObjectFormatId: field.targetObjectFormatId, multiple: field.multiple, variableName: field.variableName, referenceMode: field.referenceMode, codeListId: field.codeListId, sensitivity: field.sensitivity }));
    const rename = (id: string | undefined, name: string) => { const field = fields.find((item) => item.id === id); if (field && !fields.some((item) => item.id !== id && item.name.toLowerCase() === name.toLowerCase())) field.name = name; };
    rename(title?.id, wanted[0].name); rename(done?.id, wanted[1].name); rename(end?.id, wanted[3].name); rename(completed?.id, wanted[7].name);
    const add = (index: number) => { if (!fields.some((item) => item.name.toLowerCase() === wanted[index].name.toLowerCase())) fields.push({ ...wanted[index] } as never); };
    add(2); if (!end) add(3); add(4); add(5); add(6); if (!completed) add(7);
    if (fields.length > 30) throw new BadRequestException('This data format has no room for the planner fields');
    await this.collections.updateFormat(collectionId, format.id, { name: format.name, expectedVersion: format.version ?? 1, fields: fields as never }, ownerId);
    return this.setUp(collectionId, format.id, ownerId, language);
  }

  private async context(collectionId: string, userId: string, role: CollectionRole) {
    const collection = await this.collections.one(collectionId, userId);
    this.collaboration.checkAccess(collection, userId, role);
    if (!collection.taskPlanner || collection.templateId !== 'tasks') throw new NotFoundException('Task planner not found');
    return { collection, planner: collection.taskPlanner };
  }

  private rule(entry: Entry, planner: TaskPlanner, timeZone: string): TaskRule { return taskRule(entry, planner, timeZone); }

  async agenda(collectionId: string, userId: string, from: string, to: string, today: string, timeZone: string): Promise<TaskAgenda> {
    const { collection, planner } = await this.context(collectionId, userId, CollectionRole.READER);
    if (![from, to, today].every(validDay) || to < from || dayDiff(from, to) > 62) throw new BadRequestException('Choose up to 62 days');
    if (!validTimeZone(timeZone)) throw new BadRequestException('Choose a valid IANA time zone');
    const access = this.collaboration.checkAccess(collection, userId, CollectionRole.READER);
    const found = await this.entries.find({ collectionId: collection.id, formatId: planner.formatId, movingOperationId: null }).sort({ createdAt: 1 }).limit(5000).exec();
    const found2 = found.map((entry) => this.collaboration.filterEntryFields(entry, access.member, collection));
    const list = occurrences(found2.map((entry) => this.rule(entry, planner, timeZone)), from, to, today);
    const ids = new Set(list.map((item) => item.entryId));
    return { occurrences: list, entries: found2.filter((entry) => ids.has(String((entry as unknown as { _id: unknown })._id ?? entry.id))) };
  }

  async setDone(collectionId: string, userId: string, entryId: string, date: string, done: boolean, timeZone: string): Promise<Entry> {
    const { collection, planner } = await this.context(collectionId, userId, CollectionRole.EDITOR);
    if (!Types.ObjectId.isValid(entryId) || !validDay(date) || !validTimeZone(timeZone)) throw new BadRequestException('Invalid task day');
    const entry = await this.entries.findOne({ _id: entryId, collectionId: collection.id, formatId: planner.formatId, movingOperationId: null }).exec();
    if (!entry) throw new NotFoundException('Task not found');
    const rule = this.rule(entry, planner, timeZone);
    let update: Record<string, unknown>;
    if (rule.repeat === 'ONCE') {
      const values = entry.values.filter((item) => item.fieldId !== planner.doneFieldId && item.fieldId !== planner.completedFieldId);
      values.push({ fieldId: planner.doneFieldId, value: done ? 'true' : 'false', booleanValue: done } as never);
      if (done && planner.completedFieldId) {
        const now = new Date();
        const stamp = localDate(localTime(now, timeZone)) === date ? now.toISOString() : new Date(`${date}T12:00:00Z`).toISOString();
        values.push({ fieldId: planner.completedFieldId, value: stamp, dateTimeValue: stamp } as never);
      }
      update = { $set: { values, ...(done ? { taskCompletions: [date] } : {}) }, ...(done ? {} : { $unset: { taskCompletions: '' } }), $push: { revisions: { $each: [{ at: (entry as unknown as { updatedAt: Date }).updatedAt, formatVersion: entry.formatVersion ?? 1, values: entry.values }], $slice: -20 } } };
    } else {
      if (!occursOn(rule, date)) throw new BadRequestException('This task is not planned on that day');
      if (done && (entry.taskCompletions?.length ?? 0) >= 5000) throw new BadRequestException('This task has too many checked days');
      update = done ? { $addToSet: { taskCompletions: date } } : { $pull: { taskCompletions: date } };
    }
    update.$set = { ...(update.$set as Record<string, unknown> | undefined), updatedBy: userId };
    const updated = await this.entries.findOneAndUpdate({ _id: entryId, collectionId: collection.id }, update, { returnDocument: 'after' }).exec();
    if (!updated) throw new NotFoundException('Task not found');
    await this.collaboration.logAction(collection.id, userId, 'UPDATE_ENTRY', `${done ? 'Checked' : 'Unchecked'} task ${entryId} on ${date}`);
    await this.reminders.refreshEntry(entryId, userId).catch(() => undefined);
    return updated;
  }
}
