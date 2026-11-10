import { Field, ID, ObjectType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@ObjectType()
@Schema({ timestamps: true })
export class EntryReminder {
  @Field(() => ID) id!: string;
  @Field() @Prop({ required: true, index: true }) ownerId!: string;
  @Prop({ index: true }) recipientUserId?: string;
  @Field() @Prop({ required: true, index: true }) collectionId!: string;
  @Field() @Prop({ required: true, index: true }) entryId!: string;
  @Field() @Prop({ required: true }) fieldId!: string;
  @Prop() workflowKind?: string;
  @Field({ nullable: true }) @Prop() viewId?: string;
  @Field() @Prop({ required: true }) timeZone!: string;
  @Field({ nullable: true }) @Prop() timeOfDay?: string;
  @Field() @Prop({ required: true, min: 0, max: 43200 }) minutesBefore!: number;
  @Field(() => [String]) @Prop({ type: [String], required: true }) channels!: string[];
  @Field() @Prop({ required: true, enum: ['ACTIVE', 'DONE', 'CANCELLED', 'FAILED'] }) state!: string;
  @Field({ nullable: true }) @Prop({ index: true }) nextAt?: Date;
  @Field({ nullable: true }) @Prop() occurrenceAt?: Date;
  @Field({ nullable: true }) @Prop() lockedUntil?: Date;
  @Prop() lockToken?: string;
  @Field() @Prop({ default: 0 }) attempts!: number;
  @Field({ nullable: true }) @Prop() failure?: string;
  @Field() createdAt!: Date;
  @Field() updatedAt!: Date;
}
export const EntryReminderSchema = SchemaFactory.createForClass(EntryReminder);
EntryReminderSchema.index({ ownerId: 1, entryId: 1, fieldId: 1 }, { unique: true, partialFilterExpression: { state: 'ACTIVE' } });
EntryReminderSchema.index({ state: 1, nextAt: 1, lockedUntil: 1 });

@Schema({ timestamps: true })
export class ReminderDelivery {
  @Prop({ required: true, unique: true }) key!: string;
  @Prop({ required: true }) reminderId!: string;
  @Prop({ required: true }) ownerId!: string;
  @Prop({ required: true }) channel!: string;
  @Prop({ required: true, enum: ['PENDING', 'SENDING', 'SENT', 'FAILED'] }) state!: string;
  @Prop() claimUntil?: Date;
  @Prop() failure?: string;
  @Prop() sentAt?: Date;
}
export const ReminderDeliverySchema = SchemaFactory.createForClass(ReminderDelivery);

@ObjectType()
@Schema({ timestamps: true })
export class PushDevice {
  @Field(() => ID) id!: string;
  @Prop({ required: true, index: true }) ownerId!: string;
  @Prop({ required: true, unique: true }) token!: string;
  @Field() @Prop({ default: 'TOKEN' }) targetKind!: string;
  @Field() @Prop({ required: true }) platform!: string;
  @Field() @Prop({ required: true }) label!: string;
  @Field() @Prop({ required: true }) lastSeenAt!: Date;
}
export const PushDeviceSchema = SchemaFactory.createForClass(PushDevice);
// FCM treats tokens unused for 270 days as expired; clients refresh lastSeenAt at each sign-in.
PushDeviceSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 270 * 24 * 60 * 60 });

@ObjectType()
export class ReminderCapabilities {
  @Field() email!: boolean;
  @Field() push!: boolean;
}
