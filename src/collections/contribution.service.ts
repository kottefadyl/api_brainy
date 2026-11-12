import { BadRequestException, ForbiddenException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes } from 'crypto';
import { Model, Types } from 'mongoose';
import { Collection, FieldKind } from './collection.schema.js';
import { Entry } from './entry.schema.js';
import { EntryValueInput } from './collection.input.js';
import { CollectionsService } from './collections.service.js';
import { ContributionLink, ContributionReceipt, ContributionSubmission, CreateContributionLinkInput, PublicContributionForm, RespondentContribution, SubmitContributionInput } from './contribution.schema.js';
import { RelationService } from './relation.service.js';
import { ReminderService } from './reminder.service.js';
import { EntryLinkService } from './entry-link.service.js';

const supported = new Set<FieldKind>([FieldKind.TITLE, FieldKind.TEXT, FieldKind.LONG_TEXT, FieldKind.DATE, FieldKind.TIME, FieldKind.NUMBER, FieldKind.BOOLEAN, FieldKind.SELECT, FieldKind.LINK, FieldKind.CHARACTER, FieldKind.DURATION]);
const digest = (secret: string) => createHash('sha256').update(secret).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const validSecret = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);

@Injectable()
export class ContributionService {
  constructor(
    @InjectModel(Collection.name) private readonly collections: Model<Collection>,
    @InjectModel(Entry.name) private readonly entries: Model<Entry>,
    @InjectModel(ContributionLink.name) private readonly links: Model<ContributionLink>,
    @InjectModel(ContributionSubmission.name) private readonly submissions: Model<ContributionSubmission>,
    private readonly collectionService: CollectionsService,
    private readonly relations: RelationService,
    private readonly reminders: ReminderService,
    private readonly entryLinks: EntryLinkService,
  ) {}

  private async owned(collectionId: string, actorId: string): Promise<Collection> {
    if (!Types.ObjectId.isValid(collectionId)) throw new NotFoundException('Collection not found');
    const collection = await this.collections.findOne({ _id: collectionId, ownerId: actorId }).exec();
    if (!collection) throw new ForbiddenException('Only the collection owner can manage contributions');
    return collection;
  }

  private async live(token: string): Promise<ContributionLink> {
    if (!validSecret(token)) throw new NotFoundException('Contribution link unavailable');
    const link = await this.links.findOne({ tokenHash: digest(token), revokedAt: null, expiresAt: { $gt: new Date() } }).exec();
    if (!link) throw new NotFoundException('Contribution link unavailable');
    return link;
  }

