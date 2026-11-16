// "Calculations and statistics": a per-collection choice. When off, the clients show no maths at all
// (insights, analyses, formulas, charts, totals, stock, measures and conversions, analysis limits),
// so a simple collection stays simple. Only the owner changes it.
import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Args, Context, Mutation, Resolver } from '@nestjs/graphql';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuthService } from '../auth/auth.service.js';
import { Collection } from './collection.schema.js';

/** Templates about money, stock or performance start with calculations on; the others start simple. */
export const CALCULATION_TEMPLATES = new Set(['expenses', 'kt_personal', 'shop', 'fitness']);
export const calculationsByDefault = (templateId?: string | null): boolean => !!templateId && CALCULATION_TEMPLATES.has(templateId);

type Request = { headers: { authorization?: string } };

@Injectable()
export class CollectionCalculationsMigration implements OnModuleInit {
  private readonly logger = new Logger(CollectionCalculationsMigration.name);
  constructor(@InjectModel(Collection.name) private readonly collections: Model<Collection>) {}

  /** Existing collections: on when they already use maths (or came from a money/stock template), off otherwise. */
  async onModuleInit(): Promise<void> {
    try {
      const missing = { calculations: { $exists: false } };
      const used = await this.collections.updateMany({ ...missing, $or: [
        { templateId: { $in: [...CALCULATION_TEMPLATES] } },
        { 'formulas.0': { $exists: true } },
        { 'stockRules.0': { $exists: true } },
        { 'units.0': { $exists: true } },
        { periodTotals: { $exists: true, $ne: null } },
      ] }, { $set: { calculations: true } }).exec();
      const simple = await this.collections.updateMany(missing, { $set: { calculations: false } }).exec();
      if (used.modifiedCount || simple.modifiedCount) this.logger.log(`Calculations set on ${used.modifiedCount} collection(s), off on ${simple.modifiedCount}`);
    } catch (error) {
      this.logger.warn(`Calculations choice skipped: ${(error as Error).message}`);
    }
  }
}

@Resolver(() => Collection)
export class CollectionCalculationsResolver {
  constructor(@InjectModel(Collection.name) private readonly collections: Model<Collection>, private readonly auth: AuthService) {}

  @Mutation(() => Collection, { description: 'Turns calculations and statistics on or off for a collection (owner only).' })
  async setCollectionCalculations(@Args('collectionId') collectionId: string, @Args('enabled') enabled: boolean, @Context('req') request: Request): Promise<Collection> {
    const ownerId = (await this.auth.currentUser(request.headers.authorization)).id;
    if (!Types.ObjectId.isValid(collectionId)) throw new NotFoundException('Collection not found');
    const existing = await this.collections.findOne({ _id: collectionId }).select('ownerId members.userId').lean().exec();
    if (!existing) throw new NotFoundException('Collection not found');
    if (existing.ownerId !== ownerId) {
      if ((existing.members ?? []).some((member) => member.userId === ownerId)) throw new BadRequestException('Only the collection owner can perform this action');
      throw new NotFoundException('Collection not found');
    }
    return (await this.collections.findOneAndUpdate({ _id: collectionId, ownerId }, { $set: { calculations: enabled } }, { returnDocument: 'after' }).exec())!;
  }
}
