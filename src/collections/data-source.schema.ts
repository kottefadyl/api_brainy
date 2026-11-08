// T32 — data sources (connectors) and their delivery runs.
import { Field, Float, ID, InputType, Int, ObjectType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@ObjectType()
@Schema({ _id: false })
export class DataSourceMapping {
  @Field() @Prop({ required: true }) column!: string;
  @Field() @Prop({ required: true }) fieldId!: string;
  @Field({ nullable: true }) @Prop() unitColumn?: string;
}
const DataSourceMappingSchema = SchemaFactory.createForClass(DataSourceMapping);

@ObjectType()
@Schema({ timestamps: true, collection: 'data_sources' })
export class DataSource {
  @Field(() => ID) id!: string;
  @Field() @Prop({ required: true, index: true }) collectionId!: string;
  @Prop({ required: true }) ownerId!: string;
  @Field() @Prop({ required: true }) name!: string;
  @Field() @Prop({ required: true }) formatId!: string;
  @Field(() => Int) @Prop({ default: 1 }) formatVersion!: number;
  @Field() @Prop({ required: true }) recordIdColumn!: string;
  @Field({ nullable: true }) @Prop() observedAtColumn?: string;
  @Field({ nullable: true }) @Prop() qualityColumn?: string;
  @Field({ nullable: true }) @Prop() statusColumn?: string;
  @Field() @Prop({ default: 'DOT' }) decimalSeparator!: string;
  @Field() @Prop({ default: ',' }) delimiter!: string;
  @Field() @Prop({ default: 'UPDATE' }) updatePolicy!: string;
  @Field(() => [DataSourceMapping]) @Prop({ type: [DataSourceMappingSchema], default: [] }) mappings!: DataSourceMapping[];
  @Prop({ index: true, sparse: true }) keyHash?: string;
  @Field({ nullable: true }) @Prop() keyHint?: string;
  @Field({ nullable: true }) @Prop() keyCreatedAt?: Date;
  @Prop() rateWindowAt?: Date;
  @Prop({ default: 0 }) rateCount!: number;
  @Field() @Prop() createdAt!: Date;
  @Field() @Prop() updatedAt!: Date;
}
export const DataSourceSchema = SchemaFactory.createForClass(DataSource);

@ObjectType()
@Schema({ _id: false })
export class DataSourceRejection {
  @Field(() => Int) @Prop({ required: true }) row!: number;
  @Field({ nullable: true }) @Prop() recordId?: string;
  @Field() @Prop({ required: true }) code!: string;
  @Field() @Prop({ required: true }) message!: string;
  @Field(() => [String]) @Prop({ type: [String], default: [] }) cells!: string[];
}
const DataSourceRejectionSchema = SchemaFactory.createForClass(DataSourceRejection);

@ObjectType()
@Schema({ timestamps: true, collection: 'data_source_runs' })
export class DataSourceRun {
  @Field(() => ID) id!: string;
  @Field() @Prop({ required: true, index: true }) sourceId!: string;
  @Field() @Prop({ required: true, index: true }) collectionId!: string;
  @Prop({ required: true }) ownerId!: string;
  @Field() @Prop({ required: true }) deliveryId!: string;
  @Field() @Prop({ required: true }) origin!: string;
  @Field({ nullable: true }) @Prop() actorId?: string;
  @Field() @Prop({ required: true }) contentType!: string;
  @Prop({ required: true }) content!: string;
  @Prop({ required: true }) contentHash!: string;
  @Field({ nullable: true }) @Prop() retryOf?: string;
  @Field() @Prop({ required: true, index: true }) state!: string;
  @Field(() => Int) @Prop({ default: 0 }) total!: number;
  @Field(() => Int) @Prop({ default: 0 }) processed!: number;
  @Field(() => Int) @Prop({ default: 0 }) createdCount!: number;
  @Field(() => Int) @Prop({ default: 0 }) updatedCount!: number;
  @Field(() => Int) @Prop({ default: 0 }) unchangedCount!: number;
  @Field(() => Int) @Prop({ default: 0 }) olderCount!: number;
  @Field(() => Int) @Prop({ default: 0 }) rejectedCount!: number;
  @Field(() => [String]) @Prop({ type: [String], default: [] }) ignoredColumns!: string[];
  @Field(() => [DataSourceRejection]) @Prop({ type: [DataSourceRejectionSchema], default: [] }) rejections!: DataSourceRejection[];
  @Field({ nullable: true }) @Prop() failure?: string;
  @Field() @Prop({ required: true }) receivedAt!: Date;
  @Field({ nullable: true }) @Prop() startedAt?: Date;
  @Field({ nullable: true }) @Prop() finishedAt?: Date;
  @Field(() => Int) @Prop({ default: 0 }) durationMs!: number;
  @Field(() => Float, { nullable: true }) @Prop() rowsPerSecond?: number;
  @Field(() => Int, { nullable: true }) @Prop() maxLagSeconds?: number;
  @Prop({ default: false }) cancelRequested!: boolean;
  @Prop() workerId?: string;
  @Prop() leaseUntil?: Date;
  @Prop() expiresAt?: Date;
  @Field() @Prop() createdAt!: Date;
  @Field() @Prop() updatedAt!: Date;
}
export const DataSourceRunSchema = SchemaFactory.createForClass(DataSourceRun);
DataSourceRunSchema.index({ sourceId: 1, deliveryId: 1 }, { unique: true });
DataSourceRunSchema.index({ state: 1, createdAt: 1 });
DataSourceRunSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

@ObjectType()
export class DataSourceKey {
  @Field(() => DataSource) source!: DataSource;
  @Field() key!: string;
}

@InputType()
export class DataSourceMappingInput {
  @Field() column!: string;
  @Field() fieldId!: string;
  @Field({ nullable: true }) unitColumn?: string;
}

@InputType()
export class DataSourceInput {
  @Field() name!: string;
  @Field() formatId!: string;
  @Field() recordIdColumn!: string;
  @Field({ nullable: true }) observedAtColumn?: string;
  @Field({ nullable: true }) qualityColumn?: string;
  @Field({ nullable: true }) statusColumn?: string;
  @Field({ defaultValue: 'DOT' }) decimalSeparator!: string;
  @Field({ defaultValue: ',' }) delimiter!: string;
  @Field({ defaultValue: 'UPDATE' }) updatePolicy!: string;
  @Field(() => [DataSourceMappingInput]) mappings!: DataSourceMappingInput[];
}
