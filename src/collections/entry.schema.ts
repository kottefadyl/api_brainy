import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { UnitSnapshot, UnitSnapshotSchema } from './unit.schema.js';
import { EntryWorkflow, EntryWorkflowSchema } from './workflow.schema.js';

@ObjectType()
@Schema({ _id: false })
export class ObjectPropertySnapshot {
  @Field() @Prop({ required: true }) fieldId!: string;
  @Field() @Prop({ required: true }) name!: string;
  @Field() @Prop({ required: true }) kind!: string;
  @Field() @Prop({ required: true }) value!: string;
  @Field(() => UnitSnapshot, { nullable: true })
  @Prop({ type: UnitSnapshotSchema }) unitSnapshot?: UnitSnapshot;
}
export const ObjectPropertySnapshotSchema = SchemaFactory.createForClass(ObjectPropertySnapshot);

@ObjectType()
@Schema({ _id: false })
export class ObjectReferenceSnapshot {
  @Field() @Prop({ required: true }) objectId!: string;
  @Field() @Prop({ required: true }) formatId!: string;
  @Field() @Prop({ required: true }) formatVersion!: number;
  @Field() @Prop({ required: true }) capturedAt!: Date;
  @Field(() => [ObjectPropertySnapshot])
  @Prop({ type: [ObjectPropertySnapshotSchema], required: true })
  properties!: ObjectPropertySnapshot[];
}
export const ObjectReferenceSnapshotSchema = SchemaFactory.createForClass(ObjectReferenceSnapshot);

@ObjectType()
export class ResolvedObjectReference {
  @Field() objectId!: string;
  @Field() fieldId!: string;
  @Field() mode!: string;
  @Field() missing!: boolean;
  @Field({ nullable: true }) name?: string;
  @Field({ nullable: true }) capturedAt?: Date;
  @Field(() => [ObjectPropertySnapshot]) properties!: ObjectPropertySnapshot[];
}

@ObjectType()
export class ResolvedObjectVariable {
  @Field() variableName!: string;
  @Field() objectId!: string;
  @Field() mode!: string;
  @Field({ nullable: true }) capturedAt?: Date;
  @Field(() => ObjectPropertySnapshot) property!: ObjectPropertySnapshot;
}

@ObjectType()
@Schema({ _id: false })
export class EntryMeasureValue {
  @Field({ nullable: true })
  @Prop({ default: 'MEASURED' })
  status?: string;

  @Field({ nullable: true })
  @Prop()
  uncertainty?: string;

  @Field({ nullable: true })
  @Prop({ default: 'ABSOLUTE' })
  uncertaintyType?: string;

  @Field({ nullable: true })
  @Prop()
  quality?: string;

  @Field({ nullable: true })
  @Prop()
  instrument?: string;

  @Field({ nullable: true })
  @Prop()
  observedAt?: string;

  @Field({ nullable: true })
  @Prop()
  recordedAt?: string;

  @Field({ nullable: true })
  @Prop()
  revisedAt?: string;

  @Field({ nullable: true })
  @Prop()
  revisionNote?: string;
}
export const EntryMeasureValueSchema = SchemaFactory.createForClass(EntryMeasureValue);

@ObjectType()
@Schema({ _id: false })
export class EntryValue {
  @Field()
  @Prop({ required: true })
  fieldId!: string;

  @Field()
  @Prop({ default: '' })
  value!: string;

  @Field({ nullable: true })
  @Prop()
  numberValue?: string;

  @Field(() => UnitSnapshot, { nullable: true })
  @Prop({ type: UnitSnapshotSchema })
  unitSnapshot?: UnitSnapshot;

  @Field({ nullable: true })
  @Prop()
  booleanValue?: boolean;

  @Field(() => [String], { nullable: true })
  @Prop({ type: [String], default: undefined })
  selectedValues?: string[];

  @Field({ nullable: true })
  @Prop()
  durationSeconds?: number;

  @Field({ nullable: true })
  @Prop()
  dateTimeValue?: string;

  @Field({ nullable: true })
  @Prop()
  dateValue?: string;

