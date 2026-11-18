// T57: GraphQL for learning progress on two-sided cards (statistics and daily goal, per person).
import { Args, Context, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service.js';
import { CardGoal, CardStats } from './card-progress.schema.js';
import { CardProgressService } from './card-progress.service.js';
import { cleanOffset } from './card-progress.logic.js';
import { FlashCardsService } from './flash-cards.service.js';

type Request = { headers: { authorization?: string } };

@Resolver()
export class CardProgressResolver {
  constructor(private readonly progress: CardProgressService, private readonly cards: FlashCardsService, private readonly auth: AuthService) {}
  private async user(request: Request): Promise<string> { return (await this.auth.currentUser(request.headers.authorization)).id; }

  @Query(() => CardStats, { description: 'My learning progress in a collection of cards, or in one data format of it.' })
  async cardStats(
    @Args('collectionId') collectionId: string,
    @Args('formatId', { type: () => String, nullable: true }) formatId: string | null,
    @Args('utcOffsetMinutes', { type: () => Int, nullable: true, description: 'Minutes east of UTC, for my own days.' }) utcOffsetMinutes: number | null,
    @Context('req') request: Request,
  ): Promise<CardStats> {
    const userId = await this.user(request);
    const { collection } = await this.cards.access(collectionId, userId);
    if (formatId && !collection.formats.some((format) => format.id === formatId)) formatId = null;
    return this.progress.stats(collection as never, userId, formatId, cleanOffset(utcOffsetMinutes));
  }

  @Mutation(() => CardGoal, { description: 'My daily goal in a collection of cards; empty values remove it.' })
  async setCardGoal(
    @Args('collectionId') collectionId: string,
    @Args('reviewsPerDay', { type: () => Int, nullable: true }) reviewsPerDay: number | null,
    @Args('newPerDay', { type: () => Int, nullable: true }) newPerDay: number | null,
    @Context('req') request: Request,
  ): Promise<CardGoal> {
    const userId = await this.user(request);
    const { collection } = await this.cards.access(collectionId, userId);
    return this.progress.setGoal(collection.id, userId, reviewsPerDay, newPerDay);
  }
}
