import { Field, ID, InputType, Int, ObjectType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { CollectionRole } from './collaboration.schema';

@ObjectType()
@Schema({ _id: false })
export class WorkflowTransition {
  @Field() @Prop({ required: true }) from!: string;
  @Field() @Prop({ required: true }) to!: string;
  @Field(() => CollectionRole) @Prop({ required: true, enum: Object.values(CollectionRole) }) minimumRole!: CollectionRole;
}
export const WorkflowTransitionSchema = SchemaFactory.createForClass(WorkflowTransition);

@ObjectType()
@Schema({ _id: false })
export class WorkflowRequirement {
  @Field() @Prop({ required: true }) state!: string;
  @Field(() => [String]) @Prop({ type: [String], default: [] }) fieldIds!: string[];
}
export const WorkflowRequirementSchema = SchemaFactory.createForClass(WorkflowRequirement);

@ObjectType()
@Schema({ _id: false })
export class WorkflowDefinition {
  @Field() @Prop({ required: true }) stateFieldId!: string;
  @Field() @Prop({ required: true }) initialState!: string;
  @Field(() => [WorkflowTransition]) @Prop({ type: [WorkflowTransitionSchema], default: [] }) transitions!: WorkflowTransition[];
  @Field(() => [WorkflowRequirement]) @Prop({ type: [WorkflowRequirementSchema], default: [] }) requirements!: WorkflowRequirement[];
}
export const WorkflowDefinitionSchema = SchemaFactory.createForClass(WorkflowDefinition);

@ObjectType()
@Schema({ _id: false })
export class WorkflowEvent {
  @Field() @Prop({ required: true }) kind!: string;
  @Field() @Prop({ required: true }) from!: string;
  @Field() @Prop({ required: true }) to!: string;
  @Field() @Prop({ required: true }) actorUserId!: string;
  @Field() @Prop({ required: true }) at!: Date;
  @Field({ nullable: true }) @Prop() assigneeUserId?: string;
  @Field({ nullable: true }) @Prop() dueAt?: Date;
}
export const WorkflowEventSchema = SchemaFactory.createForClass(WorkflowEvent);

@ObjectType()
@Schema({ _id: false })
export class EntryWorkflow {
  @Field({ nullable: true }) @Prop({ index: true }) assigneeUserId?: string;
  @Field({ nullable: true }) @Prop() dueAt?: Date;
  @Field(() => Int, { nullable: true }) @Prop() reminderMinutesBefore?: number;
  @Field(() => [WorkflowEvent]) @Prop({ type: [WorkflowEventSchema], default: [] }) history!: WorkflowEvent[];
}
export const EntryWorkflowSchema = SchemaFactory.createForClass(EntryWorkflow);

@InputType()
export class WorkflowTransitionInput {
  @Field() from!: string;
  @Field() to!: string;
  @Field(() => CollectionRole) minimumRole!: CollectionRole;
}

@InputType()
export class WorkflowRequirementInput {
  @Field() state!: string;
  @Field(() => [String]) fieldIds!: string[];
}

@InputType()
export class WorkflowDefinitionInput {
  @Field() stateFieldId!: string;
  @Field() initialState!: string;
  @Field(() => [WorkflowTransitionInput]) transitions!: WorkflowTransitionInput[];
  @Field(() => [WorkflowRequirementInput]) requirements!: WorkflowRequirementInput[];
  @Field(() => Int) expectedVersion!: number;
}

@InputType()
export class WorkflowAssignmentInput {
  @Field({ nullable: true }) assigneeUserId?: string;
  @Field({ nullable: true }) dueAt?: string;
  @Field(() => Int, { nullable: true }) reminderMinutesBefore?: number;
  @Field() expectedUpdatedAt!: string;
}

@InputType()
export class WorkflowEventImportInput {
  @Field() kind!: string;
  @Field() from!: string;
  @Field() to!: string;
  @Field() actorUserId!: string;
  @Field() at!: string;
  @Field({ nullable: true }) assigneeUserId?: string;
  @Field({ nullable: true }) dueAt?: string;
}

@ObjectType()
@Schema({ timestamps: true })
export class WorkflowNotification {
  @Field(() => ID) id!: string;
  @Field() @Prop({ required: true, index: true }) recipientUserId!: string;
  @Field() @Prop({ required: true }) collectionId!: string;
  @Field() @Prop({ required: true }) entryId!: string;
  @Field() @Prop({ required: true }) kind!: string;
  @Field() @Prop({ required: true }) actorUserId!: string;
  @Field() @Prop({ default: Date.now }) createdAt!: Date;
  @Field({ nullable: true }) @Prop() readAt?: Date;
}
export const WorkflowNotificationSchema = SchemaFactory.createForClass(WorkflowNotification);
WorkflowNotificationSchema.index({ recipientUserId: 1, createdAt: -1 });
