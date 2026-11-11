import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Collection } from './collection.schema';
import { AuditLog, CollectionMember, CollectionRole } from './collaboration.schema';
import { User } from '../auth/user.schema';
import { Entry, EntryValue } from './entry.schema';
import { protectedFields } from './sensitivity.logic';
import { CollaboratorsService } from '../collaborators/collaborators.service';

@Injectable()
export class CollaborationService {
  constructor(
    @InjectModel(Collection.name) private readonly collections: Model<Collection>,
    @InjectModel(AuditLog.name) private readonly auditLogsModel: Model<AuditLog>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly collaborators: CollaboratorsService,
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

  filterEntryFields(entry: Entry, member: CollectionMember | undefined, collection: Collection): Entry {
    if (!member) {
      return entry;
    }

    const explicit = (member.sharedFieldIds?.length ?? 0) > 0;
    const allowed = new Set(member.sharedFieldIds ?? []);
    const definition = collection.formats.find((format) => format.id === entry.formatId);
    const protectedIds = definition ? protectedFields(definition) : new Set<string>();
    const approved = new Set(member.sensitiveFieldIds ?? []);
    const doc = typeof (entry as any).toObject === 'function' ? (entry as any).toObject() : entry;
    const visible = (values: EntryValue[]) => (values ?? []).filter((value) => (!explicit || allowed.has(value.fieldId)) && (!protectedIds.has(value.fieldId) || approved.has(value.fieldId))).map((value) => ({ ...value,
      objectSnapshots: value.objectSnapshots?.map((snapshot) => {
        const target = collection.formats.find((format) => format.id === snapshot.formatId);
        const hidden = target ? protectedFields(target) : new Set<string>();
        return { ...snapshot, properties: target ? snapshot.properties.filter((property) => !hidden.has(property.fieldId) || approved.has(property.fieldId)) : [] };
      }),
    }));
    return {
      ...doc,
      id: entry.id ?? doc._id?.toString(),
      values: visible(doc.values ?? []),
      revisions: (doc.revisions ?? []).map((revision: { values: EntryValue[] }) => ({ ...revision, values: visible(revision.values) })),
    } as Entry;
  }

  async auditProtectedRead(collection: Collection, actorId: string, entries: Entry[]): Promise<void> {
    const seen = new Set<string>();
    for (const entry of entries) {
      const format = collection.formats.find((item) => item.id === entry.formatId);
      if (format && entry.values.some((value) => protectedFields(format).has(value.fieldId))) seen.add(format.id);
    }
    if (seen.size) await this.logAction(collection.id, actorId, 'READ_PROTECTED_DATA', `Data formats: ${[...seen].join(',')}; entries: ${entries.length}`);
  }

  async projectCollection(collection: Collection, actorId: string): Promise<Collection> {
    if (collection.ownerId === actorId) return collection;
    this.checkAccess(collection, actorId);
    const grants = collection.sharedObjects ?? [];
    if (!grants.length) return collection;
    const sources = await this.collections.find({ _id: { $in: [...new Set(grants.map((item) => item.sourceCollectionId))] }, ownerId: collection.ownerId }).exec();
    const doc = typeof (collection as any).toObject === 'function' ? (collection as any).toObject() : collection;
    return { ...doc, id: collection.id, sharedObjects: grants.map((grant) => {
      const source = sources.find((item) => item.id === grant.sourceCollectionId);
      const format = source?.formats.find((item) => item.id === grant.sourceFormatId);
      const hidden = format ? protectedFields(format) : new Set(grant.propertyFieldIds);
      const approved = new Set(grant.sensitiveFieldIds ?? []);
      const title = format?.fields.find((item) => item.kind === 'TITLE');
      return { ...JSON.parse(JSON.stringify(grant)) as typeof grant,
        objectName: title && hidden.has(title.id) && !approved.has(title.id) ? 'Shared object' : grant.objectName,
        snapshot: grant.snapshot.filter((item) => !hidden.has(item.fieldId) || approved.has(item.fieldId)) };
    }) } as Collection;
  }

  async addOrUpdateMember(
    collectionId: string,
    target: { email?: string; userId?: string },
    role: CollectionRole,
    sharedFieldIds: string[] | undefined,
    sensitiveFieldIds: string[] | undefined,
    operatorUserId: string,
  ): Promise<Collection> {
    if (!Types.ObjectId.isValid(collectionId)) throw new BadRequestException('Invalid collection ID');
    const collection = await this.collections.findOne({ _id: collectionId }).exec();
    if (!collection) throw new NotFoundException('Collection not found');

    this.checkAccess(collection, operatorUserId, CollectionRole.OWNER);

    if (role === CollectionRole.OWNER) throw new BadRequestException('Choose read only or read and write');
    const targetUser = target.userId && Types.ObjectId.isValid(target.userId)
      ? await this.users.findById(target.userId).exec()
      : target.email ? await this.users.findOne({ email: target.email.trim().toLowerCase() }).exec() : null;
    if (!targetUser) throw new NotFoundException('User not found');

    if (targetUser.id === collection.ownerId) {
      throw new BadRequestException('The collection owner cannot be added as a collaborator');
    }
    // T52: a collection can only be shared with a collaborator (personal link accepted).
    if (!(await this.collaborators.isCollaborator(collection.ownerId, targetUser.id))) {
      throw new ForbiddenException('Share only with your collaborators: send them your collaboration link first');
    }

    const existingMembers = collection.members ?? [];
    const allIds = new Set(collection.formats.flatMap((format) => format.fields.map((field) => field.id)));
    const protectedIds = new Set(collection.formats.flatMap((format) => [...protectedFields(format)]));
    if ((sharedFieldIds ?? []).some((id) => !allIds.has(id)) || new Set(sharedFieldIds ?? []).size !== (sharedFieldIds ?? []).length) throw new BadRequestException('Choose valid shared fields');
    if ((sensitiveFieldIds ?? []).some((id) => !protectedIds.has(id) || (sharedFieldIds?.length && !sharedFieldIds.includes(id))) || new Set(sensitiveFieldIds ?? []).size !== (sensitiveFieldIds ?? []).length) throw new BadRequestException('Choose protected fields explicitly');
    const index = existingMembers.findIndex((m) => m.userId === targetUser.id);

    const memberData: CollectionMember = {
      userId: targetUser.id,
      email: targetUser.email,
      name: targetUser.name,
      role,
      addedAt: index >= 0 ? existingMembers[index].addedAt : new Date(),
      sharedFieldIds: sharedFieldIds ?? [],
      sensitiveFieldIds: sensitiveFieldIds ?? [],
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
      { returnDocument: 'after' },
    ).exec();

    await this.logAction(
      collectionId,
      operatorUserId,
      actionName,
      `Member ${targetUser.email} set to ${role}${sharedFieldIds?.length ? ` with ${sharedFieldIds.length} shared fields` : ''}`,
    );
    if (sensitiveFieldIds?.length) await this.logAction(collectionId, operatorUserId, 'SHARE_PROTECTED_FIELDS', `Member ${targetUser.id}; fields ${sensitiveFieldIds.join(',')}`);

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
      { returnDocument: 'after' },
    ).exec();

    await this.logAction(collectionId, operatorUserId, 'REVOKE_MEMBER', `Revoked member ${member.email}`);
    return updated!;
  }

  async logAction(collectionId: string, userId: string, action: string, details?: string, extra: { queryKey?: string; observationCount?: number } = {}): Promise<AuditLog> {
    return this.auditLogsModel.create({
      collectionId,
      userId,
      action,
      details,
      occurredAt: new Date(),
      ...extra,
    });
  }

  /** One person's audit events of the given kinds in a collection since a date, newest first. */
  async recentActions(collectionId: string, userId: string, actions: string[], since: Date): Promise<AuditLog[]> {
    return this.auditLogsModel.find({ collectionId, userId, action: { $in: actions }, occurredAt: { $gte: since } }).sort({ occurredAt: -1 }).limit(500).exec();
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

