// Real-time data synchronisation. Vercel's free plan cannot keep sockets open cheaply (an open connection
// keeps a 2 GB instance billable; 360 GB-hrs a month), so the live channel is Cloud Firestore (free quota:
// 50,000 reads and 20,000 writes a day). After a change, the API writes a tiny signal per collection:
// brainy_signals/{collectionId} = { version, at, by, kind, readers }. No content leaves Brainy. Clients
// signed in with a Firebase custom token listen to the signals of their collections and reload.
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { Model, Types } from 'mongoose';
import { Collection } from '../collections/collection.schema.js';
import { firebaseAdminApp, firebaseAdminConfigured } from '../firebase-admin-app.js';

export const SIGNALS = 'brainy_signals';
const TIMEOUT_MS = 2500;

@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);

  constructor(@InjectModel(Collection.name) private readonly collections: Model<Collection>) {}

  /** On when Firebase Admin is configured; BRAINY_REALTIME=off turns it off. */
  get enabled(): boolean {
    return process.env.BRAINY_REALTIME !== 'off' && firebaseAdminConfigured();
  }

  /** Firebase custom token for the signed-in person: their Brainy ID becomes the Firebase uid. */
  async token(userId: string): Promise<string | null> {
    if (!this.enabled) return null;
    return getAuth(firebaseAdminApp()).createCustomToken(userId);
  }

  /**
   * Tells the people of each collection that it changed. Never fails the change itself: a signal that
   * cannot be written within 2.5 s is only logged (clients still see the change on their next load).
   */
  async signal(collectionIds: string[], actorId: string, kind: string): Promise<void> {
    const ids = [...new Set(collectionIds)].filter((id) => Types.ObjectId.isValid(id));
    if (!ids.length || !this.enabled) return;
    try {
      const found = await this.collections.find({ _id: { $in: ids } }).select('ownerId members.userId').lean().exec();
      const byId = new Map(found.map((item) => [String(item._id), item]));
      const db = getFirestore(firebaseAdminApp());
      const writes = ids.map((id) => {
        const collection = byId.get(id);
        const reference = db.collection(SIGNALS).doc(id);
        // A deleted collection loses its signal: its listeners see it go and reload their list.
        if (!collection) return reference.delete();
        const readers = [...new Set([collection.ownerId, ...(collection.members ?? []).map((member) => member.userId)])];
        return reference.set({ version: FieldValue.increment(1), at: FieldValue.serverTimestamp(), by: actorId, kind, readers });
      });
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.all(writes), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS); })]).finally(() => clearTimeout(timer));
    } catch (error) {
      this.logger.warn(`Realtime signal skipped: ${(error as Error).message}`);
    }
  }
}
