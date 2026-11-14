import { Args, Context, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service.js';
import { CollectionExchangeRateInput, CollectionFormatInput, CollectionUnitInput, CreateCollectionInput, EntryFieldFilterInput, EntryRecurrenceInput, ImportEntriesInput, ImportObjectLinkInput, SavedCollectionViewInput, SaveEntryInput, UpdateCollectionFormatInput } from './collection.input.js';
import { Collection, CollectionFormatImpact, FormatEntryCount, LinkedFormatUpdatePreview, MoveOperationStatus, ObjectModelTemplate, SharedObjectGrant, TransferPreview, TransferResult } from './collection.schema.js';
import { CollectionsService } from './collections.service.js';
import { CalendarOccurrence, Entry, EntryAttachment, EntryPage, ImportEntriesResult, ResolvedObjectReference, ResolvedObjectVariable } from './entry.schema.js';
import { CollectionUnit, QuantityConversion } from './unit.schema.js';
import { TransferService } from './transfer.service.js';
import { ReminderService } from './reminder.service.js';
import { EntryLinkService } from './entry-link.service.js';
import { AuditLog, CollectionRole } from './collaboration.schema.js';
import { CollaborationService } from './collaboration.service.js';
import { RelationService } from './relation.service.js';

type Request = { headers: { authorization?: string } };

@Resolver(() => Collection)
export class CollectionsResolver {
  constructor(
    private readonly service: CollectionsService,
    private readonly auth: AuthService,
    private readonly transfers: TransferService,
    private readonly reminders: ReminderService,
    private readonly links: EntryLinkService,
    private readonly collaboration: CollaborationService,
    private readonly relations: RelationService,
  ) {}

  private async ownerId(request: Request): Promise<string> {
    return (await this.auth.currentUser(request.headers.authorization)).id;
  }

  @Query(() => [Collection], { description: 'My collections; with ids, only those (a live update reloads just what changed)' })
  async collectionsList(@Args('ids', { type: () => [String], nullable: true }) ids: string[] | undefined, @Context('req') request: Request): Promise<Collection[]> {
    const actorId = await this.ownerId(request);
    const collections = await this.service.list(actorId, ids);
    return Promise.all(collections.map((collection) => this.collaboration.projectCollection(collection, actorId)));
  }

  @Mutation(() => Collection)
  async saveCollectionView(@Args('collectionId') collectionId: string, @Args('input') input: SavedCollectionViewInput, @Args('viewId', { type: () => String, nullable: true }) viewId: string | undefined, @Context('req') request: Request): Promise<Collection> {
    return this.service.saveView(collectionId, await this.ownerId(request), input, viewId);
  }

  @Mutation(() => Collection)
  async deleteCollectionView(@Args('collectionId') collectionId: string, @Args('viewId') viewId: string, @Context('req') request: Request): Promise<Collection> {
    return this.service.deleteView(collectionId, await this.ownerId(request), viewId);
  }

  @Mutation(() => Entry)
  async setCollectionTaskCompleted(@Args('collectionId') collectionId: string, @Args('viewId') viewId: string, @Args('entryId') entryId: string, @Args('done') done: boolean, @Context('req') request: Request): Promise<Entry> {
    const ownerId = await this.ownerId(request);
    const entry = await this.service.setTaskCompletion(collectionId, ownerId, viewId, entryId, done);
    if (done) await this.reminders.cancelEntry(entryId, ownerId);
    return entry;
  }

  @Mutation(() => Entry)
  async setCollectionEntryRecurrence(@Args('collectionId') collectionId: string, @Args('viewId') viewId: string, @Args('entryId') entryId: string, @Args('input', { type: () => EntryRecurrenceInput, nullable: true }) input: EntryRecurrenceInput | undefined, @Context('req') request: Request): Promise<Entry> {
    const ownerId = await this.ownerId(request);
    const entry = await this.service.setEntryRecurrence(collectionId, ownerId, viewId, entryId, input);
    await this.reminders.refreshEntry(entryId, ownerId);
    return entry;
  }

  @Query(() => [CalendarOccurrence])
  async collectionCalendarOccurrences(@Args('collectionId') collectionId: string, @Args('viewId') viewId: string, @Args('from') from: string, @Args('to') to: string, @Context('req') request: Request): Promise<CalendarOccurrence[]> {
    return this.service.calendarOccurrences(collectionId, await this.ownerId(request), viewId, from, to);
  }

  @Mutation(() => Collection)
  async createCollection(@Args('input') input: CreateCollectionInput, @Context('req') request: Request): Promise<Collection> {
    return this.service.create(input, await this.ownerId(request));
  }

  @Mutation(() => Collection)
  async addCollectionFormat(
    @Args('collectionId') collectionId: string,
    @Args('input') input: CollectionFormatInput,
    @Context('req') request: Request,
  ): Promise<Collection> {
    return this.service.addFormat(collectionId, input, await this.ownerId(request));
  }

  @Query(() => [ObjectModelTemplate])
  objectModelTemplates(@Args('language', { type: () => String, nullable: true }) language?: string): ObjectModelTemplate[] { return this.service.objectModelTemplates(language); }

  @Mutation(() => Collection)
  async addObjectModelFromTemplate(@Args('collectionId') collectionId: string, @Args('templateId') templateId: string, @Args('name') name: string, @Args('color') color: string, @Args('language', { type: () => String, nullable: true }) language: string | undefined, @Context('req') request: Request): Promise<Collection> {
    return this.service.addObjectModelFromTemplate(collectionId, templateId, name, color, await this.ownerId(request), language);
  }

  @Mutation(() => Collection)
  async setCollectionFormatObjectModel(@Args('collectionId') collectionId: string, @Args('formatId') formatId: string, @Args('enabled') enabled: boolean, @Args('expectedVersion', { type: () => Int }) expectedVersion: number, @Args('expectedEntryCount', { type: () => Int, nullable: true }) expectedEntryCount: number | undefined, @Context('req') request: Request): Promise<Collection> {
    return this.service.setObjectModel(collectionId, formatId, enabled, expectedVersion, await this.ownerId(request), expectedEntryCount);
  }

  @Query(() => [CollectionUnit])
  async collectionAvailableUnits(@Args('collectionId') collectionId: string, @Context('req') request: Request): Promise<CollectionUnit[]> {
    return this.service.availableUnits(collectionId, await this.ownerId(request));
  }

  @Mutation(() => Collection)
  async saveCollectionUnit(
    @Args('collectionId') collectionId: string,
    @Args('input') input: CollectionUnitInput,
    @Args('unitId', { type: () => String, nullable: true }) unitId: string | undefined,
    @Context('req') request: Request,
  ): Promise<Collection> {
    return this.service.saveUnit(collectionId, input, await this.ownerId(request), unitId);
  }

  @Mutation(() => Collection)
  async recordCollectionExchangeRate(@Args('collectionId') collectionId: string, @Args('input') input: CollectionExchangeRateInput, @Context('req') request: Request): Promise<Collection> {
    return this.service.recordExchangeRate(collectionId, input, await this.ownerId(request));
  }

  @Query(() => QuantityConversion)
  async collectionQuantityConversion(
    @Args('collectionId') collectionId: string,
    @Args('amount') amount: string,
    @Args('from') from: string,
    @Args('to') to: string,
    @Args('asOf', { type: () => String, nullable: true }) asOf: string | undefined,
    @Context('req') request: Request,
  ): Promise<QuantityConversion> {
    return this.service.convertQuantity(collectionId, amount, from, to, await this.ownerId(request), asOf);
  }

  @Mutation(() => Collection)
  async setCollectionFormatColor(
    @Args('collectionId') collectionId: string,
    @Args('formatId') formatId: string,
    @Args('color') color: string,
    @Context('req') request: Request,
  ): Promise<Collection> {
    return this.service.setFormatColor(collectionId, formatId, color, await this.ownerId(request));
  }

  @Query(() => [FormatEntryCount], { description: 'Entries per data format, counted over all pages' })
  async formatEntryCounts(@Args('collectionId') collectionId: string, @Context('req') request: Request): Promise<FormatEntryCount[]> {
    return this.service.formatEntryCounts(collectionId, await this.ownerId(request));
  }

  @Query(() => CollectionFormatImpact)
  async collectionFormatImpact(
    @Args('collectionId') collectionId: string,
    @Args('formatId') formatId: string,
    @Context('req') request: Request,
  ): Promise<CollectionFormatImpact> {
    return this.service.formatImpact(collectionId, formatId, await this.ownerId(request));
  }

  @Mutation(() => Collection)
  async updateCollectionFormat(
    @Args('collectionId') collectionId: string,
    @Args('formatId') formatId: string,
    @Args('input') input: UpdateCollectionFormatInput,
    @Context('req') request: Request,
  ): Promise<Collection> {
    return this.service.updateFormat(collectionId, formatId, input, await this.ownerId(request));
  }

  @Mutation(() => Collection)
  async renameCollection(@Args('id') id: string, @Args('name') name: string, @Context('req') request: Request): Promise<Collection> {
    return this.service.rename(id, name, await this.ownerId(request));
  }

  @Mutation(() => Boolean)
  async deleteCollection(@Args('id') id: string, @Context('req') request: Request): Promise<boolean> {
    const ownerId = await this.ownerId(request);
    const removed = await this.service.remove(id, ownerId);
    if (removed) await this.reminders.cancelCollection(id, ownerId);
    if (removed) await this.relations.purgeCollection(id);
    return removed;
  }

  @Query(() => [Entry])
  async collectionEntries(@Args('collectionId') collectionId: string, @Context('req') request: Request): Promise<Entry[]> {
    return this.service.listEntries(collectionId, await this.ownerId(request));
  }

  @Query(() => Entry)
  async collectionEntry(@Args('collectionId') collectionId: string, @Args('entryId') entryId: string, @Context('req') request: Request): Promise<Entry> {
    return this.service.entryDetail(collectionId, entryId, await this.ownerId(request));
  }

  @Query(() => EntryPage)
  async collectionEntriesPage(
    @Args('collectionId') collectionId: string,
    @Args('first', { type: () => Int, defaultValue: 30 }) first: number,
    @Args('after', { type: () => String, nullable: true }) after: string | undefined,
    @Args('search', { type: () => String, nullable: true }) search: string | undefined,
    @Args('formatId', { type: () => String, nullable: true }) formatId: string | undefined,
    @Args('filters', { type: () => [EntryFieldFilterInput], nullable: true }) filters: EntryFieldFilterInput[] | undefined,
    @Args('viewId', { type: () => String, nullable: true }) viewId: string | undefined,
    @Context('req') request: Request,
    @Args('offset', { type: () => Int, nullable: true, description: 'Jump to this position (a page number times the page size) instead of following a cursor' }) offset?: number,
    @Args('atDate', { type: () => String, nullable: true, description: 'YYYY-MM-DD: jump to the page holding the entries created that day (or the nearest one)' }) atDate?: string,
    @Args('timeZone', { type: () => String, nullable: true }) timeZone?: string,
  ): Promise<EntryPage> {
    return this.service.entriesPage(collectionId, await this.ownerId(request), { first, after, search, formatId, filters, viewId, offset, atDate, timeZone });
  }

  @Query(() => EntryPage)
  async collectionObjectsPage(
    @Args('collectionId') collectionId: string,
    @Args('formatId') formatId: string,
    @Args('first', { type: () => Int, defaultValue: 30 }) first: number,
    @Args('after', { type: () => String, nullable: true }) after: string | undefined,
    @Args('search', { type: () => String, nullable: true }) search: string | undefined,
    @Context('req') request: Request,
  ): Promise<EntryPage> { return this.service.objectsPage(collectionId, formatId, await this.ownerId(request), first, after, search); }

  @Query(() => Entry)
  async collectionObject(@Args('id') id: string, @Context('req') request: Request): Promise<Entry> { return this.service.objectDetail(id, await this.ownerId(request)); }

  @Query(() => [ResolvedObjectReference])
  async entryObjectReferences(@Args('entryId') entryId: string, @Context('req') request: Request): Promise<ResolvedObjectReference[]> {
    return this.service.entryObjectReferences(entryId, await this.ownerId(request));
  }

  @Query(() => ResolvedObjectVariable)
  async objectVariableProperty(@Args('entryId') entryId: string, @Args('variableName') variableName: string, @Args('propertyFieldId') propertyFieldId: string, @Args('objectId', { type: () => String, nullable: true }) objectId: string | undefined, @Context('req') request: Request): Promise<ResolvedObjectVariable> {
    return this.service.resolveObjectVariable(entryId, variableName, propertyFieldId, await this.ownerId(request), objectId);
  }

  @Query(() => TransferPreview)
  async objectCopyPreview(@Args('objectId') objectId: string, @Args('targetCollectionId') targetCollectionId: string, @Context('req') request: Request): Promise<TransferPreview> {
    return this.transfers.objectPreview(objectId, targetCollectionId, await this.ownerId(request));
  }

  @Mutation(() => TransferResult)
  async copyCollectionObject(@Args('objectId') objectId: string, @Args('targetCollectionId') targetCollectionId: string, @Context('req') request: Request): Promise<TransferResult> {
    return this.transfers.copyObject(objectId, targetCollectionId, await this.ownerId(request));
  }

  @Mutation(() => SharedObjectGrant)
  async shareCollectionObject(@Args('objectId') objectId: string, @Args('targetCollectionId') targetCollectionId: string, @Args('propertyFieldIds', { type: () => [String] }) propertyFieldIds: string[], @Args('mode') mode: string, @Args('includeSensitive', { type: () => Boolean, nullable: true }) includeSensitive: boolean | undefined, @Context('req') request: Request): Promise<SharedObjectGrant> {
    return this.transfers.shareObject(objectId, targetCollectionId, propertyFieldIds, mode, await this.ownerId(request), includeSensitive === true);
  }

  @Mutation(() => Boolean)
  async revokeCollectionObjectShare(@Args('targetCollectionId') targetCollectionId: string, @Args('grantId') grantId: string, @Context('req') request: Request): Promise<boolean> {
    return this.transfers.revokeObjectShare(targetCollectionId, grantId, await this.ownerId(request));
  }

  @Query(() => TransferPreview)
  async objectMovePreview(@Args('objectId') objectId: string, @Args('targetCollectionId') targetCollectionId: string, @Context('req') request: Request): Promise<TransferPreview> {
    return this.transfers.movePreview(objectId, targetCollectionId, await this.ownerId(request));
  }

  @Mutation(() => TransferResult)
  async moveCollectionObject(@Args('objectId') objectId: string, @Args('targetCollectionId') targetCollectionId: string, @Context('req') request: Request): Promise<TransferResult> {
    return this.transfers.moveObject(objectId, targetCollectionId, await this.ownerId(request));
  }

  @Query(() => MoveOperationStatus)
  async collectionMoveStatus(@Args('operationId') operationId: string, @Context('req') request: Request): Promise<MoveOperationStatus> {
    return this.transfers.moveStatus(operationId, await this.ownerId(request));
  }

  @Mutation(() => MoveOperationStatus)
  async recoverCollectionMove(@Args('operationId') operationId: string, @Context('req') request: Request): Promise<MoveOperationStatus> {
    return this.transfers.recoverStaleMove(operationId, await this.ownerId(request));
  }

  @Query(() => TransferPreview)
  async dataFormatCopyPreview(@Args('formatId') formatId: string, @Args('targetCollectionId') targetCollectionId: string, @Args('withEntries', { defaultValue: false }) withEntries: boolean, @Context('req') request: Request): Promise<TransferPreview> {
    return this.transfers.formatPreview(formatId, targetCollectionId, withEntries, await this.ownerId(request));
  }

  @Mutation(() => TransferResult)
  async copyCollectionDataFormat(@Args('formatId') formatId: string, @Args('targetCollectionId') targetCollectionId: string, @Args('withEntries', { defaultValue: false }) withEntries: boolean, @Context('req') request: Request): Promise<TransferResult> {
    return this.transfers.copyFormat(formatId, targetCollectionId, withEntries, await this.ownerId(request));
  }

  @Mutation(() => TransferResult)
  async linkCollectionDataFormat(@Args('formatId') formatId: string, @Args('targetCollectionId') targetCollectionId: string, @Context('req') request: Request): Promise<TransferResult> {
    return this.transfers.linkFormat(formatId, targetCollectionId, await this.ownerId(request));
  }

  @Query(() => LinkedFormatUpdatePreview)
  async linkedDataFormatUpdatePreview(@Args('targetCollectionId') targetCollectionId: string, @Args('targetFormatId') targetFormatId: string, @Context('req') request: Request): Promise<LinkedFormatUpdatePreview> {
    return this.transfers.linkedFormatUpdatePreview(targetCollectionId, targetFormatId, await this.ownerId(request));
  }

  @Mutation(() => Collection)
  async acceptLinkedDataFormatVersion(@Args('targetCollectionId') targetCollectionId: string, @Args('targetFormatId') targetFormatId: string, @Args('expectedSourceVersion', { type: () => Int }) expectedSourceVersion: number, @Context('req') request: Request): Promise<Collection> {
    return this.transfers.acceptLinkedFormat(targetCollectionId, targetFormatId, expectedSourceVersion, await this.ownerId(request));
  }

  @Mutation(() => Collection)
  async detachLinkedDataFormat(@Args('targetCollectionId') targetCollectionId: string, @Args('targetFormatId') targetFormatId: string, @Context('req') request: Request): Promise<Collection> {
    return this.transfers.detachLinkedFormat(targetCollectionId, targetFormatId, await this.ownerId(request));
  }

  @Mutation(() => Entry)
  async duplicateCollectionObject(@Args('id') id: string, @Context('req') request: Request): Promise<Entry> { return this.service.duplicateObject(id, await this.ownerId(request)); }

  @Mutation(() => Entry)
  async useCollectionObject(@Args('objectId') objectId: string, @Args('targetFormatId') targetFormatId: string, @Args('targetFieldId') targetFieldId: string, @Context('req') request: Request): Promise<Entry> {
    return this.service.useObjectInEntry(objectId, targetFormatId, targetFieldId, await this.ownerId(request));
  }

  @Mutation(() => ImportEntriesResult)
  async importEntriesBatch(
    @Args('collectionId') collectionId: string,
    @Args('input') input: ImportEntriesInput,
    @Context('req') request: Request,
  ): Promise<ImportEntriesResult> {
    return this.service.importEntriesBatch(collectionId, input, await this.ownerId(request));
  }

  @Mutation(() => Boolean)
  async linkImportedObjects(
    @Args('collectionId') collectionId: string,
    @Args('importKey') importKey: string,
    @Args('links', { type: () => [ImportObjectLinkInput] }) links: ImportObjectLinkInput[],
    @Context('req') request: Request,
  ): Promise<boolean> {
    return this.service.linkImportedObjects(collectionId, importKey, links, await this.ownerId(request));
  }

  @Query(() => EntryAttachment)
  async entryAttachment(
    @Args('entryId') entryId: string,
    @Args('fieldId') fieldId: string,
    @Context('req') request: Request,
  ): Promise<EntryAttachment> {
    return this.service.entryAttachment(entryId, fieldId, await this.ownerId(request));
  }

  @Query(() => Entry)
  async collectionEntryAsOfDate(
    @Args('entryId') entryId: string,
    @Args('asOfDate') asOfDate: string,
    @Context('req') request: Request,
  ): Promise<Entry> {
    return this.service.entryAsOfDate(entryId, asOfDate, await this.ownerId(request));
  }

  @Mutation(() => Entry)
  async createEntry(
    @Args('collectionId') collectionId: string, @Args('input') input: SaveEntryInput,
    @Context('req') request: Request,
  ): Promise<Entry> {
    return this.service.createEntry(collectionId, input.values, input.formatId, await this.ownerId(request), input.clientMutationId);
  }

  @Mutation(() => Entry)
  async updateEntry(@Args('id') id: string, @Args('input') input: SaveEntryInput, @Context('req') request: Request): Promise<Entry> {
    const ownerId = await this.ownerId(request);
    const entry = await this.service.updateEntry(id, input.values, input.formatId, ownerId, input.clientMutationId, input.expectedUpdatedAt);
    await this.reminders.refreshEntry(id, ownerId);
    return entry;
  }

  @Mutation(() => Boolean)
  async deleteEntry(@Args('id') id: string, @Context('req') request: Request): Promise<boolean> {
    const ownerId = await this.ownerId(request);
    const removed = await this.relations.deleteEntry(id, ownerId, () => this.service.removeEntry(id, ownerId));
    if (removed) await this.reminders.cancelEntry(id, ownerId);
    if (removed) await this.links.detachDeletedEntry(id, ownerId);
    return removed;
  }

  @Mutation(() => Collection)
  async addCollectionMember(
    @Args('collectionId') collectionId: string,
    @Args('email', { type: () => String, nullable: true }) email: string | undefined,
    @Args('role', { type: () => CollectionRole }) role: CollectionRole,
    @Args('sharedFieldIds', { type: () => [String], nullable: true }) sharedFieldIds: string[] | undefined,
    @Args('sensitiveFieldIds', { type: () => [String], nullable: true }) sensitiveFieldIds: string[] | undefined,
    @Context('req') request: Request,
    @Args('memberUserId', { type: () => String, nullable: true }) memberUserId?: string,
  ): Promise<Collection> {
    return this.collaboration.addOrUpdateMember(collectionId, { email, userId: memberUserId }, role, sharedFieldIds, sensitiveFieldIds, await this.ownerId(request));
  }

  @Mutation(() => Collection)
  async removeCollectionMember(
    @Args('collectionId') collectionId: string,
    @Args('memberUserId') memberUserId: string,
    @Context('req') request: Request,
  ): Promise<Collection> {
    return this.collaboration.removeMember(collectionId, memberUserId, await this.ownerId(request));
  }

  @Query(() => [AuditLog])
  async collectionAuditLogs(
    @Args('collectionId') collectionId: string,
    @Context('req') request: Request,
  ): Promise<AuditLog[]> {
    return this.collaboration.getAuditLogs(collectionId, await this.ownerId(request));
  }
}
