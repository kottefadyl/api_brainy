import { Field, ID, ObjectType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

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
}

export const UserSchema = SchemaFactory.createForClass(User);
