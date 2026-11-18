// T57: learning progress on two-sided cards — answer log, personal daily goal and statistics (per person).
import { Field, Float, Int, ObjectType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

const YEAR_SECONDS = 365 * 86_400;

/** One answer to one card. Compact, and removed automatically after a year. */
@Schema({ timestamps: false, versionKey: false })
export class CardAnswer {
  @Prop({ required: true }) userId!: string;
  @Prop({ required: true }) collectionId!: string;
  @Prop({ required: true }) formatId!: string;
  @Prop({ required: true }) entryId!: string;
  @Prop({ required: true }) grade!: string;
  /** First answer ever given by this person to this card. */
  @Prop({ required: true, default: false }) wasNew!: boolean;
  /** The person's local day (YYYY-MM-DD) when answering. */
  @Prop({ required: true }) day!: string;
  @Prop({ required: true }) at!: Date;
}
export const CardAnswerSchema = SchemaFactory.createForClass(CardAnswer);
CardAnswerSchema.index({ userId: 1, collectionId: 1, day: 1 });
CardAnswerSchema.index({ at: 1 }, { expireAfterSeconds: YEAR_SECONDS });

/** A person's daily goal in a collection of cards. */
@Schema({ timestamps: true })
@ObjectType()
export class CardGoal {
  @Prop({ required: true }) userId!: string;
  @Prop({ required: true }) collectionId!: string;
  @Field(() => Int, { nullable: true, description: 'Cards to review each day; empty = no goal.' }) @Prop({ type: Number, default: null }) reviewsPerDay?: number | null;
  @Field(() => Int, { nullable: true, description: 'Most new cards shown each day; empty = no limit.' }) @Prop({ type: Number, default: null }) newPerDay?: number | null;
}
export const CardGoalSchema = SchemaFactory.createForClass(CardGoal);
CardGoalSchema.index({ userId: 1, collectionId: 1 }, { unique: true });

@ObjectType()
export class CardDayCount {
  @Field() day!: string;
  @Field(() => Int) answers!: number;
  @Field(() => Int, { description: 'Answers other than Again.' }) remembered!: number;
}

@ObjectType()
export class CardHardest {
  @Field() entryId!: string;
  @Field() title!: string;
  @Field(() => Int) forgotten!: number;
}

@ObjectType()
export class CardToday {
  @Field(() => Int, { description: 'Different cards answered today.' }) reviewed!: number;
  @Field(() => Int, { description: 'New cards seen for the first time today.' }) newCards!: number;
  @Field(() => Int, { nullable: true }) goal?: number | null;
  @Field(() => Int, { nullable: true }) newLimit?: number | null;
  @Field(() => Int, { description: 'Days in a row with the goal reached (any review when there is no goal).' }) streak!: number;
}

@ObjectType()
export class CardStats {
  @Field(() => Int) total!: number;
  @Field(() => Int, { description: 'Never reviewed by this person.' }) fresh!: number;
  @Field(() => Int, { description: 'Reviewed, next review less than 21 days away.' }) learning!: number;
  @Field(() => Int, { description: 'Next review 21 days or more away.' }) mature!: number;
  @Field(() => Int) reviewed7!: number;
  @Field(() => Int) reviewed30!: number;
  @Field(() => Float, { nullable: true, description: 'Share of answers other than Again over 30 days (0 to 1).' }) successRate30?: number | null;
  @Field(() => [CardDayCount], { description: 'The last 30 days, oldest first.' }) days!: CardDayCount[];
  @Field(() => [Int], { description: 'Cards due on each of the next 7 days (today includes overdue cards).' }) forecast!: number[];
  @Field(() => [CardHardest]) hardest!: CardHardest[];
  @Field(() => CardToday) today!: CardToday;
}
