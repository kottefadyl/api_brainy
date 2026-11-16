import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Collection, FieldKind } from './collection.schema.js';
import { CollectionRole } from './collaboration.schema.js';
import { CollaborationService } from './collaboration.service.js';
import { Entry } from './entry.schema.js';
import { EntryLink } from './entry-link.schema.js';

@Injectable()
export class EntryLinkService {
  constructor(@InjectModel(Collection.name) private readonly collections: Model<Collection>, @InjectModel(Entry.name) private readonly entries: Model<Entry>, @InjectModel(EntryLink.name) private readonly links: Model<EntryLink>, private readonly collaboration: CollaborationService) {}

  /** The collection as seen by `userId` (owner or member with at least `role`); links and entries are stored under the owner. */
  private async access(collectionId: string, userId: string, role: CollectionRole): Promise<{ collection: Collection; ownerId: string; member?: ReturnType<CollaborationService['checkAccess']>['member'] }> {
    if (!Types.ObjectId.isValid(collectionId)) throw new NotFoundException('Collection not found');
    const collection = await this.collections.findOne({ _id: collectionId, $or: [{ ownerId: userId }, { 'members.userId': userId }] }).exec();
    if (!collection) throw new NotFoundException('Collection not found');
    const { member } = this.collaboration.checkAccess(collection, userId, role);
    return { collection, ownerId: collection.ownerId, member };
  }

  private async context(collectionId: string, userId: string, fromEntryId: string, toEntryId?: string, role = CollectionRole.READER): Promise<string> {
    if (![collectionId, fromEntryId, ...(toEntryId ? [toEntryId] : [])].every((value) => Types.ObjectId.isValid(value))) throw new NotFoundException('Entry not found');
    const { ownerId } = await this.access(collectionId, userId, role);
    const ids = [fromEntryId, ...(toEntryId ? [toEntryId] : [])];
    if (await this.entries.countDocuments({ _id: { $in: ids }, collectionId, ownerId, movingOperationId: null }) !== ids.length) throw new NotFoundException('Entry not found');
    return ownerId;
  }

  async list(collectionId: string, userId: string, entryId: string, includeDeleted = false): Promise<EntryLink[]> {
    const ownerId = await this.context(collectionId, userId, entryId);
    return this.links.find({ collectionId, ownerId, $or: [{ fromEntryId: entryId }, { toEntryId: entryId }], ...(!includeDeleted ? { deletedAt: null } : {}) }).sort({ createdAt: -1 }).exec();
  }

  async create(collectionId: string, userId: string, fromEntryId: string, toEntryId: string, label = ''): Promise<EntryLink> {
    if (fromEntryId === toEntryId) throw new BadRequestException('Choose another entry');
    const ownerId = await this.context(collectionId, userId, fromEntryId, toEntryId, CollectionRole.EDITOR);
    if (label.length > 120) throw new BadRequestException('Link label is too long');
    const existing = await this.links.findOne({ ownerId, collectionId, fromEntryId, toEntryId }).exec();
    if (existing) {
      if (!existing.deletedAt) return existing;
      const restored = await this.links.findOneAndUpdate({ _id: existing.id, ownerId }, { $set: { label }, $unset: { deletedAt: '' } }, { returnDocument: 'after' }).exec();
      return restored!;
    }
    return this.links.create({ ownerId, collectionId, fromEntryId, toEntryId, label, createdAt: new Date() });
  }

  async change(collectionId: string, userId: string, linkId: string, restore: boolean): Promise<EntryLink> {
    if (!Types.ObjectId.isValid(linkId)) throw new NotFoundException('Link not found');
    const { ownerId } = await this.access(collectionId, userId, CollectionRole.EDITOR);
    const link = await this.links.findOne({ _id: linkId, ownerId, collectionId }).exec();
    if (!link) throw new NotFoundException('Link not found');
    if (restore) await this.context(collectionId, userId, link.fromEntryId, link.toEntryId, CollectionRole.EDITOR);
    const updated = await this.links.findOneAndUpdate({ _id: linkId, ownerId, collectionId }, restore ? { $unset: { deletedAt: '' } } : { $set: { deletedAt: new Date() } }, { returnDocument: 'after' }).exec();
    return updated!;
  }

  async detachDeletedEntry(entryId: string, ownerId: string): Promise<void> {
    await this.links.updateMany({ ownerId, $or: [{ fromEntryId: entryId }, { toEntryId: entryId }], deletedAt: null }, { $set: { deletedAt: new Date() } }).exec();
  }

  async purgeContributionEntry(entryId: string, ownerId: string): Promise<void> {
    await this.links.deleteMany({ ownerId, $or: [{ fromEntryId: entryId }, { toEntryId: entryId }] }).exec();
  }

  async importLinks(collectionId: string, ownerId: string, importKey: string, links: { fromSourceId: string; toSourceId: string; label: string }[]): Promise<boolean> {
    if (!importKey || importKey.length > 100 || !/^[\w.-]+$/.test(importKey) || links.length > 100) throw new BadRequestException('Invalid import batch');
    if (!links.length) return true;
    await this.context(collectionId, ownerId, (await this.entries.findOne({ ownerId, collectionId, importKey }).select('_id').exec())?.id ?? '');
    const sourceIds = [...new Set(links.flatMap((link) => [link.fromSourceId, link.toSourceId]))];
    if (links.some((link) => !link.fromSourceId || !link.toSourceId || link.fromSourceId === link.toSourceId || link.label.length > 120)) throw new BadRequestException('Invalid entry link');
    const imported = await this.entries.find({ ownerId, collectionId, importKey, sourceId: { $in: sourceIds } }).select('_id sourceId').exec();
    const bySource = new Map(imported.map((entry) => [entry.sourceId, entry.id]));
    if (bySource.size !== sourceIds.length) throw new BadRequestException('A linked entry was not imported');
    for (const link of links) await this.create(collectionId, ownerId, bySource.get(link.fromSourceId)!, bySource.get(link.toSourceId)!, link.label);
    return true;
  }

  /** Works for the owner and for any member: a collaborator adding an entry must be warned of duplicates too. */
  async duplicateLinks(collectionId: string, userId: string, formatId: string, fieldId: string, url: string, excludeEntryId?: string): Promise<Entry[]> {
    if (url.length > 10000) throw new BadRequestException('URL is too long');
    let normalized: string;
    try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); normalized = parsed.href; }
    catch { throw new BadRequestException('Enter a valid web link'); }
    const { collection, ownerId, member } = await this.access(collectionId, userId, CollectionRole.READER);
    if (member?.sharedFieldIds?.length && !member.sharedFieldIds.includes(fieldId)) return [];
    if (!collection.formats.some((format) => format.id === formatId && format.fields.some((field) => field.id === fieldId && field.kind === FieldKind.LINK))) throw new NotFoundException('Link field not found');
    const candidates = await this.entries.find({ ownerId, collectionId, formatId, 'values.fieldId': fieldId, ...(excludeEntryId ? { _id: { $ne: excludeEntryId } } : {}) }).limit(1001).exec();
    if (candidates.length > 1000) throw new BadRequestException('Narrow the link search');
    const matches = candidates.filter((entry) => entry.values.some((value) => { if (value.fieldId !== fieldId) return false; try { return new URL(value.value).href === normalized; } catch { return false; } }));
    return member ? matches.map((entry) => this.collaboration.filterEntryFields(entry, member, collection)) : matches;
  }
}