  @Field({ nullable: true })
  @Prop()
  attachmentSize?: number;

  @Field({ nullable: true })
  @Prop()
  attachmentMimeType?: string;

  @Prop({ type: Buffer })
  attachmentData?: Buffer;

  // T44 — an attachment above 2 MiB is stored by reference.
  @Field({ nullable: true })
  @Prop()
  largeFileId?: string;

  @Field({ nullable: true })
  @Prop()
  largeFileSha256?: string;

  @Field(() => [String], { nullable: true })
  @Prop({ type: [String], default: undefined })
  objectIds?: string[];

  @Field(() => [ObjectReferenceSnapshot], { nullable: true })
  @Prop({ type: [ObjectReferenceSnapshotSchema], default: undefined })
  objectSnapshots?: ObjectReferenceSnapshot[];

  // T54 — people named by a collaborator field, with their names at saving time (same order).
  @Field(() => [String], { nullable: true })
  @Prop({ type: [String], default: undefined })
  personIds?: string[];

  @Field(() => [String], { nullable: true })
  @Prop({ type: [String], default: undefined })
  personNames?: string[];

  @Field(() => EntryMeasureValue, { nullable: true })
  @Prop({ type: EntryMeasureValueSchema })
  measureValue?: EntryMeasureValue;
}

export const EntryValueSchema = SchemaFactory.createForClass(EntryValue);

@ObjectType()
@Schema({ _id: false })
export class EntryRevision {
  @Field()
  @Prop({ required: true })
  at!: Date;
  @Field()
  @Prop({ required: true })
  formatVersion!: number;
  @Field(() => [EntryValue])
  @Prop({ type: [EntryValueSchema], required: true })
  values!: EntryValue[];
}
export const EntryRevisionSchema = SchemaFactory.createForClass(EntryRevision);

@ObjectType()
@Schema({ _id: false })
export class EntryRecurrence {
  @Field() @Prop({ required: true }) startFieldId!: string;
  @Field() @Prop({ required: true }) endFieldId!: string;
  @Field() @Prop({ required: true }) timeZone!: string;
  @Field() @Prop({ required: true, enum: ['DAILY', 'WEEKLY', 'MONTHLY'] }) frequency!: string;
  @Field() @Prop({ required: true }) interval!: number;
  @Field({ nullable: true }) @Prop() untilDate?: string;
  @Field(() => [String]) @Prop({ type: [String], default: [] }) excludedDates!: string[];
}
export const EntryRecurrenceSchema = SchemaFactory.createForClass(EntryRecurrence);

@ObjectType()
@Schema({ timestamps: true })
export class Entry {
  /** T53: person who created the entry, then the last person who changed it (absent on older entries: the owner). */
  @Prop() createdBy?: string;
  @Prop() updatedBy?: string;
  @Prop() clientMutationId?: string;
  @Prop() lastMutationId?: string;
  @Field(() => ID)
  id!: string;

  @Field()
  @Prop({ required: true, index: true })
  collectionId!: string;

  @Field({ nullable: true })
  @Prop({ index: true })
  formatId?: string;

  @Field({ nullable: true })
  @Prop()
  formatVersion?: number;

  @Field({ nullable: true }) @Prop() correctionOf?: string;
  @Field({ nullable: true }) @Prop() ledgerHash?: string;
  @Field({ nullable: true }) @Prop() ledgerPreviousHash?: string;
  @Field({ nullable: true }) @Prop() ledgerSequence?: number;
  @Prop({ type: [String], default: undefined }) ledgerValueHashes?: string[];
  @Prop({ type: [String], default: undefined }) ledgerRedactedFieldIds?: string[];

  @Field(() => [EntryValue])
  @Prop({ type: [EntryValueSchema], required: true })
  values!: EntryValue[];

  @Field(() => EntryRecurrence, { nullable: true })
  @Prop({ type: EntryRecurrenceSchema })
  recurrence?: EntryRecurrence;

  /** T49: days (YYYY-MM-DD) on which a repeating task was checked. */
  @Field(() => [String], { nullable: true })
  @Prop({ type: [String], default: undefined })
  taskCompletions?: string[];

