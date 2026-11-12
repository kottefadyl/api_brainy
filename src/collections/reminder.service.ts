import { CollectionRole } from './collaboration.schema.js';
import { BadRequestException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnApplicationShutdown, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { getApps, initializeApp, cert, type App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { Model, Types } from 'mongoose';
import nodemailer from 'nodemailer';
import { User } from '../auth/user.schema.js';
import { EntryReminderInput } from './collection.input.js';
import { Collection, FieldKind } from './collection.schema.js';
import { Entry } from './entry.schema.js';
import { EntryReminder, PushDevice, ReminderCapabilities, ReminderDelivery } from './reminder.schema.js';
import { localDate, localTime, localToInstant, nextRecurrenceStart, validTimeZone } from './time_math.js';
import { addDays, nextOccurrenceDay } from './task-planner.logic.js';
import { taskRule } from './task-planner.rule.js';
import { assertNotFrozen, isFrozen } from '../platform.js';

@Injectable()
export class ReminderService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ReminderService.name);
  private timer?: NodeJS.Timeout;
  private busy = false;
  private firebase?: App;

  constructor(
    @InjectModel(EntryReminder.name) private readonly reminders: Model<EntryReminder>,
    @InjectModel(ReminderDelivery.name) private readonly deliveries: Model<ReminderDelivery>,
    @InjectModel(PushDevice.name) private readonly devices: Model<PushDevice>,
    @InjectModel(Collection.name) private readonly collections: Model<Collection>,
    @InjectModel(Entry.name) private readonly entries: Model<Entry>,
    @InjectModel(User.name) private readonly users: Model<User>,
  ) {}

  capabilities(): ReminderCapabilities {
    if (isFrozen('reminders')) return { email: false, push: false };
    const smtpPort = Number(process.env.SMTP_PORT ?? '587');
    let firebaseAccount = false;
    try {
      const value = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
      if (value) {
        const account = JSON.parse(value) as { project_id?: string; client_email?: string; private_key?: string };
        firebaseAccount = !!(account.client_email && account.private_key && account.project_id === process.env.FIREBASE_PROJECT_ID);
      } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim()) {
        firebaseAccount = existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS.trim());
      }
    } catch { firebaseAccount = false; }
    return {
      email: !!(process.env.SMTP_HOST?.trim() && process.env.SMTP_FROM?.trim() && Number.isInteger(smtpPort) && smtpPort >= 1 && smtpPort <= 65535 && (!process.env.SMTP_USER?.trim() || process.env.SMTP_PASSWORD)),
      push: !!(process.env.FIREBASE_PROJECT_ID?.trim() && firebaseAccount),
    };
  }

  onApplicationBootstrap(): void {
    if (isFrozen('reminders')) return;
    // A serverless host has no lasting process: GET /cron/reminders drives the sending there.
    if (process.env.VERCEL) return;
    this.timer = setInterval(() => { void this.processDue(); }, 15_000);
    this.timer.unref();
    void this.processDue();
  }
  onApplicationShutdown(): void { if (this.timer) clearInterval(this.timer); }

  /**
   * T52/5: the owner and a collaborator with read and write access can set reminders on an entry.
   * Each person only sees and receives their own; a collaborator's reminder keeps the entry owner as
   * ownerId (where the entry lives) and the collaborator as recipient.
   */
  private async ownedEntry(entryId: string, callerId: string, write = true): Promise<{ entry: Entry; collection: Collection }> {
    if (!Types.ObjectId.isValid(entryId)) throw new BadRequestException('Invalid entry ID');
    const entry = await this.entries.findOne({ _id: entryId }).exec();
    const collection = entry ? await this.collections.findOne({ _id: entry.collectionId, ownerId: entry.ownerId }).exec() : null;
    const member = collection?.members?.find((item) => item.userId === callerId);
    const allowed = collection && (collection.ownerId === callerId || (member && (!write || member.role === CollectionRole.EDITOR)));
    if (!entry || !collection || !allowed) throw new NotFoundException('Entry not found');
    return { entry, collection };
  }

  /** Reminders that belong to the caller: their own as owner, or the ones they set as a collaborator. */
  private mine(callerId: string) {
    return { $or: [{ recipientUserId: callerId }, { ownerId: callerId, recipientUserId: null }] };
  }

  async list(entryId: string, ownerId: string): Promise<EntryReminder[]> {
    await this.ownedEntry(entryId, ownerId, false);
    return this.reminders.find({ entryId, ...this.mine(ownerId), fieldId: { $not: /^workflow:/ }, state: { $ne: 'CANCELLED' } }).sort({ createdAt: -1 }).exec();
  }

  async scheduleWorkflow(entry: Entry, recipientUserId: string | undefined, dueAt?: Date, minutesBefore = 60, kind: 'ASSIGNMENT' | 'DUE' = 'DUE'): Promise<void> {
    if (isFrozen('reminders')) return;
    const fieldId = kind === 'DUE' ? 'workflow:due' : 'workflow:assignment';
    if (!recipientUserId || (kind === 'DUE' && !dueAt)) {
      await this.reminders.updateMany({ ownerId: entry.ownerId, entryId: entry.id, fieldId, state: 'ACTIVE' }, { $set: { state: 'CANCELLED' }, $unset: { nextAt: '', occurrenceAt: '' } }).exec();
      return;
    }
    const capabilities = this.capabilities();
    const channels = [
      ...(capabilities.email ? ['EMAIL'] : []),
      ...(capabilities.push && await this.devices.exists({ ownerId: recipientUserId }) ? ['PUSH'] : []),
    ];
    if (!channels.length) {
      await this.reminders.updateMany({ ownerId: entry.ownerId, entryId: entry.id, fieldId, state: 'ACTIVE' }, { $set: { state: 'CANCELLED' }, $unset: { nextAt: '', occurrenceAt: '' } }).exec();
      return;
    }
    const occurrenceAt = dueAt ?? new Date();
    const nextAt = kind === 'ASSIGNMENT' ? new Date() : new Date(Math.max(Date.now(), occurrenceAt.getTime() - minutesBefore * 60_000));
    await this.reminders.findOneAndUpdate(
      { ownerId: entry.ownerId, entryId: entry.id, fieldId, state: 'ACTIVE' },
      { $set: { ownerId: entry.ownerId, recipientUserId, collectionId: entry.collectionId, entryId: entry.id, fieldId, workflowKind: kind, timeZone: 'UTC', minutesBefore, channels, state: 'ACTIVE', occurrenceAt, nextAt, attempts: 0, failure: undefined }, $unset: { lockedUntil: '', lockToken: '' } },
      { upsert: true, returnDocument: 'after', runValidators: true },
    ).exec();
  }

  async devicesFor(ownerId: string): Promise<PushDevice[]> { return this.devices.find({ ownerId }).sort({ lastSeenAt: -1 }).exec(); }

  async registerDevice(ownerId: string, token: string, platform: string, label: string, targetKind = 'TOKEN'): Promise<PushDevice> {
    assertNotFrozen('reminders');
    if (!this.capabilities().push) throw new ServiceUnavailableException('Push notifications are not configured');
    if (!['TOKEN', 'FID'].includes(targetKind) || token.length < (targetKind === 'FID' ? 15 : 50) || token.length > 4096 || /\s/.test(token) || !['WEB', 'ANDROID', 'IOS'].includes(platform) || !label.trim() || label.length > 80) throw new BadRequestException('Invalid push device');
    const existing = await this.devices.findOne({ token }).exec();
    if (!existing && await this.devices.countDocuments({ ownerId }) >= 10) throw new BadRequestException('Remove an old push device before adding another');
    if (existing && existing.ownerId !== ownerId && await this.devices.countDocuments({ ownerId }) >= 10) throw new BadRequestException('Remove an old push device before adding another');
    const updated = await this.devices.findOneAndUpdate({ token }, { $set: { ownerId, platform, targetKind, label: label.trim(), lastSeenAt: new Date() }, $setOnInsert: { token } }, { returnDocument: 'after', upsert: true, runValidators: true }).exec();
    return updated!;
  }

  async unregisterDevice(ownerId: string, id: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(id)) throw new BadRequestException('Invalid device ID');
    return (await this.devices.deleteOne({ _id: id, ownerId }).exec()).deletedCount > 0;
  }

  /** T49: a reminder on the start of a repeating task comes back at every open occurrence. */
  private repeatingTask(entry: Entry, fieldId: string, collection?: Collection | null): boolean {
    const planner = collection?.taskPlanner;
    return !!planner && entry.formatId === planner.formatId && fieldId === planner.startFieldId && taskRule(entry, planner, 'UTC').repeat !== 'ONCE';
  }

  private occurrence(entry: Entry, fieldId: string, timeZone: string, timeOfDay: string | undefined, minutesBefore: number, after: Date, collection?: Collection | null): Date | undefined {
    if (this.repeatingTask(entry, fieldId, collection)) {
      const rule = taskRule(entry, collection!.taskPlanner!, timeZone);
      const [hour, minute] = (timeOfDay ?? '09:00').split(':').map(Number);
      let from = localDate(localTime(after, timeZone));
      for (let guard = 0; guard < 3; guard++) {
        const day = nextOccurrenceDay(rule, from);
        if (!day) return undefined;
        const [year, month, date] = day.split('-').map(Number);
        const at = localToInstant({ year, month, day: date, hour, minute, second: 0 }, timeZone);
        if (at > after) return at;
        from = addDays(day, 1);
      }
      return undefined;
    }
    const value = entry.values.find((item) => item.fieldId === fieldId)?.value;
    if (!value) return;
    let base: Date;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [year, month, day] = value.split('-').map(Number);
      const [hour, minute] = (timeOfDay ?? '09:00').split(':').map(Number);
      base = localToInstant({ year, month, day, hour, minute, second: 0 }, timeZone);
    } else base = new Date(value);
    if (Number.isNaN(base.getTime())) return;
    const threshold = after;
    if (entry.recurrence?.startFieldId === fieldId) return nextRecurrenceStart(base, entry.recurrence, threshold);
    return base > threshold ? base : undefined;
  }

  async save(entryId: string, ownerId: string, input: EntryReminderInput, reminderId?: string): Promise<EntryReminder> {
    assertNotFrozen('reminders');
    const { entry, collection } = await this.ownedEntry(entryId, ownerId);
    if (entry.movingOperationId) throw new BadRequestException('This object is being moved');
    const format = collection.formats.find((item) => item.id === entry.formatId);
    const field = format?.fields.find((item) => item.id === input.fieldId && [FieldKind.DATE, FieldKind.DATETIME].includes(item.kind));
    if (!field) throw new BadRequestException('Choose a date or date and time field in this entry');
    if (!entry.values.some((item) => item.fieldId === input.fieldId)) throw new BadRequestException('Fill in the reminder date first');
    if (!Number.isInteger(input.minutesBefore) || input.minutesBefore < 0 || input.minutesBefore > 43200) throw new BadRequestException('Choose an advance of 0 to 43200 minutes');
    if (!validTimeZone(input.timeZone) || input.timeZone.length > 100) throw new BadRequestException('Choose a valid IANA time zone');
    if (field.kind === FieldKind.DATE && input.timeOfDay && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.timeOfDay)) throw new BadRequestException('Choose a valid reminder time');
    const channels = [...new Set(input.channels)];
    if (!channels.length || channels.some((item) => !['EMAIL', 'PUSH'].includes(item))) throw new BadRequestException('Choose email or push');
    const capabilities = this.capabilities();
    if (channels.includes('EMAIL') && !capabilities.email) throw new ServiceUnavailableException('Email reminders are not configured');
    if (channels.includes('PUSH') && (!capabilities.push || await this.devices.countDocuments({ ownerId }) === 0)) throw new ServiceUnavailableException('Register a push device before enabling push reminders');
    if (input.viewId && !collection.savedViews.some((item) => item.id === input.viewId && item.layout === 'CALENDAR' && item.calendarStartFieldId === input.fieldId)) throw new BadRequestException('Choose a calendar view for recurring reminders');
    const occurrenceAt = this.occurrence(entry, input.fieldId, input.timeZone, input.timeOfDay, input.minutesBefore, new Date(), collection);
    if (!occurrenceAt) throw new BadRequestException('Choose a future reminder date or recurrence');
    const nextAt = new Date(Math.max(Date.now(), occurrenceAt.getTime() - input.minutesBefore * 60_000));
    if (reminderId && !Types.ObjectId.isValid(reminderId)) throw new BadRequestException('Invalid reminder ID');
    const existing = reminderId ? await this.reminders.findOne({ _id: reminderId, ...this.mine(ownerId), entryId, state: { $ne: 'CANCELLED' } }).exec() : undefined;
    if (reminderId && !existing) throw new NotFoundException('Reminder not found');
    // The owner's reminders keep no recipient (older data); a collaborator's name them as recipient.
    const person = entry.ownerId === ownerId ? { ownerId, recipientUserId: null } : { ownerId: entry.ownerId, recipientUserId: ownerId };
    const updated = await this.reminders.findOneAndUpdate(existing ? { _id: reminderId, entryId } : { ...person, entryId, fieldId: input.fieldId, state: 'ACTIVE' }, { $set: { ...person, collectionId: collection.id, entryId, fieldId: input.fieldId, viewId: input.viewId, timeZone: input.timeZone, timeOfDay: field.kind === FieldKind.DATE ? input.timeOfDay ?? '09:00' : undefined, minutesBefore: input.minutesBefore, channels, state: 'ACTIVE', nextAt, occurrenceAt, attempts: 0, failure: undefined }, $unset: { lockedUntil: '', lockToken: '' } }, { returnDocument: 'after', upsert: !existing, runValidators: true }).exec();
    return updated!;
  }

  async cancel(reminderId: string, ownerId: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(reminderId)) throw new BadRequestException('Invalid reminder ID');
    const updated = await this.reminders.findOneAndUpdate({ _id: reminderId, ...this.mine(ownerId), state: { $ne: 'CANCELLED' } }, { $set: { state: 'CANCELLED' }, $unset: { nextAt: '', occurrenceAt: '', lockedUntil: '', lockToken: '' } }).exec();
    return !!updated;
  }

  /**
   * Recomputes every active reminder on an entry after it changed. The caller has already been
   * authorized on the entry; in a shared collection (T52) the entry belongs to the collection owner
   * and each person keeps their own reminders, so neither the entry nor the reminders are filtered
   * by the caller.
   */
  async refreshEntry(entryId: string, _callerId: string): Promise<void> {
    if (!Types.ObjectId.isValid(entryId)) return;
    const reminders = await this.reminders.find({ entryId, state: 'ACTIVE' }).exec();
    if (!reminders.length) return;
    const entry = await this.entries.findOne({ _id: entryId }).exec();
    const collection = entry && await this.collections.findOne({ _id: entry.collectionId }).exec();
    if (!entry || !collection) return;
    for (const reminder of reminders) {
      const occurrenceAt = this.occurrence(entry, reminder.fieldId, reminder.timeZone, reminder.timeOfDay, reminder.minutesBefore, new Date(), collection);
      if (!occurrenceAt) await this.reminders.updateOne({ _id: reminder.id }, { $set: { state: 'DONE', failure: 'The reminder date is no longer in the future' }, $unset: { nextAt: '', occurrenceAt: '' } }).exec();
      else await this.reminders.updateOne({ _id: reminder.id }, { $set: { occurrenceAt, nextAt: new Date(Math.max(Date.now(), occurrenceAt.getTime() - reminder.minutesBefore * 60_000)), attempts: 0, failure: undefined } }).exec();
    }
  }

  /** The entry is gone or done for everyone who can see it (T52), so every person's reminder on it stops. */
  async cancelEntry(entryId: string, _callerId: string): Promise<void> { await this.reminders.updateMany({ entryId, state: 'ACTIVE' }, { $set: { state: 'CANCELLED' }, $unset: { nextAt: '', occurrenceAt: '' } }).exec(); }
  async cancelCollection(collectionId: string, ownerId: string): Promise<void> { await this.reminders.updateMany({ collectionId, ownerId, state: 'ACTIVE' }, { $set: { state: 'CANCELLED' }, $unset: { nextAt: '', occurrenceAt: '' } }).exec(); }

  private async pushApp(): Promise<App> {
    if (this.firebase) return this.firebase;
    const projectId = process.env.FIREBASE_PROJECT_ID!;
    const account = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const name = 'brainy-reminders';
    this.firebase = getApps().find((app) => app.name === name) ?? initializeApp(account ? { projectId, credential: cert(JSON.parse(account) as Parameters<typeof cert>[0]) } : { projectId }, name);
    return this.firebase;
  }

  private async send(channel: string, reminder: EntryReminder, key: string, device?: PushDevice): Promise<void> {
    const entry = await this.entries.findOne({ _id: reminder.entryId, ownerId: reminder.ownerId }).exec();
    const user = await this.users.findById(reminder.recipientUserId ?? reminder.ownerId).exec();
    if (!entry || !user) throw new Error('Reminder owner or entry is unavailable');
    const collection = await this.collections.findOne({ _id: reminder.collectionId, ownerId: reminder.ownerId }).exec();
    // T52/5: a collaborator who lost access to the collection no longer receives its reminders.
    if (reminder.recipientUserId && reminder.recipientUserId !== reminder.ownerId && !reminder.fieldId.startsWith('workflow:') && !collection?.members?.some((item) => item.userId === reminder.recipientUserId)) {
      await this.reminders.updateOne({ _id: reminder.id }, { $set: { state: 'CANCELLED' }, $unset: { nextAt: '', occurrenceAt: '' } }).exec();
      throw new Error('Reminder recipient no longer has access');
    }
    const format = collection?.formats.find((item) => item.id === entry.formatId);
    const titleField = format?.fields.find((item) => item.kind === FieldKind.TITLE);
    const title = entry.values.find((item) => item.fieldId === titleField?.id)?.value ?? format?.name ?? collection?.name ?? 'Entry';
    const body = `${collection?.name ?? 'Brainy'}: ${title}`;
    if (channel === 'EMAIL') {
      const host = process.env.SMTP_HOST!, port = Number(process.env.SMTP_PORT ?? '587');
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SMTP port');
      const secure = process.env.SMTP_SECURE === 'true';
      const transport = nodemailer.createTransport({ host, port, secure, requireTLS: !secure && process.env.SMTP_REQUIRE_TLS !== 'false', auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD ?? '' } : undefined });
      await transport.sendMail({ from: process.env.SMTP_FROM, to: user.email, subject: reminder.workflowKind === 'ASSIGNMENT' ? 'Brainy assignment' : 'Brainy reminder', text: `${body}\n${reminder.occurrenceAt?.toISOString() ?? ''} (${reminder.timeZone})`, messageId: `<${key}@brainy-reminder.local>` });
      return;
    }
    if (!device) throw new Error('No push device is registered');
    const messaging = getMessaging(await this.pushApp());
    const payload = { notification: { title: reminder.workflowKind === 'ASSIGNMENT' ? 'Brainy assignment' : 'Brainy reminder', body }, data: { reminderId: reminder.id, occurrenceAt: reminder.occurrenceAt?.toISOString() ?? '', key }, android: { collapseKey: key.slice(0, 64), priority: 'high' as const, notification: { channelId: 'brainy_reminders', sound: 'default', defaultSound: true, defaultVibrateTimings: true } }, apns: { payload: { aps: { sound: 'default' } } }, webpush: { notification: { tag: key, renotify: false } } };
    try {
      if (device.targetKind === 'FID') await messaging.send({ ...payload, fid: device.token });
      else await messaging.send({ ...payload, token: device.token });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(code ?? '')) await this.devices.deleteOne({ _id: device.id, ownerId: reminder.recipientUserId ?? reminder.ownerId }).exec();
      throw error;
    }
  }

  private async sendOnce(channel: string, reminder: EntryReminder, device?: PushDevice): Promise<boolean> {
    const key = `${reminder.id}:${reminder.occurrenceAt?.toISOString()}:${channel}${device ? `:${device.id}` : ''}`;
    const now = new Date();
    const current = await this.deliveries.findOne({ key }).exec();
    if (current?.state === 'SENT') return true;
    if (current?.state === 'SENDING' && current.claimUntil && current.claimUntil > now) return false;
    const claimUntil = new Date(now.getTime() + 120_000);
    const claimed = await this.deliveries.findOneAndUpdate({ key, $or: [{ state: { $in: ['PENDING', 'FAILED'] } }, { state: 'SENDING', claimUntil: { $lte: now } }, { state: { $exists: false } }] }, { $set: { key, reminderId: reminder.id, ownerId: reminder.ownerId, channel, state: 'SENDING', claimUntil }, $unset: { failure: '' } }, { upsert: !current, returnDocument: 'after' }).exec();
    if (!claimed) return false;
    try {
      await this.send(channel, reminder, key.replace(/[^a-zA-Z0-9.-]/g, '-'), device);
      await this.deliveries.updateOne({ key, state: 'SENDING' }, { $set: { state: 'SENT', sentAt: new Date() }, $unset: { claimUntil: '' } }).exec();
      return true;
    } catch (error) {
      await this.deliveries.updateOne({ key, state: 'SENDING' }, { $set: { state: 'FAILED', failure: error instanceof Error ? error.message.slice(0, 300) : 'Unknown delivery error' }, $unset: { claimUntil: '' } }).exec();
      throw error;
    }
  }

  async processDue(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let index = 0; index < 50; index++) {
        const now = new Date(), token = randomUUID();
        const reminder = await this.reminders.findOneAndUpdate({ state: 'ACTIVE', nextAt: { $lte: now }, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] }, { $set: { lockedUntil: new Date(now.getTime() + 120_000), lockToken: token } }, { sort: { nextAt: 1 }, returnDocument: 'after' }).exec();
        if (!reminder) break;
        try {
          const pushDevices = reminder.channels.includes('PUSH') ? await this.devices.find({ ownerId: reminder.recipientUserId ?? reminder.ownerId }).exec() : [];
          const deliveries = [
            ...(reminder.channels.includes('EMAIL') ? [this.sendOnce('EMAIL', reminder)] : []),
            ...(reminder.channels.includes('PUSH') && !pushDevices.length ? [Promise.reject(new Error('No push device is registered'))] : []),
            ...pushDevices.map((device) => this.sendOnce('PUSH', reminder, device)),
          ];
          const results = await Promise.allSettled(deliveries);
          const failure = results.find((result) => result.status === 'rejected') as PromiseRejectedResult | undefined;
          if (failure || results.some((result) => result.status === 'fulfilled' && !result.value)) {
            const attempts = (reminder.attempts ?? 0) + 1;
            await this.reminders.updateOne({ _id: reminder.id, lockToken: token }, { $set: { state: attempts >= 10 ? 'FAILED' : 'ACTIVE', attempts, failure: failure?.reason instanceof Error ? failure.reason.message.slice(0, 300) : 'Delivery is already in progress', nextAt: new Date(Date.now() + Math.min(60, 2 ** attempts) * 60_000) }, $unset: { lockedUntil: '', lockToken: '' } }).exec();
            continue;
          }
          const entry = await this.entries.findOne({ _id: reminder.entryId, ownerId: reminder.ownerId }).exec();
          const owner = entry ? await this.collections.findById(reminder.collectionId).exec() : null;
          const next = entry && reminder.occurrenceAt && (entry.recurrence?.startFieldId === reminder.fieldId || this.repeatingTask(entry, reminder.fieldId, owner))
            ? this.occurrence(entry, reminder.fieldId, reminder.timeZone, reminder.timeOfDay, reminder.minutesBefore, reminder.occurrenceAt, owner)
            : undefined;
          await this.reminders.updateOne({ _id: reminder.id, lockToken: token }, next ? { $set: { state: 'ACTIVE', nextAt: new Date(next.getTime() - reminder.minutesBefore * 60_000), occurrenceAt: next, attempts: 0, failure: undefined }, $unset: { lockedUntil: '', lockToken: '' } } : { $set: { state: 'DONE', attempts: 0, failure: undefined }, $unset: { nextAt: '', occurrenceAt: '', lockedUntil: '', lockToken: '' } }).exec();
        } catch (error) {
          this.logger.error(`Reminder ${reminder.id} failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
          await this.reminders.updateOne({ _id: reminder.id, lockToken: token }, { $set: { nextAt: new Date(Date.now() + 60_000), failure: error instanceof Error ? error.message.slice(0, 300) : 'Unknown error' }, $unset: { lockedUntil: '', lockToken: '' } }).exec();
        }
      }
    } catch (error) { this.logger.error(`Reminder worker failed: ${error instanceof Error ? error.message : 'Unknown error'}`); }
    finally { this.busy = false; }
  }
}
