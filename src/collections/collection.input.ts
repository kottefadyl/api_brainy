import { Field, InputType, registerEnumType } from '@nestjs/graphql';
import { FieldKind } from './collection.schema';

@InputType()
export class SavedCollectionViewInput {
  @Field() name!: string;
  @Field() layout!: string;
  @Field(() => [String]) formatIds!: string[];
  @Field(() => [String]) columnFieldIds!: string[];
  @Field({ nullable: true }) search?: string;
  @Field({ nullable: true }) filterFieldId?: string;
  @Field({ nullable: true }) filterOperator?: string;
  @Field({ nullable: true }) filterValue?: string;
  @Field() sort!: string;
  @Field(() => [String], { nullable: true }) manualOrderFieldIds?: string[];
  @Field() groupByFormat!: boolean;
  @Field({ nullable: true }) taskDoneFieldId?: string;
  @Field({ nullable: true }) taskDueFieldId?: string;
  @Field({ nullable: true }) taskCompletedFieldId?: string;
  @Field({ nullable: true }) taskPriorityFieldId?: string;
  @Field({ nullable: true }) calendarStartFieldId?: string;
  @Field({ nullable: true }) calendarEndFieldId?: string;
  @Field({ nullable: true }) calendarTimeZone?: string;
}

@InputType()
export class EntryRecurrenceInput {
  @Field() timeZone!: string;
  @Field() frequency!: string;
  @Field() interval!: number;
  @Field({ nullable: true }) untilDate?: string;
  @Field(() => [String]) excludedDates!: string[];
}

@InputType()
export class EntryReminderInput {
  @Field() fieldId!: string;
  @Field() minutesBefore!: number;
  @Field(() => [String]) channels!: string[];
  @Field() timeZone!: string;
  @Field({ nullable: true }) timeOfDay?: string;
  @Field({ nullable: true }) viewId?: string;
}

@InputType()
export class CollectionFieldInput {
  @Field()
  name!: string;

  @Field(() => FieldKind)
  kind!: FieldKind;

  @Field({ nullable: true })
  unit?: string;

  @Field(() => [String], { nullable: true })
  options?: string[];

  @Field({ nullable: true })
  targetObjectFormatId?: string;

  @Field({ nullable: true })
  multiple?: boolean;

  @Field({ nullable: true })
  variableName?: string;

  @Field({ nullable: true })
  referenceMode?: string;
}

@InputType()
export class UpdateCollectionFieldInput extends CollectionFieldInput {
  @Field({ nullable: true })
  id?: string;
}

@InputType()
export class UpdateCollectionFormatInput {
  @Field()
  name!: string;

  @Field(() => [UpdateCollectionFieldInput])
  fields!: UpdateCollectionFieldInput[];

  @Field()
  expectedVersion!: number;
}

@InputType()
export class CollectionFormatInput {
  @Field()
  name!: string;

  @Field()
  color!: string;

  @Field(() => [CollectionFieldInput])
  fields!: CollectionFieldInput[];

  @Field({ nullable: true })
  objectModel?: boolean;
}

@InputType()
export class CreateCollectionInput {
  @Field()
  name!: string;

  // Keep the original shape for older clients. New clients send formats.
  @Field(() => [CollectionFieldInput], { nullable: true })
  fields?: CollectionFieldInput[];

  @Field(() => [CollectionFormatInput], { nullable: true })
  formats?: CollectionFormatInput[];

  @Field(() => [CollectionUnitInput], { nullable: true })
  units?: CollectionUnitInput[];

  @Field(() => [CollectionExchangeRateInput], { nullable: true })
  exchangeRates?: CollectionExchangeRateInput[];
}

@InputType()
export class UnitSnapshotInput {
  @Field() id!: string;
  @Field() version!: number;
  @Field() symbol!: string;
  @Field() dimension!: string;
  @Field() factor!: string;
  @Field() root!: string;
  @Field({ nullable: true }) objectFormatId?: string;
}

@InputType()
export class EntryMeasureValueInput {
  @Field({ nullable: true })
  status?: string;

  @Field({ nullable: true })
  uncertainty?: string;

  @Field({ nullable: true })
  uncertaintyType?: string;

  @Field({ nullable: true })
  quality?: string;

  @Field({ nullable: true })
  instrument?: string;

  @Field({ nullable: true })
  observedAt?: string;

  @Field({ nullable: true })
  recordedAt?: string;

  @Field({ nullable: true })
  revisedAt?: string;

  @Field({ nullable: true })
  revisionNote?: string;
}

@InputType()
export class EntryValueInput {
  @Field()
  fieldId!: string;

  @Field()
  value!: string;

  @Field({ nullable: true })
  attachmentBase64?: string;

  @Field({ nullable: true })
  attachmentMimeType?: string;

  @Field(() => UnitSnapshotInput, { nullable: true })
  unitSnapshot?: UnitSnapshotInput;

  @Field(() => EntryMeasureValueInput, { nullable: true })
  measureValue?: EntryMeasureValueInput;
}

@InputType()
export class SaveEntryInput {
  @Field({ nullable: true })
  formatId?: string;

  @Field(() => [EntryValueInput])
  values!: EntryValueInput[];
}

export enum EntryFilterOperator {
  EQ = 'EQ',
  CONTAINS = 'CONTAINS',
  GT = 'GT',
  GTE = 'GTE',
  LT = 'LT',
  LTE = 'LTE',
}

registerEnumType(EntryFilterOperator, { name: 'EntryFilterOperator' });

@InputType()
export class EntryFieldFilterInput {
  @Field()
  fieldId!: string;

  @Field(() => EntryFilterOperator)
  operator!: EntryFilterOperator;

  @Field()
  value!: string;
}

@InputType()
export class ImportEntryRowInput {
  @Field()
  sourceId!: string;

  @Field()
  createdAt!: string;

  @Field()
  updatedAt!: string;

  @Field(() => [EntryValueInput])
  values!: EntryValueInput[];
}

@InputType()
export class ImportObjectLinkInput {
  @Field()
  sourceId!: string;

  @Field()
  sourceObjectId!: string;
}

@InputType()
export class ImportEntriesInput {
  @Field()
  formatId!: string;

  @Field()
  importKey!: string;

  @Field()
  dryRun!: boolean;

  @Field(() => [ImportEntryRowInput])
  rows!: ImportEntryRowInput[];
}

@InputType()
export class CollectionUnitInput {
  @Field({ nullable: true })
  id?: string;

  @Field()
  name!: string;

  @Field()
  symbol!: string;

  @Field()
  dimension!: string;

  @Field({ nullable: true })
  baseUnitId?: string;

  @Field()
  factor!: string;

  @Field({ nullable: true })
  objectFormatId?: string;

  @Field({ nullable: true })
  expectedVersion?: number;
}

@InputType()
export class CollectionExchangeRateInput {
  @Field()
  from!: string;

  @Field()
  to!: string;

  @Field()
  rate!: string;

  @Field()
  effectiveAt!: string;
}
