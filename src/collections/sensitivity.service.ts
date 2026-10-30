import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CollaborationService } from './collaboration.service';
import { CollectionRole } from './collaboration.schema';
import { Collection, CollectionFormat, SensitivityLevel } from './collection.schema';
import { validSensitivity } from './sensitivity.logic';

@Injectable()
export class SensitivityService {
  constructor(@InjectModel(Collection.name) private readonly collections: Model<Collection>, private readonly collaboration: CollaborationService) {}

  private async context(collectionId: string, actorId: string): Promise<Collection> {
    if (!Types.ObjectId.isValid(collectionId)) throw new NotFoundException('Collection not found');
    const collection = await this.collections.findById(collectionId).exec();
    if (!collection) throw new NotFoundException('Collection not found');
    this.collaboration.checkAccess(collection, actorId, CollectionRole.OWNER);
    return collection;
  }

  private format(collection: Collection, formatId: string, expectedVersion: number): CollectionFormat {
    const format = collection.formats.find((item) => item.id === formatId);
    if (!format) throw new NotFoundException('Data format not found');
    if ((format.version ?? 1) !== expectedVersion) throw new ConflictException('Data format changed. Refresh and try again');
    return format;
  }

  private versionFilter(version: number): number | { $in: (number | null)[] } { return version === 1 ? { $in: [null, 1] } : version; }

  async setFormat(collectionId: string, formatId: string, level: SensitivityLevel, expectedVersion: number, actorId: string): Promise<Collection> {
    if (!validSensitivity(level)) throw new BadRequestException('Choose a sensitivity level');
    const collection = await this.context(collectionId, actorId);
    const format = this.format(collection, formatId, expectedVersion);
    const updated = await this.collections.findOneAndUpdate({ _id: collectionId, ownerId: collection.ownerId,
      formats: { $elemMatch: { id: formatId, version: this.versionFilter(expectedVersion) } } },
      { $set: { 'formats.$.sensitivity': level, 'formats.$.version': expectedVersion + 1 } }, { new: true }).exec();
    if (!updated) throw new ConflictException('Data format changed. Refresh and try again');
    await this.collaboration.logAction(collectionId, actorId, 'SET_SENSITIVITY', `Data format ${format.id}: ${level}`);
    return updated;
  }

  async setField(collectionId: string, formatId: string, fieldId: string, level: SensitivityLevel, expectedVersion: number, actorId: string): Promise<Collection> {
    if (!validSensitivity(level)) throw new BadRequestException('Choose a sensitivity level');
    const collection = await this.context(collectionId, actorId);
    const format = this.format(collection, formatId, expectedVersion);
    if (!format.fields.some((item) => item.id === fieldId)) throw new NotFoundException('Field not found in this data format');
    const fields = format.fields.map((item) => ({ ...JSON.parse(JSON.stringify(item)) as Record<string, unknown>,
      ...(item.id === fieldId ? { sensitivity: level } : {}) }));
    const updated = await this.collections.findOneAndUpdate({ _id: collectionId, ownerId: collection.ownerId,
      formats: { $elemMatch: { id: formatId, version: this.versionFilter(expectedVersion) } } },
      { $set: { 'formats.$.fields': fields, 'formats.$.version': expectedVersion + 1,
        ...(collection.formats[0].id === formatId ? { fields } : {}) } }, { new: true }).exec();
    if (!updated) throw new ConflictException('Data format changed. Refresh and try again');
    await this.collaboration.logAction(collectionId, actorId, 'SET_SENSITIVITY', `Field ${fieldId} in data format ${formatId}: ${level}`);
    return updated;
  }

  async setMinimum(collectionId: string, minimum: number, actorId: string): Promise<Collection> {
    if (!Number.isInteger(minimum) || minimum < 2 || minimum > 100) throw new BadRequestException('Choose a minimum from 2 to 100 observations');
    const collection = await this.context(collectionId, actorId);
    const updated = await this.collections.findOneAndUpdate({ _id: collectionId, ownerId: collection.ownerId }, { $set: { minAggregateSize: minimum } }, { new: true }).exec();
    if (!updated) throw new ConflictException('Collection changed. Refresh and try again');
    await this.collaboration.logAction(collectionId, actorId, 'SET_AGGREGATE_MINIMUM', `Minimum observations: ${minimum}`);
    return updated;
  }
}
