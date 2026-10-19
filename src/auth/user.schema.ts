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
}

export const UserSchema = SchemaFactory.createForClass(User);
