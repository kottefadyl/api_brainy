import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@ObjectType()
@Schema({ _id: false })
export class BackgroundJobLog {
  @Field(() => Int) @Prop({ required: true }) row!: number;
  @Field() @Prop({ required: true }) message!: string;
}
const BackgroundJobLogSchema = SchemaFactory.createForClass(BackgroundJobLog);

@ObjectType()
@Schema({ timestamps: true, collection: 'background_jobs' })
export class BackgroundJob {
  @Field(() => ID) id!: string;
  @Prop({ required: true, index: true }) ownerId!: string;
  @Field() @Prop({ required: true, index: true }) collectionId!: string;
  @Field() @Prop({ required: true }) requestKey!: string;
  @Field() @Prop({ required: true }) kind!: string;
  @Field() @Prop({ required: true, index: true }) state!: string;
  @Prop({ required: true }) payload!: string;
  @Field(() => Int) @Prop({ default: 0 }) total!: number;
  @Field(() => Int) @Prop({ default: 0 }) processed!: number;
  @Field(() => Int) @Prop({ default: 0 }) createdCount!: number;
  @Field(() => Int) @Prop({ default: 0 }) skippedCount!: number;
  @Field(() => Int) @Prop({ default: 0 }) errorCount!: number;
  @Field(() => [BackgroundJobLog]) @Prop({ type: [BackgroundJobLogSchema], default: [] }) logs!: BackgroundJobLog[];
  @Field({ nullable: true }) @Prop() result?: string;
  @Field({ nullable: true }) @Prop() failure?: string;
  @Prop({ default: false }) cancelRequested!: boolean;
  @Prop() workerId?: string;
  @Prop() leaseUntil?: Date;
  @Prop() expiresAt?: Date;
  @Field() @Prop() createdAt!: Date;
  @Field() @Prop() updatedAt!: Date;
}

export const BackgroundJobSchema = SchemaFactory.createForClass(BackgroundJob);
BackgroundJobSchema.index({ ownerId: 1, collectionId: 1, requestKey: 1 }, { unique: true });
BackgroundJobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
