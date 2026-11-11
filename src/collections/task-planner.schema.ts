import { Field, ObjectType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Entry } from './entry.schema';

/** T49: which fields of the task data format drive the Day and Calendar views (Task list template only). */
@ObjectType()
@Schema({ _id: false })
export class TaskPlanner {
  @Field() @Prop({ required: true }) formatId!: string;
  @Field() @Prop({ required: true }) doneFieldId!: string;
  @Field() @Prop({ required: true }) startFieldId!: string;
  @Field() @Prop({ required: true }) endFieldId!: string;
  @Field() @Prop({ required: true }) repeatFieldId!: string;
  @Field() @Prop({ required: true }) intervalFieldId!: string;
  @Field() @Prop({ required: true }) weekdaysFieldId!: string;
  @Field({ nullable: true }) @Prop() completedFieldId?: string;
}
export const TaskPlannerSchema = SchemaFactory.createForClass(TaskPlanner);

@ObjectType()
export class TaskOccurrence {
  @Field() entryId!: string;
  @Field() date!: string;
  @Field() done!: boolean;
  @Field() overdue!: boolean;
  @Field() repeating!: boolean;
}

@ObjectType()
export class TaskAgenda {
  @Field(() => [TaskOccurrence]) occurrences!: TaskOccurrence[];
  @Field(() => [Entry]) entries!: Entry[];
}
