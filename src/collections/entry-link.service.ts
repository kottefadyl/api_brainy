import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Collection, FieldKind } from './collection.schema';
import { Entry } from './entry.schema';
import { EntryLink } from './entry-link.schema';

@Injectable()
export class EntryLinkService {
  constructor(@InjectModel(Collection.name) private readonly collections: Model<Collection>, @InjectModel(Entry.name) private readonly entries: Model<Entry>, @InjectModel(EntryLink.name) private readonly links: Model<EntryLink>) {}

  private async context(collectionId: string, ownerId: string, fromEntryId: string, toEntryId?: string): Promise<void> {
    if (![collectionId, fromEntryId, ...(toEntryId ? [toEntryId] : [])].every((value) => Types.ObjectId.isValid(value))) throw new NotFoundException('Entry not found');
    if (!await this.collections.exists({ _id: collectionId, ownerId })) throw new NotFoundException('Collection not found');
    const ids = [fromEntryId, ...(toEntryId ? [toEntryId] : [])];
    if (await this.entries.countDocuments({ _id: { $in: ids }, collectionId, ownerId, movingOperationId: null }) !== ids.length) throw new NotFoundException('Entry not found');
  }

  async list(collectionId: string, ownerId: string, entryId: string, includeDeleted = false): Promise<EntryLink[]> {
    await this.context(collectionId, ownerId, entryId);
    return this.links.find({ collectionId, ownerId, $or: [{ fromEntryId: entryId }, { toEntryId: entryId }], ...(!includeDeleted ? { deletedAt: null } : {}) }).sort({ createdAt: -1 }).exec();
  }

  async create(collectionId: string, ownerId: string, fromEntryId: string, toEntryId: string, label = ''): Promise<EntryLink> {
    if (fromEntryId === toEntryId) throw new BadRequestException('Choose another entry');
    await this.context(collectionId, ownerId, fromEntryId, toEntryId);
    if (label.length > 120) throw new BadRequestException('Link label is too long');
    const existing = await this.links.findOne({ ownerId, collectionId, fromEntryId, toEntryId }).exec();
    if (existing) {
      if (!existing.deletedAt) return existing;
      const restored = await this.links.findOneAndUpdate({ _id: existing.id, ownerId }, { $set: { label }, $unset: { deletedAt: '' } }, { new: true }).exec();
      return restored!;
    }
    return this.links.create({ ownerId, collectionId, fromEntryId, toEntryId, label, createdAt: new Date() });
  }

  async change(collectionId: string, ownerId: string, linkId: string, restore: boolean): Promise<EntryLink> {
    if (!Types.ObjectId.isValid(linkId)) throw new NotFoundException('Link not found');
    const link = await this.links.findOne({ _id: linkId, ownerId, collectionId }).exec();
    if (!link) throw new NotFoundException('Link not found');
    if (restore) await this.context(collectionId, ownerId, link.fromEntryId, link.toEntryId);
    const updated = await this.links.findOneAndUpdate({ _id: linkId, ownerId, collectionId }, restore ? { $unset: { deletedAt: '' } } : { $set: { deletedAt: new Date() } }, { new: true }).exec();
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

  async duplicateLinks(collectionId: string, ownerId: string, formatId: string, fieldId: string, url: string, excludeEntryId?: string): Promise<Entry[]> {
    if (url.length > 10000) throw new BadRequestException('URL is too long');
    let normalized: string;
    try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); normalized = parsed.href; }
    catch { throw new BadRequestException('Enter a valid web link'); }
    const collection = await this.collections.findOne({ _id: collectionId, ownerId }).exec();
    if (!collection?.formats.some((format) => format.id === formatId && format.fields.some((field) => field.id === fieldId && field.kind === FieldKind.LINK))) throw new NotFoundException('Link field not found');
    const candidates = await this.entries.find({ ownerId, collectionId, formatId, 'values.fieldId': fieldId, ...(excludeEntryId ? { _id: { $ne: excludeEntryId } } : {}) }).limit(1001).exec();
    if (candidates.length > 1000) throw new BadRequestException('Narrow the link search');
    return candidates.filter((entry) => entry.values.some((value) => { if (value.fieldId !== fieldId) return false; try { return new URL(value.value).href === normalized; } catch { return false; } }));
  }
}
