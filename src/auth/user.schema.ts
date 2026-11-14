import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

/** The view chosen in one collection. */
@ObjectType()
@Schema({ _id: false })
export class CollectionViewChoice {
  @Field() @Prop({ required: true }) collectionId!: string;
  @Field() @Prop({ required: true }) viewId!: string;
}
export const CollectionViewChoiceSchema = SchemaFactory.createForClass(CollectionViewChoice);

/** Where the person left Brainy: kept on the account, so every device reopens the same way. */
@ObjectType()
@Schema({ _id: false })
export class ViewPreferences {
  @Field({ nullable: true }) @Prop() lastCollectionId?: string;
  @Field(() => Int, { nullable: true }) @Prop() pageSize?: number;
  @Field(() => [CollectionViewChoice]) @Prop({ type: [CollectionViewChoiceSchema], default: [] }) views!: CollectionViewChoice[];
}
export const ViewPreferencesSchema = SchemaFactory.createForClass(ViewPreferences);

@ObjectType()
@Schema({ timestamps: true })
export class User {
  @Field(() => ID)
  id!: string;

  @Field()
  @Prop({ required: true, trim: true })
  name!: string;

  @Field()
  @Prop({ required: true, lowercase: true, trim: true, unique: true })
  email!: string;

  @Prop({ select: false })
  passwordHash?: string;

  @Prop({ unique: true, sparse: true })
  firebaseUid?: string;

  @Field({ nullable: true })
  @Prop({ trim: true })
  profession?: string;

  @Field({ nullable: true })
  @Prop({ trim: true })
  job?: string;

  @Field({ nullable: true })
  @Prop({ trim: true })
  fieldOfStudy?: string;

  @Field(() => [String])
  @Prop({ type: [String], default: [] })
  interests!: string[];

  @Field(() => [String])
  @Prop({ type: [String], default: [] })
  hobbies!: string[];

  @Field()
  @Prop({ default: false })
  profileCompleted!: boolean;

  /** Profile photo stored as a data URL (at most 1 MiB decoded); loaded only on request. */
  @Prop({ select: false })
  profilePhoto?: string;

  @Field()
  @Prop({ default: false })
  hasProfilePhoto!: boolean;

  /** T50: the welcome guide was finished or skipped (shown once per account, on every device). */
  @Field()
  @Prop({ default: false })
  onboardingCompleted!: boolean;

  @Field(() => ViewPreferences, { nullable: true })
  @Prop({ type: ViewPreferencesSchema })
  viewPreferences?: ViewPreferences;

  /** Set by the administrator: a blocked account can neither sign in nor use an open session. */
  @Prop({ default: false, index: true })
  blocked?: boolean;

  @Prop()
  blockedAt?: Date;

  /** Last request, kept to the hour: shown to the administrator only. */
  @Prop()
  lastActiveAt?: Date;

  createdAt?: Date;
}

export const UserSchema = SchemaFactory.createForClass(User);