  @Field(() => EntryWorkflow, { nullable: true })
  @Prop({ type: EntryWorkflowSchema })
  workflow?: EntryWorkflow;

  @Field(() => [EntryRevision])
  @Prop({ type: [EntryRevisionSchema], default: [] })
  revisions!: EntryRevision[];

  @Field({ nullable: true })
  @Prop({ index: true })
  sourceObjectId?: string;

  @Field()
  createdAt!: Date;

  @Field()
  updatedAt!: Date;

  @Prop({ required: true, index: true })
  ownerId!: string;

  @Prop({ index: true })
  movingOperationId?: string;

  @Prop()
  importKey?: string;

  @Prop()
  sourceId?: string;

  @Prop({ index: true })
  transferKey?: string;

  @Field({ nullable: true })
  @Prop()
  copiedFromCollectionId?: string;

  @Field({ nullable: true })
  @Prop()
  copiedFromEntryId?: string;

  @Field({ nullable: true })
  @Prop({ index: true })
  contributionLinkId?: string;

  @Field({ nullable: true })
  @Prop()
  contributionReceivedAt?: Date;

  // T32 — provenance of an entry written by a data source.
  @Field({ nullable: true })
  @Prop()
  dataSourceId?: string;

  @Field({ nullable: true })
  @Prop()
  sourceObservedAt?: Date;

  @Field({ nullable: true })
  @Prop()
  sourceReceivedAt?: Date;

  @Field({ nullable: true })
  @Prop()
  sourceRunId?: string;
}

@ObjectType()
export class CalendarOccurrence {
  @Field(() => Entry) entry!: Entry;
  @Field() startAt!: string;
  @Field() endAt!: string;
  @Field() timeZone!: string;
  @Field() recurring!: boolean;
  @Field() localDate!: string;
  @Field() localStartClock!: string;
  @Field() localEndClock!: string;
}

export const EntrySchema = SchemaFactory.createForClass(Entry);
EntrySchema.index({ ownerId: 1, collectionId: 1, createdAt: -1, _id: -1 });
EntrySchema.index({ ownerId: 1, collectionId: 1, formatId: 1, createdAt: -1, _id: -1 });
EntrySchema.index({ ownerId: 1, collectionId: 1, formatId: 1, 'values.fieldId': 1, 'values.value': 1 });
EntrySchema.index({ ownerId: 1, collectionId: 1, 'values.value': 'text' }, { default_language: 'none' });
EntrySchema.index({ ownerId: 1, collectionId: 1, importKey: 1, sourceId: 1 }, { unique: true, partialFilterExpression: { importKey: { $type: 'string' }, sourceId: { $type: 'string' } } });
EntrySchema.index({ ownerId: 1, collectionId: 1, clientMutationId: 1 }, { unique: true, partialFilterExpression: { clientMutationId: { $type: 'string' } } });
EntrySchema.index({ ownerId: 1, 'values.objectIds': 1 });
EntrySchema.index({ 'values.largeFileId': 1 }, { sparse: true });

@ObjectType()
export class EntryPage {
  @Field(() => [Entry])
  entries!: Entry[];

  @Field({ nullable: true })
  nextCursor?: string;

  @Field()
  hasMore!: boolean;

  /** Matching entries in all pages; given when the page is asked by position (offset or date) or is the first one. */
  @Field(() => Int, { nullable: true })
  totalCount?: number;

  /** Position of this page's first entry (0 = the very first); given when the page is asked by position. */
  @Field(() => Int, { nullable: true })
  offset?: number;
}

@ObjectType()
export class ImportRowError {
  @Field()
  sourceId!: string;

  @Field()
  message!: string;
}

@ObjectType()
export class ImportEntriesResult {
  @Field()
  validCount!: number;

  @Field()
  createdCount!: number;

  @Field()
  skippedCount!: number;

  @Field(() => [ImportRowError])
  errors!: ImportRowError[];
}

@ObjectType()
export class EntryAttachment {
  @Field()
  fileName!: string;

  @Field()
  mimeType!: string;

  @Field()
  size!: number;

  @Field()
  base64!: string;
}
