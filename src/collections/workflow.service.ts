import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { Collection, CollectionField, CollectionFormat, FieldKind } from './collection.schema';
import { Entry } from './entry.schema';
import { CollectionRole } from './collaboration.schema';
import { CollaborationService } from './collaboration.service';
import { formatColors } from './collections.service';
import { ReminderService } from './reminder.service';
import { WorkflowAssignmentInput, WorkflowDefinitionInput, WorkflowEvent, WorkflowNotification } from './workflow.schema';
import { assertWorkflowRequirements, validateWorkflowDefinition, workflowState } from './workflow.rules';

type TemplateId = 'TASK' | 'APPROVAL' | 'CASE';
const templates: Record<TemplateId, { en: string; fr: string; statesEn: string[]; statesFr: string[]; edges: [number, number, CollectionRole][] }> = {
  TASK: { en: 'Task', fr: 'Tâche', statesEn: ['To do', 'In progress', 'Done'], statesFr: ['À faire', 'En cours', 'Fait'], edges: [[0, 1, CollectionRole.EDITOR], [1, 2, CollectionRole.EDITOR], [1, 0, CollectionRole.EDITOR], [2, 1, CollectionRole.OWNER]] },
  APPROVAL: { en: 'Approval request', fr: 'Demande à valider', statesEn: ['Submitted', 'In review', 'Approved', 'Rejected'], statesFr: ['Soumise', 'En examen', 'Validée', 'Refusée'], edges: [[0, 1, CollectionRole.EDITOR], [1, 2, CollectionRole.OWNER], [1, 3, CollectionRole.OWNER], [3, 1, CollectionRole.EDITOR]] },
  CASE: { en: 'Tracked case', fr: 'Dossier suivi', statesEn: ['Open', 'Waiting', 'Closed'], statesFr: ['Ouvert', 'En attente', 'Clos'], edges: [[0, 1, CollectionRole.EDITOR], [1, 0, CollectionRole.EDITOR], [0, 2, CollectionRole.OWNER], [1, 2, CollectionRole.OWNER], [2, 0, CollectionRole.OWNER]] },
};

@Injectable()
export class WorkflowService {
  private readonly logger = new Logger(WorkflowService.name);
  constructor(
    @InjectModel(Collection.name) private readonly collections: Model<Collection>,
    @InjectModel(Entry.name) private readonly entries: Model<Entry>,
    @InjectModel(WorkflowNotification.name) private readonly notifications: Model<WorkflowNotification>,
    private readonly collaboration: CollaborationService,
    private readonly reminders: ReminderService,
  ) {}

