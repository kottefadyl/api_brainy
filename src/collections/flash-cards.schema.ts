// T56: review state of a flash card, per person (in a shared collection each learner has their own schedule).
import { Field, Float, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Entry } from './entry.schema.js';

export enum CardReviewOrder { DUE = 'DUE', OLDEST = 'OLDEST', NEWEST = 'NEWEST', RANDOM = 'RANDOM' }
registerEnumType(CardReviewOrder, { name: 'CardReviewOrder' });

export enum CardGradeValue { AGAIN = 'AGAIN', HARD = 'HARD', GOOD = 'GOOD', EASY = 'EASY' }
registerEnumType(CardGradeValue, { name: 'CardGrade' });

@Schema({ timestamps: true })
@ObjectType()
export class CardReviewState {
  @Prop({ required: true, index: true }) userId!: string;
  @Prop({ required: true, index: true }) collectionId!: string;
  @Field() @Prop({ required: true }) entryId!: string;
  @Field() @Prop({ required: true }) due!: Date;
  @Field(() => Int) @Prop({ required: true, default: 0 }) intervalDays!: number;
  @Field(() => Float) @Prop({ required: true, default: 2.5 }) ease!: number;
  @Field(() => Int) @Prop({ required: true, default: 0 }) reps!: number;
  @Field(() => Int) @Prop({ required: true, default: 0 }) lapses!: number;
  @Field({ nullable: true }) @Prop() lastGrade?: string;
  @Field({ nullable: true }) @Prop() lastReviewedAt?: Date;
}
export const CardReviewStateSchema = SchemaFactory.createForClass(CardReviewState);
CardReviewStateSchema.index({ userId: 1, entryId: 1 }, { unique: true });
CardReviewStateSchema.index({ userId: 1, collectionId: 1, due: 1 });

@ObjectType()
export class CardGradePreview {
  @Field(() => Int) again!: number;
  @Field(() => Int) hard!: number;
  @Field(() => Int) good!: number;
  @Field(() => Int) easy!: number;
}

@ObjectType()
export class ReviewCard {
  @Field(() => Entry) entry!: Entry;
  @Field(() => CardReviewState, { nullable: true }) state?: CardReviewState | null;
  /** Minutes until the card comes back for each answer, shown under the buttons. */
  @Field(() => CardGradePreview) preview!: CardGradePreview;
}

@ObjectType()
export class CardDeckSummary {
  @Field() formatId!: string;
  @Field(() => Int) total!: number;
  @Field(() => Int) due!: number;
  @Field(() => Int, { description: 'Cards never reviewed by this person.' }) fresh!: number;
}
