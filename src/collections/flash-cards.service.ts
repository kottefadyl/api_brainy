// T56: flash cards — review sessions and per-person spaced repetition, only in Flash cards collections.
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CollaborationService } from './collaboration.service.js';
import { CollectionRole } from './collaboration.schema.js';
import { Collection } from './collection.schema.js';
import { CollectionsService } from './collections.service.js';
import { Entry } from './entry.schema.js';
import { CardDeckSummary, CardReviewOrder, CardReviewState, ReviewCard } from './flash-cards.schema.js';
import { type CardGrade, nextReview, previewMinutes, shuffled } from './flash-cards.logic.js';

export const FLASH_CARDS_TEMPLATE = 'cards';
const MAX_SESSION = 200;
const MAX_DECK = 5000;

@Injectable()
export class FlashCardsService {
  constructor(
    private readonly collections: CollectionsService,
    private readonly collaboration: CollaborationService,
    @InjectModel(Collection.name) private readonly collectionModel: Model<Collection>,
    @InjectModel(Entry.name) private readonly entries: Model<Entry>,
    @InjectModel(CardReviewState.name) private readonly states: Model<CardReviewState>,
  ) {}

  /** Any member can review (it changes only their own schedule, never the entries). */
  private async context(collectionId: string, userId: string) {
    if (!Types.ObjectId.isValid(collectionId)) throw new NotFoundException('Collection not found');
    const collection = await this.collections.one(collectionId, userId);
    const { member } = this.collaboration.checkAccess(collection, userId, CollectionRole.READER);
    if (collection.templateId !== FLASH_CARDS_TEMPLATE) throw new BadRequestException('Card review exists only in Flash cards collections');
    return { collection, member };
  }

  private deck(collectionId: string, formatId?: string) {
    return this.entries.find({ collectionId, ...(formatId ? { formatId } : {}), movingOperationId: null }).sort({ createdAt: 1 }).limit(MAX_DECK);
  }

  async summary(collectionId: string, userId: string): Promise<CardDeckSummary[]> {
    const { collection } = await this.context(collectionId, userId);
    const now = new Date();
    const [counts, reviewed] = await Promise.all([
      this.entries.aggregate<{ _id: string; total: number }>([{ $match: { collectionId: collection.id, movingOperationId: null } }, { $group: { _id: '$formatId', total: { $sum: 1 } } }]).exec(),
      this.states.find({ userId, collectionId: collection.id }).select('entryId due').lean().exec(),
    ]);
    const formatOf = new Map((await this.entries.find({ collectionId: collection.id, _id: { $in: reviewed.map((item) => item.entryId).filter((id) => Types.ObjectId.isValid(id)) } }).select('_id formatId').lean().exec()).map((entry) => [String(entry._id), entry.formatId]));
    return collection.formats.map((format) => {
      const mine = reviewed.filter((item) => formatOf.get(item.entryId) === format.id);
      const total = counts.find((item) => item._id === format.id)?.total ?? 0;
      return { formatId: format.id, total, due: mine.filter((item) => item.due <= now).length, fresh: Math.max(0, total - mine.length) };
    });
  }

  async session(collectionId: string, userId: string, formatId: string, count: number, order: CardReviewOrder): Promise<ReviewCard[]> {
    const { collection, member } = await this.context(collectionId, userId);
    if (!collection.formats.some((format) => format.id === formatId)) throw new NotFoundException('Data format not found in this collection');
    if (!Number.isInteger(count) || count < 1 || count > MAX_SESSION) throw new BadRequestException(`Choose 1 to ${MAX_SESSION} cards`);
    const cards = await this.deck(collection.id, formatId).exec();
    const states = new Map((await this.states.find({ userId, entryId: { $in: cards.map((card) => card.id) } }).exec()).map((state) => [state.entryId, state]));
    const now = new Date();
    let picked: Entry[];
    if (order === CardReviewOrder.DUE) {
      // Cards due now (most overdue first), then cards never reviewed (oldest first).
      const due = cards.filter((card) => { const state = states.get(card.id); return state && state.due <= now; }).sort((a, b) => states.get(a.id)!.due.getTime() - states.get(b.id)!.due.getTime());
      const fresh = cards.filter((card) => !states.has(card.id));
      picked = [...due, ...fresh].slice(0, count);
    } else if (order === CardReviewOrder.RANDOM) picked = shuffled(cards).slice(0, count);
    else picked = (order === CardReviewOrder.NEWEST ? [...cards].reverse() : cards).slice(0, count);
    return picked.map((card) => {
      const state = states.get(card.id) ?? null;
      const minutes = previewMinutes(state);
      return { entry: this.collaboration.filterEntryFields(card, member, collection), state, preview: { again: minutes.AGAIN, hard: minutes.HARD, good: minutes.GOOD, easy: minutes.EASY } };
    });
  }

  async grade(collectionId: string, userId: string, entryId: string, grade: CardGrade): Promise<CardReviewState> {
    const { collection } = await this.context(collectionId, userId);
    if (!Types.ObjectId.isValid(entryId) || !(await this.entries.exists({ _id: entryId, collectionId: collection.id }))) throw new NotFoundException('Card not found');
    const previous = await this.states.findOne({ userId, entryId }).exec();
    const now = new Date();
    const next = nextReview(previous, grade, now);
    return (await this.states.findOneAndUpdate(
      { userId, entryId },
      { $set: { collectionId: collection.id, due: next.due, intervalDays: next.intervalDays, ease: next.ease, reps: next.reps, lapses: next.lapses, lastGrade: grade, lastReviewedAt: now } },
      { upsert: true, returnDocument: 'after' },
    ).exec())!;
  }

  /** Language read aloud on the cards of a data format (owner only). */
  async setSpeechLanguage(collectionId: string, userId: string, formatId: string, language: string | null): Promise<Collection> {
    const { collection } = await this.context(collectionId, userId);
    this.collaboration.checkAccess(collection, userId, CollectionRole.OWNER);
    if (language && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(language)) throw new BadRequestException('Choose a language such as en-GB or fr-FR');
    const updated = await this.collectionModel.findOneAndUpdate({ _id: collection.id, 'formats.id': formatId }, language ? { $set: { 'formats.$.speechLanguage': language } } : { $unset: { 'formats.$.speechLanguage': '' } }, { returnDocument: 'after' }).exec();
    if (!updated) throw new NotFoundException('Data format not found in this collection');
    return updated;
  }

  /** Forgets this person's review history of a collection (entries stay). */
  async reset(collectionId: string, userId: string): Promise<boolean> {
    const { collection } = await this.context(collectionId, userId);
    await this.states.deleteMany({ userId, collectionId: collection.id }).exec();
    return true;
  }
}