  private async collection(id: string, actorUserId: string, role: CollectionRole): Promise<Collection> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Collection not found');
    const collection = await this.collections.findById(id).exec();
    if (!collection) throw new NotFoundException('Collection not found');
    this.collaboration.checkAccess(collection, actorUserId, role);
    return collection;
  }

  private async entry(id: string, actorUserId: string, role: CollectionRole): Promise<{ entry: Entry; collection: Collection; format: CollectionFormat }> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Entry not found');
    const entry = await this.entries.findById(id).exec();
    if (!entry) throw new NotFoundException('Entry not found');
    const collection = await this.collection(entry.collectionId, actorUserId, role);
    const format = collection.formats.find((item) => item.id === entry.formatId);
    if (!format?.workflow) throw new BadRequestException('This entry has no workflow');
    return { entry, collection, format };
  }

  async configure(collectionId: string, formatId: string, input: WorkflowDefinitionInput, actorUserId: string): Promise<Collection> {
    const collection = await this.collection(collectionId, actorUserId, CollectionRole.OWNER);
    const format = collection.formats.find((item) => item.id === formatId);
    if (!format) throw new NotFoundException('Data format not found');
    const version = format.version ?? 1;
    if (input.expectedVersion !== version) throw new BadRequestException('Data format changed. Refresh and try again');
    const definition = validateWorkflowDefinition(format, input);
    if (format.workflow && (format.workflow.stateFieldId !== definition.stateFieldId || format.workflow.initialState !== definition.initialState)) {
      throw new BadRequestException('Keep the state field and initial state when editing a workflow');
    }
    const states = format.fields.find((field) => field.id === definition.stateFieldId)!.options!;
    if (await this.entries.exists({ ownerId: collection.ownerId, collectionId, formatId, values: { $not: { $elemMatch: { fieldId: definition.stateFieldId, value: { $in: states } } } } })) {
      throw new BadRequestException('Fill in a valid state on every existing entry before enabling the workflow');
    }
    const updated = await this.collections.findOneAndUpdate(
      { _id: collectionId, formats: { $elemMatch: { id: formatId, version: version === 1 ? { $in: [null, 1] } : version } } },
      { $set: { 'formats.$.workflow': definition, 'formats.$.version': version + 1 } },
      { new: true, runValidators: true },
    ).exec();
    if (!updated) throw new BadRequestException('Data format changed. Refresh and try again');
    await this.collaboration.logAction(collectionId, actorUserId, 'UPDATE_WORKFLOW', `Configured workflow in ${format.name}`);
    return updated;
  }

  async addTemplate(collectionId: string, templateId: string, color: string, language: string | undefined, actorUserId: string): Promise<Collection> {
    const collection = await this.collection(collectionId, actorUserId, CollectionRole.OWNER);
    const template = templates[templateId as TemplateId];
    if (!template) throw new BadRequestException('Choose a workflow template');
    if (!formatColors.includes(color) || collection.formats.some((item) => item.color === color)) throw new BadRequestException('Choose an unused pastel color');
    if (collection.formats.length >= 24) throw new BadRequestException('This collection already has 24 data formats');
    const french = language === 'fr';
    const name = french ? template.fr : template.en;
    if (collection.formats.some((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new BadRequestException('This data format name already exists');
    const states = french ? template.statesFr : template.statesEn;
    const stateFieldId = randomUUID();
    const titleFieldId = randomUUID();
    const fields: CollectionField[] = [
      { id: titleFieldId, name: french ? 'Titre' : 'Title', kind: FieldKind.TITLE },
      { id: stateFieldId, name: french ? 'État' : 'State', kind: FieldKind.SELECT, options: states },
      { id: randomUUID(), name: french ? 'Détails' : 'Details', kind: FieldKind.LONG_TEXT },
    ];
    const format: CollectionFormat = { id: randomUUID(), name, color, fields, version: 1, objectModel: false, workflow: {
      stateFieldId, initialState: states[0],
      transitions: template.edges.map(([from, to, minimumRole]) => ({ from: states[from], to: states[to], minimumRole })),
      requirements: states.map((state) => ({ state, fieldIds: [titleFieldId] })),
    } };
    const updated = await this.collections.findOneAndUpdate(
      { _id: collectionId, 'formats.23': { $exists: false }, 'formats.color': { $ne: color }, 'formats.name': { $ne: name } },
      { $push: { formats: format } }, { new: true, runValidators: true },
    ).exec();
    if (!updated) throw new BadRequestException('Collection changed. Review the new data format');
    await this.collaboration.logAction(collectionId, actorUserId, 'UPDATE_WORKFLOW', `Added ${name} workflow template`);
    return updated;
  }

  private expectedDate(value: string, actual: Date): void {
    const expected = new Date(value);
    if (!Number.isFinite(expected.getTime()) || expected.getTime() !== actual.getTime()) throw new BadRequestException('This entry changed elsewhere. Refresh and try again');
  }

  async transition(entryId: string, to: string, expectedUpdatedAt: string, actorUserId: string): Promise<Entry> {
    const { entry, collection, format } = await this.entry(entryId, actorUserId, CollectionRole.EDITOR);
    this.expectedDate(expectedUpdatedAt, entry.updatedAt);
    const from = workflowState(format, entry.values);
    const rule = format.workflow!.transitions.find((item) => item.from === from && item.to === to);
    if (!from || !rule) throw new BadRequestException('This transition is not allowed');
    const access = this.collaboration.checkAccess(collection, actorUserId, rule.minimumRole);
    if (access.member?.sharedFieldIds?.length && format.fields.some((field) => !access.member!.sharedFieldIds!.includes(field.id))) throw new ForbiddenException('This member cannot work with all fields of this data format');
    assertWorkflowRequirements(format, entry.values, to);
    const event: WorkflowEvent = { kind: 'TRANSITION', from, to, actorUserId, at: new Date(), assigneeUserId: entry.workflow?.assigneeUserId, dueAt: entry.workflow?.dueAt };
    const updated = await this.entries.findOneAndUpdate(
      { _id: entryId, ownerId: collection.ownerId, updatedAt: entry.updatedAt, values: { $elemMatch: { fieldId: format.workflow!.stateFieldId, value: from } } },
      { $set: { 'values.$[state].value': to }, $push: { 'workflow.history': event } },
      { new: true, runValidators: true, arrayFilters: [{ 'state.fieldId': format.workflow!.stateFieldId }] },
    ).exec();
    if (!updated) throw new BadRequestException('This entry changed elsewhere. Refresh and try again');
    if (!format.workflow!.transitions.some((item) => item.from === to)) await this.reminders.scheduleWorkflow(updated, undefined);
    await this.collaboration.logAction(collection.id, actorUserId, 'TRANSITION_WORKFLOW', `${from} → ${to}`);
    return updated;
  }

  async assign(entryId: string, input: WorkflowAssignmentInput, actorUserId: string): Promise<Entry> {
    const { entry, collection, format } = await this.entry(entryId, actorUserId, CollectionRole.EDITOR);
    this.expectedDate(input.expectedUpdatedAt, entry.updatedAt);
    const actorAccess = this.collaboration.checkAccess(collection, actorUserId, CollectionRole.EDITOR);
    if (actorAccess.member?.sharedFieldIds?.length && format.fields.some((field) => !actorAccess.member!.sharedFieldIds!.includes(field.id))) throw new ForbiddenException('This member cannot work with all fields of this data format');
    const from = workflowState(format, entry.values);
    if (!from) throw new BadRequestException('This entry has no state');
    const assigneeUserId = input.assigneeUserId || undefined;
    if (assigneeUserId && assigneeUserId !== collection.ownerId) {
      const member = (collection.members ?? []).find((item) => item.userId === assigneeUserId);
      if (!member || member.role === CollectionRole.READER || (member.sharedFieldIds?.length && format.fields.some((field) => !member.sharedFieldIds!.includes(field.id)))) {
        throw new BadRequestException('Assign to the owner or an editor with access to this data format');
      }
    }
    const dueAt = input.dueAt ? new Date(input.dueAt) : undefined;
    if (input.dueAt && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(input.dueAt) || !Number.isFinite(dueAt!.getTime()))) throw new BadRequestException('Choose a valid due date and time');
    const reminderMinutesBefore = input.reminderMinutesBefore ?? 60;
    if (!Number.isInteger(reminderMinutesBefore) || reminderMinutesBefore < 0 || reminderMinutesBefore > 43200) throw new BadRequestException('Choose a reminder advance between 0 and 43200 minutes');
    const event: WorkflowEvent = { kind: 'ASSIGNMENT', from, to: from, actorUserId, at: new Date(), assigneeUserId, dueAt };
    const updated = await this.entries.findOneAndUpdate(
      { _id: entryId, ownerId: collection.ownerId, updatedAt: entry.updatedAt },
      { $set: { 'workflow.assigneeUserId': assigneeUserId, 'workflow.dueAt': dueAt, 'workflow.reminderMinutesBefore': reminderMinutesBefore }, $push: { 'workflow.history': event } },
      { new: true, runValidators: true },
    ).exec();
    if (!updated) throw new BadRequestException('This entry changed elsewhere. Refresh and try again');
    if (assigneeUserId && assigneeUserId !== entry.workflow?.assigneeUserId) {
      await this.notifications.create({ recipientUserId: assigneeUserId, collectionId: collection.id, entryId, kind: 'ASSIGNMENT', actorUserId, createdAt: new Date() });
      try { await this.reminders.scheduleWorkflow(updated, assigneeUserId, undefined, 0, 'ASSIGNMENT'); }
      catch (error) { this.logger.warn(`Assignment delivery will need retry: ${error instanceof Error ? error.message : 'Unknown error'}`); }
    }
    try { await this.reminders.scheduleWorkflow(updated, assigneeUserId, dueAt, reminderMinutesBefore); }
    catch (error) { this.logger.warn(`Due reminder could not be scheduled: ${error instanceof Error ? error.message : 'Unknown error'}`); }
    await this.collaboration.logAction(collection.id, actorUserId, 'ASSIGN_WORKFLOW', `Assigned entry in ${format.name}`);
    return updated;
  }

  async notificationsFor(userId: string): Promise<WorkflowNotification[]> {
    const notifications = await this.notifications.find({ recipientUserId: userId }).sort({ createdAt: -1 }).limit(50).exec();
    const ids = [...new Set(notifications.map((item) => item.collectionId))];
    const collections = await this.collections.find({ _id: { $in: ids }, $or: [{ ownerId: userId }, { 'members.userId': userId }] }).select('_id').lean().exec();
    const allowed = new Set(collections.map((item) => item._id.toString()));
    return notifications.filter((item) => allowed.has(item.collectionId));
  }

  async readNotification(id: string, userId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Notification not found');
    return (await this.notifications.updateOne({ _id: id, recipientUserId: userId, readAt: null }, { $set: { readAt: new Date() } }).exec()).modifiedCount > 0;
  }
}
