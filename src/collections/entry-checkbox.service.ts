// One-click yes/no: checks or unchecks a checkbox field of an entry from the entry list, without resending the other values.
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CollectionRole } from './collaboration.schema.js';
import { CollaborationService } from './collaboration.service.js';
import { FieldKind } from './collection.schema.js';
import { CollectionsService } from './collections.service.js';
import { Entry, EntryValue } from './entry.schema.js';
import { protectedFields } from './sensitivity.logic.js';
import { StockMovement } from './stock.schema.js';
import { assertWorkflowEdit } from './workflow.rules.js';

@Injectable()
export class EntryCheckboxService {
  constructor(
    @InjectModel(Entry.name) private readonly entries: Model<Entry>,
    @InjectModel(StockMovement.name) private readonly stockMovements: Model<StockMovement>,
    private readonly collectionsService: CollectionsService,
    private readonly collaboration: CollaborationService,
  ) {}

  async set(entryId: string, fieldId: string, checked: boolean, userId: string, expectedUpdatedAt?: string): Promise<Entry> {
    if (!Types.ObjectId.isValid(entryId)) throw new NotFoundException('Entry not found');
    const entry = await this.entries.findOne({ _id: entryId }).exec();
    if (!entry) throw new NotFoundException('Entry not found');
    const collection = await this.collectionsService.one(entry.collectionId, userId);
    const { member } = this.collaboration.checkAccess(collection, userId, CollectionRole.EDITOR);
    const format = collection.formats.find((item) => item.id === (entry.formatId ?? collection.formats[0]?.id));
    const field = format?.fields.find((item) => item.id === fieldId);
    if (!format || !field || field.kind !== FieldKind.BOOLEAN) throw new BadRequestException('Checkbox field not found');
    // A collaborator only changes the fields shared with them.
    if (member && ((member.sharedFieldIds?.length && !member.sharedFieldIds.includes(fieldId)) || (protectedFields(format).has(fieldId) && !member.sensitiveFieldIds?.includes(fieldId)))) throw new BadRequestException('Checkbox field not found');
    if (entry.ledgerHash || format.appendOnly) throw new BadRequestException('A register writing cannot be edited. Add a linked correction');
    if (entry.movingOperationId) throw new BadRequestException('This object is being moved. Try again after the transfer finishes');
    if (expectedUpdatedAt && (!Number.isFinite(Date.parse(expectedUpdatedAt)) || entry.updatedAt.getTime() !== Date.parse(expectedUpdatedAt))) throw new BadRequestException('This entry changed elsewhere. Review the conflict before syncing');
    if (await this.stockMovements.exists({ collectionId: collection.id, sourceEntryId: entryId })) throw new BadRequestException('This entry has a validated stock effect. Add a correction or return instead of editing it');
    const value = checked ? 'true' : 'false';
    const before = (entry.toObject().values ?? []) as EntryValue[];
    if (before.find((item) => item.fieldId === fieldId)?.value === value) return this.collaboration.filterEntryFields(entry, member, collection);
    const after: EntryValue[] = before.some((item) => item.fieldId === fieldId)
      ? before.map((item) => item.fieldId === fieldId ? { ...item, value, booleanValue: checked } : item)
      : [...before, { fieldId, value, booleanValue: checked } as EntryValue];
    assertWorkflowEdit(format, before, after);
    const saved = await this.entries.findOneAndUpdate(
      { _id: entryId, updatedAt: entry.updatedAt, movingOperationId: null },
      { $set: { values: after, updatedBy: userId }, $push: { revisions: { $each: [{ at: entry.updatedAt, formatVersion: entry.formatVersion ?? 1, values: before }], $slice: -20 } } },
      { returnDocument: 'after', runValidators: true },
    ).exec();
    if (!saved) throw new BadRequestException('This entry changed elsewhere. Review the conflict before syncing');
    await this.collaboration.logAction(collection.id, userId, 'UPDATE_ENTRY', `Set ${field.name} to ${checked ? 'yes' : 'no'} in format ${format.name}`);
    return this.collaboration.filterEntryFields(saved, member, collection);
  }
}
