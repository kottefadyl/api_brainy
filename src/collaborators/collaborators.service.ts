// T52: collaborators. Only collaborators can be given access to a collection; ending a collaboration
// removes every share between the two people, in both directions.
import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { User } from '../auth/user.schema.js';
import { Collection } from '../collections/collection.schema.js';
import { AuditLog } from '../collections/collaboration.schema.js';
import { Collaboration, CollaborationInvitePreview, Collaborator, CollaboratorInvite, CollectionOwnerSummary } from './collaborator.schema.js';

const pairKey = (a: string, b: string) => [a, b].sort().join(':');
const newToken = () => randomBytes(18).toString('base64url');
const validToken = (token: string) => /^[A-Za-z0-9_-]{16,64}$/.test(token);

@Injectable()
export class CollaboratorsService implements OnModuleInit {
  private readonly logger = new Logger(CollaboratorsService.name);

  constructor(
    @InjectModel(CollaboratorInvite.name) private readonly invites: Model<CollaboratorInvite>,
    @InjectModel(Collaboration.name) private readonly collaborations: Model<Collaboration>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Collection.name) private readonly collections: Model<Collection>,
    @InjectModel(AuditLog.name) private readonly auditLogs: Model<AuditLog>,
  ) {}

  /** Migration: people already sharing a collection (T28) become collaborators so nothing breaks. */
  async onModuleInit(): Promise<void> {
    try {
      const shared = await this.collections.find({ 'members.0': { $exists: true } }).select('ownerId members.userId').lean().exec();
      const pairs = new Map<string, string[]>();
      for (const collection of shared) {
        for (const member of collection.members ?? []) {
          if (member.userId !== collection.ownerId) pairs.set(pairKey(collection.ownerId, member.userId), [collection.ownerId, member.userId].sort());
        }
      }
      if (!pairs.size) return;
      await this.collaborations.bulkWrite([...pairs].map(([key, userIds]) => ({
        updateOne: { filter: { pairKey: key }, update: { $setOnInsert: { pairKey: key, userIds } }, upsert: true },
      })));
    } catch (error) {
      this.logger.warn(`Collaborator migration skipped: ${(error as Error).message}`);
    }
  }

  async isCollaborator(userId: string, otherId: string): Promise<boolean> {
    return userId !== otherId && !!(await this.collaborations.exists({ pairKey: pairKey(userId, otherId) }).exec());
  }

  /** The person's invitation token, created on first use. */
  async inviteToken(userId: string): Promise<string> {
    const existing = await this.invites.findOne({ userId }).exec();
    if (existing) return existing.token;
    try {
      return (await this.invites.create({ userId, token: newToken() })).token;
    } catch {
      return (await this.invites.findOne({ userId }).orFail().exec()).token;
    }
  }

  /** Replaces the token: the previous link stops working at once. Existing collaborations stay. */
  async regenerateInviteToken(userId: string): Promise<string> {
    const token = newToken();
    await this.invites.updateOne({ userId }, { $set: { token } }, { upsert: true }).exec();
    return token;
  }

  private async inviter(token: string): Promise<User> {
    const invite = validToken(token) ? await this.invites.findOne({ token }).exec() : null;
    const user = invite ? await this.users.findById(invite.userId).select('name').exec() : null;
    if (!user) throw new NotFoundException('This collaboration link is no longer valid');
    return user;
  }

  /** What an invitation link shows before acceptance: the inviter's name only. */
  async preview(token: string, viewerId?: string): Promise<CollaborationInvitePreview> {
    const user = await this.inviter(token);
    const isSelf = viewerId === user.id;
    return {
      inviterName: user.name,
      isSelf,
      alreadyCollaborator: !!viewerId && !isSelf && await this.isCollaborator(viewerId, user.id),
    };
  }

  /** Accepting a link creates the collaboration at once: sending the link is the inviter's consent. */
  async accept(token: string, userId: string): Promise<Collaborator> {
    const inviter = await this.inviter(token);
    if (inviter.id === userId) throw new BadRequestException('You cannot collaborate with yourself');
    const key = pairKey(inviter.id, userId);
    await this.collaborations.updateOne(
      { pairKey: key },
      { $setOnInsert: { pairKey: key, userIds: [inviter.id, userId].sort(), inviterId: inviter.id } },
      { upsert: true },
    ).exec();
    return (await this.list(userId)).find((item) => item.userId === inviter.id)!;
  }

  async list(userId: string): Promise<Collaborator[]> {
    const rows = await this.collaborations.find({ userIds: userId }).sort({ createdAt: -1 }).lean().exec();
    const otherIds = rows.map((row) => row.userIds.find((id) => id !== userId)).filter((id): id is string => !!id && Types.ObjectId.isValid(id));
    const [people, withPhoto] = await Promise.all([
      this.users.find({ _id: { $in: otherIds } }).select('name email').exec(),
      this.users.find({ _id: { $in: otherIds }, profilePhoto: { $exists: true, $nin: [null, ''] } }).select('_id').lean().exec(),
    ]);
    const photos = new Set(withPhoto.map((person) => String(person._id)));
    const byId = new Map(people.map((person) => [String(person.id), person]));
    return rows.flatMap((row) => {
      const otherId = row.userIds.find((id) => id !== userId) ?? '';
      const person = byId.get(otherId);
      return person ? [{ userId: otherId, name: person.name, email: person.email, since: row.createdAt ?? new Date(0), hasPhoto: photos.has(otherId) }] : [];
    });
  }

  /** Photo of a collaborator, only between collaborators. */
  async photo(userId: string, otherId: string): Promise<string | null> {
    if (!(await this.isCollaborator(userId, otherId))) throw new NotFoundException('Collaborator not found');
    return (await this.users.findById(otherId).select('+profilePhoto').exec())?.profilePhoto ?? null;
  }

  /** Ends the collaboration and removes every share between the two people, both ways. */
  async end(userId: string, otherId: string): Promise<boolean> {
    const removed = await this.collaborations.deleteOne({ pairKey: pairKey(userId, otherId) }).exec();
    if (!removed.deletedCount) throw new NotFoundException('Collaborator not found');
    for (const [ownerId, memberId] of [[userId, otherId], [otherId, userId]]) {
      const shared = await this.collections.find({ ownerId, 'members.userId': memberId }).select('_id').lean().exec();
      if (!shared.length) continue;
      await this.collections.updateMany({ _id: { $in: shared.map((item) => item._id) } }, { $pull: { members: { userId: memberId } } }).exec();
      await this.auditLogs.insertMany(shared.map((item) => ({
        collectionId: String(item._id), userId, action: 'REVOKE_MEMBER', details: `Collaboration ended; member ${memberId} removed`, occurredAt: new Date(),
      })));
    }
    return true;
  }

  /** Owner shown on a collection shared with the viewer; null for the viewer's own collections. */
  async owner(collection: Collection, viewerId: string): Promise<CollectionOwnerSummary | null> {
    if (collection.ownerId === viewerId) return null;
    const user = Types.ObjectId.isValid(collection.ownerId) ? await this.users.findById(collection.ownerId).select('name').exec() : null;
    return user ? { userId: collection.ownerId, name: user.name } : null;
  }
}
