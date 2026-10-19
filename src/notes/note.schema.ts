import { Field, ID, ObjectType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type NoteDocument = HydratedDocument<Note>;

@ObjectType()
@Schema({ timestamps: true })
export class Note {
  @Field(() => ID)
  id!: string;

  @Field()
  @Prop({ required: true, trim: true })
  title!: string;

  @Field()
  @Prop({ required: true, trim: true })
  content!: string;

  @Prop({ required: true, index: true })
  ownerId!: string;
}

export const NoteSchema = SchemaFactory.createForClass(Note);
