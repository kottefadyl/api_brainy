// T57: learning progress on two-sided cards, per person — answer log, daily goal and statistics computed on demand
// (no background work: compatible with Vercel Hobby). Access is checked by FlashCardsService.access().
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Collection } from './collection.schema.js';
import { Entry } from './entry.schema.js';
import { CardReviewState } from './flash-cards.schema.js';
import { CardAnswer, CardGoal, CardStats } from './card-progress.schema.js';
import { MATURE_DAYS, dueForecast, goalValue, localDay, newAllowance, shiftDay, streak } from './card-progress.logic.js';

@Injectable()
export class CardProgressService {
  constructor(
    @InjectModel(CardAnswer.name) private readonly answers: Model<CardAnswer>,
    @InjectModel(CardGoal.name) private readonly goals: Model<CardGoal>,
    @InjectModel(CardReviewState.name) private readonly states: Model<CardReviewState>,
    @InjectModel(Entry.name) private readonly entries: Model<Entry>,
  ) {}

  async record(input: { userId: string; collectionId: string; formatId: string; entryId: string; grade: string; wasNew: boolean; at: Date; offset: number }): Promise<void> {
    await this.answers.create({ ...input, day: localDay(input.at, input.offset) });
  }

  async goal(collectionId: string, userId: string): Promise<CardGoal> {
    return (await this.goals.findOne({ userId, collectionId }).lean().exec()) ?? { userId, collectionId, reviewsPerDay: null, newPerDay: null };
  }

  async setGoal(collectionId: string, userId: string, reviewsPerDay: number | null, newPerDay: number | null): Promise<CardGoal> {
    let reviews: number | null, fresh: number | null;
    try { reviews = goalValue(reviewsPerDay, 'Cards per day'); fresh = goalValue(newPerDay, 'New cards per day'); }
    catch (error) { throw new BadRequestException((error as Error).message); }
    return (await this.goals.findOneAndUpdate({ userId, collectionId }, { $set: { reviewsPerDay: reviews, newPerDay: fresh } }, { upsert: true, returnDocument: 'after' }).lean().exec())!;
  }

  /** New cards a "due then new" session may still show today (null = no limit). */
  async newCardsLeft(collectionId: string, userId: string, offset: number, now = new Date()): Promise<number | null> {
    const goal = await this.goal(collectionId, userId);
    if (goal.newPerDay == null) return null;
    const seen = await this.answers.countDocuments({ userId, collectionId, day: localDay(now, offset), wasNew: true }).exec();
    return newAllowance(goal.newPerDay, seen);
  }

  async stats(collection: Collection & { id: string }, userId: string, formatId: string | null, offset: number, now = new Date()): Promise<CardStats> {
    const collectionId = collection.id;
    const today = localDay(now, offset);
    const since30 = shiftDay(today, -29);
    const scope = formatId ? { formatId } : {};
    const [cards, goal] = await Promise.all([
      this.entries.find({ collectionId, ...scope, movingOperationId: null }).select('_id').limit(5000).lean().exec(),
      this.goal(collectionId, userId),
    ]);
    const ids = cards.map((card) => String(card._id));
    const [states, recent, perDay, todayRows, forgotten] = await Promise.all([
      this.states.find({ userId, collectionId, entryId: { $in: ids } }).select('entryId due intervalDays').lean().exec(),
      this.answers.aggregate<{ _id: string; answers: number; remembered: number }>([
        { $match: { userId, collectionId, ...scope, day: { $gte: since30 } } },
        { $group: { _id: '$day', answers: { $sum: 1 }, remembered: { $sum: { $cond: [{ $eq: ['$grade', 'AGAIN'] }, 0, 1] } } } },
      ]).exec(),
      // Different cards per day over the year, for the streak (the goal is for the whole collection).
      this.answers.aggregate<{ _id: string; cards: number }>([
        { $match: { userId, collectionId } },
        { $group: { _id: { day: '$day', entryId: '$entryId' } } },
        { $group: { _id: '$_id.day', cards: { $sum: 1 } } },
      ]).exec(),
      this.answers.aggregate<{ _id: null; cards: string[]; fresh: number }>([
        { $match: { userId, collectionId, day: today } },
        { $group: { _id: null, cards: { $addToSet: '$entryId' }, fresh: { $sum: { $cond: ['$wasNew', 1, 0] } } } },
      ]).exec(),
      this.answers.aggregate<{ _id: string; forgotten: number }>([
        { $match: { userId, collectionId, ...scope, grade: 'AGAIN', entryId: { $in: ids } } },
        { $group: { _id: '$entryId', forgotten: { $sum: 1 } } },
        { $sort: { forgotten: -1 } },
        { $limit: 5 },
      ]).exec(),
    ]);
    const byDay = new Map(recent.map((row) => [row._id, row]));
    const days = Array.from({ length: 30 }, (_, index) => {
      const day = shiftDay(since30, index);
      return { day, answers: byDay.get(day)?.answers ?? 0, remembered: byDay.get(day)?.remembered ?? 0 };
    });
    const sum = (from: number, key: 'answers' | 'remembered') => days.slice(from).reduce((total, row) => total + row[key], 0);
    const answers30 = sum(0, 'answers');
    const mature = states.filter((state) => state.intervalDays >= MATURE_DAYS).length;
    const titles = await this.titles(collection, forgotten.map((row) => row._id));
    return {
      total: ids.length,
      fresh: Math.max(0, ids.length - states.length),
      learning: states.length - mature,
      mature,
      reviewed7: sum(23, 'answers'),
      reviewed30: answers30,
      successRate30: answers30 ? sum(0, 'remembered') / answers30 : null,
      days,
      forecast: dueForecast(states.map((state) => state.due), now, offset),
      hardest: forgotten.map((row) => ({ entryId: row._id, forgotten: row.forgotten, title: titles.get(row._id) ?? '—' })),
      today: {
        reviewed: todayRows[0]?.cards.length ?? 0,
        newCards: todayRows[0]?.fresh ?? 0,
        goal: goal.reviewsPerDay ?? null,
        newLimit: goal.newPerDay ?? null,
        streak: streak(new Map(perDay.map((row) => [row._id, row.cards])), today, goal.reviewsPerDay),
      },
    };
  }

  /** A readable name for each card: its title field, otherwise its first filled value. */
  private async titles(collection: Collection, entryIds: string[]): Promise<Map<string, string>> {
    const valid = entryIds.filter((id) => Types.ObjectId.isValid(id));
    if (!valid.length) return new Map();
    const found = await this.entries.find({ _id: { $in: valid }, collectionId: (collection as Collection & { id: string }).id }).select('_id formatId values').lean().exec();
    return new Map(found.map((entry) => {
      const format = collection.formats.find((item) => item.id === entry.formatId);
      const titleField = format?.fields.find((field) => field.kind === 'TITLE');
      const values = (entry.values ?? []) as { fieldId: string; value: string }[];
      const value = values.find((item) => item.fieldId === titleField?.id && item.value?.trim()) ?? values.find((item) => item.value?.trim());
      return [String(entry._id), (value?.value ?? '—').slice(0, 120)];
    }));
  }

  async reset(collectionId: string, userId: string): Promise<void> {
    await this.answers.deleteMany({ userId, collectionId }).exec();
  }
}