  async create(collectionId: string, input: CreateContributionLinkInput, actorId: string): Promise<{ link: ContributionLink; token: string }> {
    const collection = await this.owned(collectionId, actorId);
    const format = collection.formats.find((item) => item.id === input.formatId);
    if (!format || format.objectModel || format.workflow || format.appendOnly) throw new BadRequestException('Choose an ordinary data format without a state flow or register');
    if (!input.fieldIds.length || input.fieldIds.length > 30 || new Set(input.fieldIds).size !== input.fieldIds.length || input.fieldIds.some((id) => !format.fields.some((field) => field.id === id && supported.has(field.kind)))) throw new BadRequestException('Choose valid public fields');
    for (const value of [input.titleEn, input.titleFr, input.consentEn, input.consentFr]) {
      if (!value?.trim() || value.length > 2000) throw new BadRequestException('Information and consent text are required in English and French');
    }
    const expiresAt = new Date(input.expiresAt);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt <= new Date() || expiresAt.getTime() > Date.now() + 90 * 86400000) throw new BadRequestException('Expiry must be within 90 days');
    const token = secret();
    const link = await this.links.create({ collectionId, formatId: input.formatId, fieldIds: input.fieldIds, titleEn: input.titleEn.trim(), titleFr: input.titleFr.trim(), consentEn: input.consentEn.trim(), consentFr: input.consentFr.trim(), allowAnonymous: input.allowAnonymous, expiresAt, tokenHash: digest(token), rateWindowAt: new Date(), rateCount: 0 });
    return { link, token };
  }

  async list(collectionId: string, actorId: string): Promise<ContributionLink[]> {
    await this.owned(collectionId, actorId);
    return this.links.find({ collectionId }).sort({ createdAt: -1 }).limit(100).exec();
  }

  async revoke(id: string, actorId: string): Promise<ContributionLink> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Contribution link not found');
    const link = await this.links.findById(id).exec();
    if (!link) throw new NotFoundException('Contribution link not found');
    await this.owned(link.collectionId, actorId);
    return (await this.links.findOneAndUpdate({ _id: id, revokedAt: null }, { $set: { revokedAt: new Date() } }, { returnDocument: 'after' }).exec()) ?? link;
  }

  async form(token: string): Promise<PublicContributionForm> {
    const link = await this.live(token);
    const collection = await this.collections.findById(link.collectionId).exec();
    const format = collection?.formats.find((item) => item.id === link.formatId);
    if (!format) throw new NotFoundException('Contribution link unavailable');
    return { formatName: format.name, titleEn: link.titleEn, titleFr: link.titleFr, consentEn: link.consentEn, consentFr: link.consentFr, allowAnonymous: link.allowAnonymous, fields: link.fieldIds.flatMap((id) => {
      const field = format.fields.find((item) => item.id === id && supported.has(item.kind));
      return field ? [{ id: field.id, name: field.name, kind: field.kind, options: field.options }] : [];
    }) };
  }

  async submit(token: string, input: SubmitContributionInput): Promise<ContributionReceipt> {
    const link = await this.live(token);
    if (!input.consent) throw new BadRequestException('Consent is required');
    if (input.website) throw new BadRequestException('Submission rejected');
    if (JSON.stringify(input).length > 16384 || !input.values?.length || input.values.length > 30) throw new BadRequestException('Submission is too large or empty');
    const email = input.respondentEmail?.trim().toLowerCase();
    if ((!link.allowAnonymous && !email) || (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))) throw new BadRequestException('Valid contact email required');
    const now = new Date();
    const cutoff = new Date(now.getTime() - 60000);
    await this.links.updateOne({ _id: link.id, rateWindowAt: { $lte: cutoff } }, { $set: { rateWindowAt: now, rateCount: 0 } }).exec();
    const allowed = await this.links.findOneAndUpdate({ _id: link.id, revokedAt: null, expiresAt: { $gt: now }, rateWindowAt: { $gt: cutoff }, rateCount: { $lt: 10 } }, { $inc: { rateCount: 1 } }, { returnDocument: 'after' }).exec();
    if (!allowed) throw new HttpException('Too many submissions or link unavailable', 429);
    const collection = await this.collections.findById(link.collectionId).exec();
    const format = collection?.formats.find((item) => item.id === link.formatId);
    if (!collection || !format || input.values.some((item) => !link.fieldIds.includes(item.fieldId) || !format.fields.some((field) => field.id === item.fieldId && supported.has(field.kind)))) throw new BadRequestException('Invalid public field');
    const values = await this.collectionService.validateContributionValues(collection, link.formatId, input.values);
    const receipt = secret();
    const receivedAt = new Date();
    await this.submissions.create({ linkId: link.id, collectionId: link.collectionId, formatId: link.formatId, values, respondentEmail: email, status: 'PENDING', receivedAt, receiptHash: digest(receipt), events: [{ kind: 'RECEIVED', at: receivedAt }] });
    return { receipt, receivedAt };
  }

  async submissionsFor(collectionId: string, actorId: string): Promise<ContributionSubmission[]> {
    await this.owned(collectionId, actorId);
    return this.submissions.find({ collectionId }).sort({ receivedAt: -1 }).limit(200).exec();
  }

  async correct(id: string, values: EntryValueInput[], actorId: string): Promise<ContributionSubmission> {
    const submission = await this.submissions.findById(id).exec();
    if (!submission) throw new NotFoundException('Submission not found');
    const collection = await this.owned(submission.collectionId, actorId);
    const link = await this.links.findById(submission.linkId).exec();
    const format = collection.formats.find((item) => item.id === submission.formatId);
    if (!link || !format || values.some((item) => !link.fieldIds.includes(item.fieldId) || !format.fields.some((field) => field.id === item.fieldId && supported.has(field.kind))) || JSON.stringify(values).length > 16384) throw new BadRequestException('Invalid public field');
    const validated = await this.collectionService.validateContributionValues(collection, submission.formatId, values);
    const updated = await this.submissions.findOneAndUpdate({ _id: id, status: 'PENDING' }, { $set: { values: validated }, $push: { events: { kind: 'CORRECTED', at: new Date(), actorId } } }, { returnDocument: 'after' }).exec();
    if (!updated) throw new BadRequestException('Submission already reviewed');
    return updated;
  }

  async review(id: string, action: string, actorId: string, duplicateOf?: string): Promise<ContributionSubmission> {
    const submission = await this.submissions.findById(id).exec();
    if (!submission) throw new NotFoundException('Submission not found');
    const collection = await this.owned(submission.collectionId, actorId);
    if (action === 'ACCEPT') {
      if (submission.status === 'ACCEPTED') return submission;
      if (submission.status !== 'PENDING' && submission.status !== 'ACCEPTING') throw new BadRequestException('Submission already reviewed');
      if (submission.status === 'PENDING') {
        const claimed = await this.submissions.findOneAndUpdate({ _id: id, status: 'PENDING' }, { $set: { status: 'ACCEPTING' } }, { returnDocument: 'after' }).exec();
        if (!claimed) return this.review(id, action, actorId, duplicateOf);
      }
      const entry = await this.collectionService.createEntry(submission.collectionId, submission.values.map((item) => ({ fieldId: item.fieldId, value: item.value })), submission.formatId, collection.ownerId, `contribution-${id}`, { linkId: submission.linkId, receivedAt: submission.receivedAt });
      return (await this.submissions.findOneAndUpdate({ _id: id, status: 'ACCEPTING' }, { $set: { status: 'ACCEPTED', acceptedEntryId: entry.id }, $push: { events: { kind: 'ACCEPTED', at: new Date(), actorId } } }, { returnDocument: 'after' }).exec()) ?? await this.submissions.findById(id).exec() ?? submission;
    }
    if (action !== 'REJECT') throw new BadRequestException('Invalid review action');
    if (duplicateOf) {
      if (duplicateOf === id || !Types.ObjectId.isValid(duplicateOf) || !await this.submissions.exists({ _id: duplicateOf, collectionId: submission.collectionId })) throw new BadRequestException('Duplicate target not found');
    }
    const updated = await this.submissions.findOneAndUpdate({ _id: id, status: 'PENDING' }, { $set: { status: 'REJECTED', duplicateOf }, $push: { events: { kind: duplicateOf ? 'DUPLICATE_REJECTED' : 'REJECTED', at: new Date(), actorId } } }, { returnDocument: 'after' }).exec();
    if (!updated) throw new BadRequestException('Submission already reviewed');
    return updated;
  }

  async byReceipt(receipt: string): Promise<ContributionSubmission> {
    if (!validSecret(receipt)) throw new NotFoundException('Receipt not found');
    const submission = await this.submissions.findOne({ receiptHash: digest(receipt) }).exec();
    if (!submission) throw new NotFoundException('Receipt not found');
    return submission;
  }

  async exportByReceipt(receipt: string): Promise<RespondentContribution> {
    const submission = await this.byReceipt(receipt);
    return { status: submission.status, receivedAt: submission.receivedAt, respondentEmail: submission.respondentEmail, values: submission.values };
  }

  async erase(id: string, actorId?: string, receipt?: string): Promise<boolean> {
    const submission = receipt ? await this.byReceipt(receipt) : await this.submissions.findById(id).exec();
    if (!submission) throw new NotFoundException('Submission not found');
    if (submission.status === 'ACCEPTING') throw new BadRequestException('Submission is being accepted. Try again');
    const collection = await this.collections.findById(submission.collectionId).exec();
    if (!collection) throw new NotFoundException('Collection not found');
    if (actorId) await this.owned(submission.collectionId, actorId);
    else if (!receipt) throw new ForbiddenException('Receipt required');
    if (submission.acceptedEntryId) {
      const entryId = submission.acceptedEntryId;
      if (await this.entries.exists({ _id: entryId, collectionId: submission.collectionId, contributionLinkId: submission.linkId })) {
        await this.relations.detach(submission.collectionId, entryId, undefined, collection.ownerId);
        const removed = await this.relations.deleteEntry(entryId, collection.ownerId, () => this.collectionService.removeEntry(entryId, collection.ownerId));
        if (removed) await this.reminders.cancelEntry(entryId, collection.ownerId);
      }
      await this.relations.purgeContributionEntry(submission.collectionId, entryId, collection.ownerId);
      await this.entryLinks.purgeContributionEntry(entryId, collection.ownerId);
    }
    await this.submissions.deleteOne({ _id: submission.id }).exec();
    return true;
  }
}
