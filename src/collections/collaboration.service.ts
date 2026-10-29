import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Collection, FieldKind } from './collection.schema';
import { AuditLog, CollectionMember, CollectionRole } from './collaboration.schema';
import { User } from '../auth/user.schema';
import { Entry } from './entry.schema';

@Injectable()
export class CollaborationService {
  constructor(
    @InjectModel(Collection.name) private readonly collections: Model<Collection>,
    @InjectModel(AuditLog.name) private readonly auditLogsModel: Model<AuditLog>,
    @InjectModel(User.name) private readonly users: Model<User>,
  ) {}

  checkAccess(
    collection: Collection,
    userId: string,
    requiredRole: CollectionRole = CollectionRole.READER,
  ): { role: CollectionRole; member?: CollectionMember } {
    if (collection.ownerId === userId) {
      return { role: CollectionRole.OWNER };
    }

    const member = (collection.members ?? []).find((m) => m.userId === userId);
    if (!member) {
      throw new ForbiddenException('Access denied to this collection');
    }

    if (requiredRole === CollectionRole.OWNER && member.role !== CollectionRole.OWNER) {
      throw new ForbiddenException('Only a collection owner can perform this action');
    }

    if (requiredRole === CollectionRole.EDITOR && member.role === CollectionRole.READER) {
      throw new ForbiddenException('Read-only members cannot modify collection data');
    }

    return { role: member.role, member };
  }

  filterEntryFields(entry: Entry, member?: CollectionMember, collection?: Collection): Entry {
    if (!member) {
      return entry;
    }

    const explicit = (member.sharedFieldIds?.length ?? 0) > 0;
    const allowed = new Set(member.sharedFieldIds ?? []);
    const sensitive = new Set(collection?.formats.flatMap((format) => format.fields.filter((field) => field.kind === FieldKind.POSITION || field.kind === FieldKind.ZONE).map((field) => field.id)) ?? []);
    const doc = typeof (entry as any).toObject === 'function' ? (entry as any).toObject() : entry;
    return {
      ...doc,
      id: entry.id ?? doc._id?.toString(),
      values: (entry.values ?? []).filter((v) => explicit ? allowed.has(v.fieldId) : !sensitive.has(v.fieldId)),
    } as Entry;
  }

  async addOrUpdateMember(
    collectionId: string,
    email: string,
    role: CollectionRole,
    sharedFieldIds: string[] | undefined,
    operatorUserId: string,
  ): Promise<Collection> {
    if (!Types.ObjectId.isValid(collectionId)) throw new BadRequestException('Invalid collection ID');
    const collection = await this.collections.findOne({ _id: collectionId }).exec();
    if (!collection) throw new NotFoundException('Collection not found');

    this.checkAccess(collection, operatorUserId, CollectionRole.OWNER);

    const targetUser = await this.users.findOne({ email: email.trim().toLowerCase() }).exec();
    if (!targetUser) throw new NotFoundException('User with this email not found');

    if (targetUser.id === collection.ownerId) {
      throw new BadRequestException('The collection owner cannot be added as a collaborator');
    }

    const existingMembers = collection.members ?? [];
    const index = existingMembers.findIndex((m) => m.userId === targetUser.id);

    const memberData: CollectionMember = {
      userId: targetUser.id,
      email: targetUser.email,
      name: targetUser.name,
      role,
      addedAt: index >= 0 ? existingMembers[index].addedAt : new Date(),
      sharedFieldIds: sharedFieldIds ?? [],
    };

    let updatedMembers: CollectionMember[];
    let actionName: string;
    if (index >= 0) {
      updatedMembers = [...existingMembers];
      updatedMembers[index] = memberData;
      actionName = 'UPDATE_MEMBER_ROLE';
    } else {
      updatedMembers = [...existingMembers, memberData];
      actionName = 'SHARE_COLLECTION';
    }

    const updated = await this.collections.findByIdAndUpdate(
      collectionId,
      { $set: { members: updatedMembers } },
      { new: true },
    ).exec();

    await this.logAction(
      collectionId,
      operatorUserId,
      actionName,
      `Member ${targetUser.email} set to ${role}${sharedFieldIds?.length ? ` with ${sharedFieldIds.length} shared fields` : ''}`,
    );

    return updated!;
  }

  async removeMember(collectionId: string, memberUserId: string, operatorUserId: string): Promise<Collection> {
    if (!Types.ObjectId.isValid(collectionId)) throw new BadRequestException('Invalid collection ID');
    const collection = await this.collections.findOne({ _id: collectionId }).exec();
    if (!collection) throw new NotFoundException('Collection not found');

    this.checkAccess(collection, operatorUserId, CollectionRole.OWNER);

    const existingMembers = collection.members ?? [];
    const member = existingMembers.find((m) => m.userId === memberUserId);
    if (!member) throw new NotFoundException('Member not found in this collection');

    const updated = await this.collections.findByIdAndUpdate(
      collectionId,
      { $pull: { members: { userId: memberUserId } } },
      { new: true },
    ).exec();

    await this.logAction(collectionId, operatorUserId, 'REVOKE_MEMBER', `Revoked member ${member.email}`);
    return updated!;
  }

  async logAction(collectionId: string, userId: string, action: string, details?: string): Promise<AuditLog> {
    return this.auditLogsModel.create({
      collectionId,
      userId,
      action,
      details,
      occurredAt: new Date(),
    });
  }

  async getAuditLogs(collectionId: string, userId: string): Promise<AuditLog[]> {
    if (!Types.ObjectId.isValid(collectionId)) throw new BadRequestException('Invalid collection ID');
    const collection = await this.collections.findOne({ _id: collectionId }).exec();
    if (!collection) throw new NotFoundException('Collection not found');

    // Access check: Only OWNER or EDITOR can read audit logs
    this.checkAccess(collection, userId, CollectionRole.EDITOR);

    return this.auditLogsModel.find({ collectionId }).sort({ occurredAt: -1 }).limit(100).exec();
  }
}

