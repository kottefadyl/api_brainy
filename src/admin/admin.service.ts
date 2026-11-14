import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import type { Connection } from 'mongoose';
import { AuthService } from '../auth/auth.service.js';
import { User } from '../auth/user.schema.js';
import { S3Storage } from '../collections/large-file.s3.js';
import { AdminErasure, AdminOverview, AdminUser } from './admin.types.js';

/**
 * Brainy administration: every account with the storage it uses, blocking, erasing an account's data
 * and deleting an account. Reserved to the addresses listed in `BRAINY_ADMIN_EMAILS` (comma separated);
 * without that setting nobody is an administrator.
 */
export function adminEmails(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env.BRAINY_ADMIN_EMAILS ?? '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));
}

/** Audit trails of other people's collections keep the actions done there. */
const OWN_COLLECTION_ONLY = new Set(['auditlogs']);

@Injectable()
export class AdminService {
  private readonly logger = new Logger('Admin');

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly auth: AuthService,
    private readonly storage: S3Storage,
  ) {}

  /** The signed-in administrator, or a refusal that says nothing more than needed. */
  async administrator(authorization?: string): Promise<User> {
    const user = await this.auth.currentUser(authorization);
    if (!adminEmails().has(user.email.toLowerCase())) throw new ForbiddenException('Administration is reserved to the Brainy administrator');
    return user;
  }

  async isAdministrator(authorization?: string): Promise<boolean> {
    try { await this.administrator(authorization); return true; } catch { return false; }
  }

  private get db() {
    const db = this.connection.db;
    if (!db) throw new Error('Database not connected');
    return db;
  }

  /** Names of the data collections, without the accounts themselves and MongoDB's own. */
  private async dataCollections(): Promise<string[]> {
    const all = await this.db.listCollections({}, { nameOnly: true }).toArray();
    return all.map((item) => item.name).filter((name) => name !== 'users' && !name.startsWith('system.'));
  }

  async overview(): Promise<AdminOverview> {
    const admins = adminEmails();
    const users = await this.db.collection('users').aggregate<{ _id: Types.ObjectId; name: string; email: string; createdAt?: Date; lastActiveAt?: Date; blocked?: boolean; blockedAt?: Date; firebaseUid?: string; size: number }>([
      { $project: { name: 1, email: 1, createdAt: 1, lastActiveAt: 1, blocked: 1, blockedAt: 1, firebaseUid: 1, size: { $bsonSize: '$$ROOT' } } },
    ]).toArray();
    const bytes = new Map<string, number>();
    const add = (map: Map<string, number>, key: string, value: number) => map.set(key, (map.get(key) ?? 0) + value);
    const collectionCounts = new Map<string, number>();
    const entryCounts = new Map<string, number>();
    for (const name of await this.dataCollections()) {
      const groups = await this.db.collection(name).aggregate<{ _id: string; bytes: number; count: number }>([
        { $match: { ownerId: { $type: 'string' } } },
        { $group: { _id: '$ownerId', bytes: { $sum: { $bsonSize: '$$ROOT' } }, count: { $sum: 1 } } },
      ]).toArray();
      for (const group of groups) {
        add(bytes, group._id, group.bytes);
        if (name === 'collections') collectionCounts.set(group._id, group.count);
        if (name === 'entries') entryCounts.set(group._id, group.count);
      }
    }
    const fileBytes = new Map<string, number>();
    for (const group of await this.db.collection('largefiles').aggregate<{ _id: string; bytes: number }>([
      { $group: { _id: '$ownerId', bytes: { $sum: '$size' } } },
    ]).toArray()) add(fileBytes, group._id, group.bytes);

    const rows: AdminUser[] = users.map((user) => {
      const id = user._id.toString();
      const databaseBytes = user.size + (bytes.get(id) ?? 0);
      const files = fileBytes.get(id) ?? 0;
      return {
        id, name: user.name, email: user.email, createdAt: user.createdAt, lastActiveAt: user.lastActiveAt,
        blocked: !!user.blocked, blockedAt: user.blockedAt, admin: admins.has(user.email.toLowerCase()), googleSignIn: !!user.firebaseUid,
        collections: collectionCounts.get(id) ?? 0, entries: entryCounts.get(id) ?? 0,
        databaseBytes, fileBytes: files, totalBytes: databaseBytes + files,
      };
    }).sort((a, b) => b.totalBytes - a.totalBytes);
    return {
      users: rows, userCount: rows.length, blockedCount: rows.filter((row) => row.blocked).length,
      totalBytes: rows.reduce((total, row) => total + row.totalBytes, 0), generatedAt: new Date(),
    };
  }

  private async target(userId: string, administrator: User): Promise<{ _id: Types.ObjectId; email: string }> {
    if (!Types.ObjectId.isValid(userId)) throw new BadRequestException('Invalid account');
    if (userId === administrator.id) throw new BadRequestException('The administrator account cannot be changed from here');
    const user = await this.db.collection('users').findOne<{ _id: Types.ObjectId; email: string }>({ _id: new Types.ObjectId(userId) }, { projection: { email: 1 } });
    if (!user) throw new NotFoundException('Account not found');
    if (adminEmails().has(user.email.toLowerCase())) throw new BadRequestException('Another administrator cannot be changed from here');
    return user;
  }

  async setBlocked(userId: string, blocked: boolean, administrator: User): Promise<boolean> {
    const user = await this.target(userId, administrator);
    await this.db.collection('users').updateOne({ _id: user._id }, blocked ? { $set: { blocked: true, blockedAt: new Date() } } : { $set: { blocked: false }, $unset: { blockedAt: '' } });
    this.logger.log(`${blocked ? 'Blocked' : 'Unblocked'} account ${userId}`);
    return blocked;
  }

  /**
   * Removes everything the account owns: its collections with their entries, files, links, reminders,
   * notes, devices, collaborations and invitations; it also leaves the collections shared with it.
   * With `deleteAccount` the account itself goes too; otherwise it stays, emptied, with its name and email.
   * The email must be typed again to confirm.
   */
  async erase(userId: string, confirmEmail: string, deleteAccount: boolean, administrator: User): Promise<AdminErasure> {
    const user = await this.target(userId, administrator);
    if (confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) throw new BadRequestException('Type the account email to confirm');
    const owned = await this.db.collection('collections').find({ ownerId: userId }, { projection: { _id: 1 } }).toArray();
    const collectionIds = owned.map((item) => item._id.toString());

    // Large files live in object storage: remove the stored objects before their records.
    const files = await this.db.collection('largefiles').find({ $or: [{ ownerId: userId }, { collectionId: { $in: collectionIds } }] }, { projection: { objectKey: 1 } }).toArray();
    let removedFiles = 0;
    if (this.storage.configured) {
      for (const file of files) {
        try { await this.storage.remove(file.objectKey as string); removedFiles++; }
        catch (error) { this.logger.warn(`Could not remove stored file ${String(file.objectKey)}: ${error instanceof Error ? error.message : error}`); }
      }
    }

    let documents = 0;
    for (const name of await this.dataCollections()) {
      const filter = OWN_COLLECTION_ONLY.has(name)
        ? { collectionId: { $in: collectionIds } }
        : { $or: [{ ownerId: userId }, { userId }, { uploaderId: userId }, { collectionId: { $in: collectionIds } }, { userIds: userId }] };
      documents += (await this.db.collection(name).deleteMany(filter)).deletedCount;
    }
    // Collections other people shared with this account no longer list it.
    await this.db.collection('collections').updateMany({ 'members.userId': userId }, { $pull: { members: { userId } } } as never);

    if (deleteAccount) {
      await this.db.collection('users').deleteOne({ _id: user._id });
    } else {
      await this.db.collection('users').updateOne({ _id: user._id }, {
        $set: { profession: '', job: '', fieldOfStudy: '', interests: [], hobbies: [], hasProfilePhoto: false, profileCompleted: false, onboardingCompleted: false },
        $unset: { profilePhoto: '', viewPreferences: '' },
      });
    }
    this.logger.log(`${deleteAccount ? 'Deleted account' : 'Erased data of account'} ${userId}: ${collectionIds.length} collections, ${documents} documents, ${removedFiles} files`);
    return { collections: collectionIds.length, documents, files: removedFiles, accountDeleted: deleteAccount };
  }
}
