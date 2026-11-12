import { Field, ID, InputType, ObjectType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { EntryValue, EntryValueSchema } from './entry.schema.js';
import { EntryValueInput } from './collection.input.js';
import { FieldKind } from './collection.schema.js';

@ObjectType()
@Schema({ timestamps: true })
export class ContributionLink {
  @Field(() => ID) id!: string;
  @Field() @Prop({ required: true, index: true }) collectionId!: string;
  @Field() @Prop({ required: true }) formatId!: string;
  @Field(() => [String]) @Prop({ type: [String], required: true }) fieldIds!: string[];
  @Field() @Prop({ required: true }) titleEn!: string;
  @Field() @Prop({ required: true }) titleFr!: string;
  @Field() @Prop({ required: true }) consentEn!: string;
  @Field() @Prop({ required: true }) consentFr!: string;
  @Field() @Prop({ default: true }) allowAnonymous!: boolean;
  @Field() @Prop({ required: true }) expiresAt!: Date;
  @Field({ nullable: true }) @Prop() revokedAt?: Date;
  @Prop({ required: true, unique: true, index: true }) tokenHash!: string;
  @Prop({ default: 0 }) rateCount!: number;
  @Prop() rateWindowAt?: Date;
  @Field() createdAt!: Date;
}
export const ContributionLinkSchema = SchemaFactory.createForClass(ContributionLink);

@ObjectType()
@Schema({ _id: false })
export class ContributionEvent {
  @Field() @Prop({ required: true }) kind!: string;
  @Field() @Prop({ required: true }) at!: Date;
  @Field({ nullable: true }) @Prop() actorId?: string;
}
const ContributionEventSchema = SchemaFactory.createForClass(ContributionEvent);

@ObjectType()
@Schema({ timestamps: true })
export class ContributionSubmission {
  @Field(() => ID) id!: string;
  @Field() @Prop({ required: true, index: true }) linkId!: string;
  @Field() @Prop({ required: true, index: true }) collectionId!: string;
  @Field() @Prop({ required: true }) formatId!: string;
  @Field(() => [EntryValue]) @Prop({ type: [EntryValueSchema], required: true }) values!: EntryValue[];
  @Field({ nullable: true }) @Prop() respondentEmail?: string;
  @Field() @Prop({ required: true, enum: ['PENDING', 'ACCEPTING', 'ACCEPTED', 'REJECTED'] }) status!: string;
  @Field() @Prop({ required: true }) receivedAt!: Date;
  @Field({ nullable: true }) @Prop() acceptedEntryId?: string;
  @Field({ nullable: true }) @Prop() duplicateOf?: string;
  @Field(() => [ContributionEvent]) @Prop({ type: [ContributionEventSchema], default: [] }) events!: ContributionEvent[];
  @Prop({ required: true, unique: true, index: true }) receiptHash!: string;
}

export const ContributionSubmissionSchema = SchemaFactory.createForClass(ContributionSubmission);
ContributionSubmissionSchema.index({ collectionId: 1, receivedAt: -1 });

@ObjectType()
export class PublicContributionField {
  @Field() id!: string;
  @Field() name!: string;
  @Field(() => FieldKind) kind!: FieldKind;
  @Field(() => [String], { nullable: true }) options?: string[];
}

@ObjectType()
export class PublicContributionForm {
  @Field() formatName!: string;
  @Field() titleEn!: string;
  @Field() titleFr!: string;
  @Field() consentEn!: string;
  @Field() consentFr!: string;
  @Field() allowAnonymous!: boolean;
  @Field(() => [PublicContributionField]) fields!: PublicContributionField[];
}

@InputType()
export class CreateContributionLinkInput {
  @Field() formatId!: string;
  @Field(() => [String]) fieldIds!: string[];
  @Field() titleEn!: string;
  @Field() titleFr!: string;
  @Field() consentEn!: string;
  @Field() consentFr!: string;
  @Field() allowAnonymous!: boolean;
  @Field() expiresAt!: string;
}

@ObjectType()
export class CreatedContributionLink {
  @Field(() => ContributionLink) link!: ContributionLink;
  @Field() token!: string;
}

@InputType()
export class SubmitContributionInput {
  @Field(() => [EntryValueInput]) values!: EntryValueInput[];
  @Field() consent!: boolean;
  @Field({ nullable: true }) respondentEmail?: string;
  @Field({ nullable: true }) website?: string;
}

@ObjectType()
export class ContributionReceipt {
  @Field() receipt!: string;
  @Field() receivedAt!: Date;
}

@ObjectType()
export class RespondentContribution {
  @Field() status!: string;
  @Field() receivedAt!: Date;
  @Field({ nullable: true }) respondentEmail?: string;
  @Field(() => [EntryValue]) values!: EntryValue[];
}
