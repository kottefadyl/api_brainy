import { Field, ObjectType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema()
export class LedgerHead {
  @Prop({ required: true }) ownerId!: string;
  @Prop({ required: true }) collectionId!: string;
  @Prop({ required: true }) formatId!: string;
  @Prop({ required: true, default: 0 }) count!: number;
  @Prop({ required: true, default: '' }) hash!: string;
  @Prop({ required: true, default: 0 }) redactionCount!: number;
  @Prop({ required: true, default: '' }) redactionHash!: string;
  @Prop({ required: true, default: new Date(0) }) lockedUntil!: Date;
  @Prop() token?: string;
}
export const LedgerHeadSchema = SchemaFactory.createForClass(LedgerHead);
LedgerHeadSchema.index({ ownerId: 1, collectionId: 1, formatId: 1 }, { unique: true });

@Schema()
export class LedgerRedaction {
  @Prop({ required: true }) ownerId!: string;
  @Prop({ required: true }) collectionId!: string;
  @Prop({ required: true }) formatId!: string;
  @Prop({ required: true }) entryId!: string;
  @Prop({ required: true }) sequence!: number;
  @Prop({ required: true }) fieldIds!: string[];
  @Prop({ required: true }) actorId!: string;
  @Prop({ required: true }) reason!: string;
  @Prop({ required: true }) at!: Date;
  @Prop({ default: '' }) previousHash!: string;
  @Prop({ required: true }) hash!: string;
}
export const LedgerRedactionSchema = SchemaFactory.createForClass(LedgerRedaction);
LedgerRedactionSchema.index({ ownerId: 1, collectionId: 1, formatId: 1, sequence: 1 }, { unique: true });

@ObjectType()
export class LedgerIntegrity {
  @Field() valid!: boolean;
  @Field() checked!: number;
  @Field() headHash!: string;
  @Field() redactionHash!: string;
  @Field({ nullable: true }) problem?: string;
}
