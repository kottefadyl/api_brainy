// T56: GraphQL for flash card reviews.
import { Args, Context, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service.js';
import { Collection } from './collection.schema.js';
import { CardDeckSummary, CardGradeValue, CardReviewOrder, CardReviewState, ReviewCard } from './flash-cards.schema.js';
import { FlashCardsService } from './flash-cards.service.js';
import { cleanOffset } from './card-progress.logic.js';

type Request = { headers: { authorization?: string } };

@Resolver()
export class FlashCardsResolver {
  constructor(private readonly service: FlashCardsService, private readonly auth: AuthService) {}
  private async user(request: Request): Promise<string> { return (await this.auth.currentUser(request.headers.authorization)).id; }

  @Query(() => [CardDeckSummary], { description: 'Per data format: cards, cards due now and cards never reviewed by me.' })
  async cardDecks(@Args('collectionId') collectionId: string, @Context('req') request: Request): Promise<CardDeckSummary[]> {
    return this.service.summary(collectionId, await this.user(request));
  }

  @Query(() => [ReviewCard])
  async cardReviewSession(
    @Args('collectionId') collectionId: string,
    @Args('formatId') formatId: string,
    @Args('count', { type: () => Int }) count: number,
    @Args('order', { type: () => CardReviewOrder }) order: CardReviewOrder,
    @Args('utcOffsetMinutes', { type: () => Int, nullable: true }) utcOffsetMinutes: number | null,
    @Context('req') request: Request,
  ): Promise<ReviewCard[]> {
    return this.service.session(collectionId, await this.user(request), formatId, count, order, cleanOffset(utcOffsetMinutes));
  }

  @Mutation(() => CardReviewState, { description: 'Records my answer to a card and schedules when it comes back.' })
  async gradeCard(@Args('collectionId') collectionId: string, @Args('entryId') entryId: string, @Args('grade', { type: () => CardGradeValue }) grade: CardGradeValue, @Args('utcOffsetMinutes', { type: () => Int, nullable: true }) utcOffsetMinutes: number | null, @Context('req') request: Request): Promise<CardReviewState> {
    return this.service.grade(collectionId, await this.user(request), entryId, grade, cleanOffset(utcOffsetMinutes));
  }

  @Mutation(() => Collection)
  async setCardSpeechLanguage(@Args('collectionId') collectionId: string, @Args('formatId') formatId: string, @Args('language', { type: () => String, nullable: true }) language: string | null, @Context('req') request: Request): Promise<Collection> {
    return this.service.setSpeechLanguage(collectionId, await this.user(request), formatId, language);
  }

  @Mutation(() => Boolean, { description: 'Forgets my review history in this collection; the cards stay.' })
  async resetCardReviews(@Args('collectionId') collectionId: string, @Context('req') request: Request): Promise<boolean> {
    return this.service.reset(collectionId, await this.user(request));
  }
}
