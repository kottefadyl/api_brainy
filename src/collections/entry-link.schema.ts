import { Field, ID, ObjectType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@ObjectType()
@Schema({ timestamps: true })
export class EntryLink {
  @Field(() => ID) id!: string;
  @Field() @Prop({ required: true, index: true }) ownerId!: string;
  @Field() @Prop({ required: true, index: true }) collectionId!: string;
  @Field() @Prop({ required: true, index: true }) fromEntryId!: string;
  @Field() @Prop({ required: true, index: true }) toEntryId!: string;
  @Field() @Prop({ default: '' }) label!: string;
  @Field() @Prop({ default: Date.now }) createdAt!: Date;
  @Field({ nullable: true }) @Prop() deletedAt?: Date;
}

export const EntryLinkSchema = SchemaFactory.createForClass(EntryLink);
EntryLinkSchema.index({ ownerId: 1, collectionId: 1, fromEntryId: 1, toEntryId: 1 }, { unique: true });
