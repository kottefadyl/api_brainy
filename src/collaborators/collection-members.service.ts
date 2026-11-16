// Who a collection is shared with: paged and searchable on the server, so an owner with thousands of members stays fast.
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage, Types } from 'mongoose';
import { User } from '../auth/user.schema.js';
import { Collection } from '../collections/collection.schema.js';
import { CollectionMembersPage } from './collection-members.schema.js';

export const MAX_MEMBERS_PAGE = 100;

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

@Injectable()
export class CollectionMembersService {
  constructor(
    @InjectModel(Collection.name) private readonly collections: Model<Collection>,
    @InjectModel(User.name) private readonly users: Model<User>,
  ) {}

  /** Only the owner lists the members of a collection; a member never sees the other people. */
  async page(collectionId: string, viewerId: string, search = '', offset = 0, limit = 50): Promise<CollectionMembersPage> {
    if (!Types.ObjectId.isValid(collectionId)) throw new NotFoundException('Collection not found');
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_MEMBERS_PAGE) throw new BadRequestException('Invalid page');
    if (search.length > 200) throw new BadRequestException('Search is too long');
    if (!await this.collections.exists({ _id: collectionId, ownerId: viewerId })) throw new NotFoundException('Collection not found');
    const term = search.trim();
    const pipeline: PipelineStage[] = [
      { $match: { _id: new Types.ObjectId(collectionId), ownerId: viewerId } },
      { $project: { members: 1 } },
      { $unwind: '$members' },
      { $replaceRoot: { newRoot: '$members' } },
      ...(term ? [{ $match: { $or: [{ name: { $regex: escapeRegex(term), $options: 'i' } }, { email: { $regex: escapeRegex(term), $options: 'i' } }] } } as PipelineStage] : []),
      { $sort: { name: 1, userId: 1 } },
      { $facet: { total: [{ $count: 'count' }], items: [{ $skip: offset }, { $limit: limit }, { $project: { _id: 0, userId: 1, name: 1, email: 1, role: 1, addedAt: 1 } }] } },
    ];
    const [result] = await this.collections.aggregate<{ total: { count: number }[]; items: { userId: string; name: string; email: string; role: string; addedAt: Date }[] }>(pipeline).exec();
    const items = result?.items ?? [];
    const ids = items.map((item) => item.userId).filter((id) => Types.ObjectId.isValid(id));
    const [people, withPhoto] = await Promise.all([
      this.users.find({ _id: { $in: ids } }).select('name email').lean().exec(),
      this.users.find({ _id: { $in: ids }, profilePhoto: { $exists: true, $nin: [null, ''] } }).select('_id').lean().exec(),
    ]);
    const byId = new Map(people.map((person) => [String(person._id), person]));
    const photos = new Set(withPhoto.map((person) => String(person._id)));
    return {
      total: result?.total[0]?.count ?? 0,
      offset,
      items: items.map((item) => ({ ...item, name: byId.get(item.userId)?.name ?? item.name, email: byId.get(item.userId)?.email ?? item.email, hasPhoto: photos.has(item.userId) })) as CollectionMembersPage['items'],
    };
  }
}
