import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { CollectionExchangeRate, CollectionExchangeRateSchema, CollectionUnit, CollectionUnitSchema } from './unit.schema';
import { ObjectPropertySnapshot, ObjectPropertySnapshotSchema } from './entry.schema';
import { StockRule, StockRuleSchema } from './stock.schema';
import { CollectionMember, CollectionMemberSchema } from './collaboration.schema';

export enum FieldKind {
  TITLE = 'TITLE',
  DATE = 'DATE',
  NUMBER = 'NUMBER',
  TIME = 'TIME',
  LINK = 'LINK',
  CHARACTER = 'CHARACTER',
  TEXT = 'TEXT',
  BOOLEAN = 'BOOLEAN',
  SELECT = 'SELECT',
  MULTI_SELECT = 'MULTI_SELECT',
  DATETIME = 'DATETIME',
  DURATION = 'DURATION',
  LONG_TEXT = 'LONG_TEXT',
  ATTACHMENT = 'ATTACHMENT',
  OBJECT_REF = 'OBJECT_REF',
  MEASURE = 'MEASURE',
}

registerEnumType(FieldKind, { name: 'FieldKind' });

@ObjectType()
@Schema({ _id: false })
export class CollectionField {
  @Field()
  @Prop({ required: true })
  id!: string;

  @Field()
  @Prop({ required: true, trim: true })
  name!: string;

  @Field(() => FieldKind)
  @Prop({ required: true, enum: Object.values(FieldKind) })
  kind!: FieldKind;

  @Field({ nullable: true })
  @Prop({ trim: true })
  unit?: string;

  @Field(() => [String], { nullable: true })
  @Prop({ type: [String], default: undefined })
  options?: string[];

  @Field({ nullable: true })
  @Prop()
  targetObjectFormatId?: string;

  @Field({ nullable: true })
  @Prop()
  multiple?: boolean;

  @Field({ nullable: true })
  @Prop()
  variableName?: string;

  @Field({ nullable: true })
  @Prop({ enum: ['CURRENT', 'SNAPSHOT'] })
  referenceMode?: string;

  @Field({ nullable: true })
  @Prop()
  sourceFieldId?: string;
}

export const CollectionFieldSchema = SchemaFactory.createForClass(CollectionField);

@ObjectType()
@Schema({ _id: false })
export class LinkedFormatSource {
  @Field() @Prop({ required: true }) sourceCollectionId!: string;
  @Field() @Prop({ required: true }) sourceFormatId!: string;
  @Field() @Prop({ required: true }) acceptedVersion!: number;
  @Field() @Prop({ required: true }) targetVersion!: number;
}
export const LinkedFormatSourceSchema = SchemaFactory.createForClass(LinkedFormatSource);

@ObjectType()
@Schema({ _id: false })
export class CollectionFormat {
  @Field()
  @Prop({ required: true })
  id!: string;

  @Field()
  @Prop({ required: true, trim: true })
  name!: string;

  @Field()
  @Prop({ required: true })
  color!: string;

  @Field(() => [CollectionField])
  @Prop({ type: [CollectionFieldSchema], required: true })
  fields!: CollectionField[];

  @Field({ nullable: true })
  @Prop({ default: 1 })
  version?: number;

  @Field()
  @Prop({ default: false })
  objectModel!: boolean;

  @Field({ nullable: true }) @Prop() copiedFromFormatId?: string;
  @Field(() => LinkedFormatSource, { nullable: true }) @Prop({ type: LinkedFormatSourceSchema }) linkedSource?: LinkedFormatSource;
}

export const CollectionFormatSchema = SchemaFactory.createForClass(CollectionFormat);

@ObjectType()
export class CollectionFormatImpact {
  @Field()
  entryCount!: number;

  @Field(() => [String])
  populatedFieldIds!: string[];
}

@ObjectType()
export class ObjectModelTemplate {
  @Field() id!: string;
  @Field() name!: string;
  @Field() description!: string;
  @Field(() => [CollectionField]) fields!: CollectionField[];
}

@ObjectType()
export class TransferPreview {
  @Field() sourceName!: string;
  @Field() targetName!: string;
  @Field(() => [String]) dataFormats!: string[];
  @Field(() => [String]) units!: string[];
  @Field(() => [String]) formulas!: string[];
  @Field() objects!: number;
  @Field() entries!: number;
  @Field(() => [String]) conflicts!: string[];
  @Field() allowed!: boolean;
  @Field({ nullable: true }) inboundReferences?: number;
  @Field({ nullable: true }) activeShares?: number;
  @Field() stockMovementCount!: number;
}

@ObjectType()
export class TransferResult {
  @Field() targetCollectionId!: string;
  @Field({ nullable: true }) objectId?: string;
  @Field({ nullable: true }) dataFormatId?: string;
  @Field() copiedObjects!: number;
  @Field() copiedEntries!: number;
  @Field({ nullable: true }) operationId?: string;
}

@ObjectType()
export class MoveOperationStatus {
  @Field() id!: string;
  @Field() state!: string;
  @Field() sourceObjectId!: string;
  @Field() targetCollectionId!: string;
  @Field({ nullable: true }) targetObjectId?: string;
  @Field({ nullable: true }) failure?: string;
}

@ObjectType()
export class LinkedFormatUpdatePreview {
  @Field() targetFormatId!: string;
  @Field() sourceVersion!: number;
  @Field() acceptedVersion!: number;
  @Field(() => [String]) addedFields!: string[];
  @Field(() => [String]) changedFields!: string[];
  @Field(() => [String]) removedFields!: string[];
  @Field(() => [String]) conflicts!: string[];
  @Field() allowed!: boolean;
}

@ObjectType()
@Schema({ _id: false })
export class SharedObjectGrant {
  @Field() @Prop({ required: true }) id!: string;
  @Field() @Prop({ required: true }) sourceCollectionId!: string;
  @Field() @Prop({ required: true }) sourceFormatId!: string;
  @Field() @Prop({ required: true }) sourceFormatVersion!: number;
  @Field() @Prop({ required: true }) objectId!: string;
  @Field() @Prop({ required: true }) sourceName!: string;
  @Field() @Prop({ required: true }) objectName!: string;
  @Field(() => [String]) @Prop({ type: [String], required: true }) propertyFieldIds!: string[];
  @Field() @Prop({ required: true, enum: ['CURRENT', 'SNAPSHOT'] }) mode!: string;
  @Field(() => [ObjectPropertySnapshot]) @Prop({ type: [ObjectPropertySnapshotSchema], required: true }) snapshot!: ObjectPropertySnapshot[];
  @Field() @Prop({ required: true }) createdAt!: Date;
  @Field({ nullable: true }) @Prop() revokedAt?: Date;
}
export const SharedObjectGrantSchema = SchemaFactory.createForClass(SharedObjectGrant);

@ObjectType()
@Schema({ _id: false })
export class SavedCollectionView {
  @Field() @Prop({ required: true }) id!: string;
  @Field() @Prop({ required: true }) name!: string;
  @Field() @Prop({ required: true, enum: ['LIST', 'TABLE', 'CARDS', 'TASKS', 'CALENDAR'] }) layout!: string;
  @Field(() => [String]) @Prop({ type: [String], default: [] }) formatIds!: string[];
  @Field(() => [String]) @Prop({ type: [String], default: [] }) columnFieldIds!: string[];
  @Field() @Prop({ default: '' }) search!: string;
  @Field({ nullable: true }) @Prop() filterFieldId?: string;
  @Field({ nullable: true }) @Prop() filterOperator?: string;
  @Field({ nullable: true }) @Prop() filterValue?: string;
  @Field() @Prop({ required: true, enum: ['NEWEST', 'OLDEST', 'MANUAL'] }) sort!: string;
  @Field(() => [String]) @Prop({ type: [String], default: [] }) manualOrderFieldIds!: string[];
  @Field() @Prop({ default: false }) groupByFormat!: boolean;
  @Field({ nullable: true }) @Prop() taskDoneFieldId?: string;
  @Field({ nullable: true }) @Prop() taskDueFieldId?: string;
  @Field({ nullable: true }) @Prop() taskCompletedFieldId?: string;
  @Field({ nullable: true }) @Prop() taskPriorityFieldId?: string;
  @Field({ nullable: true }) @Prop() calendarStartFieldId?: string;
  @Field({ nullable: true }) @Prop() calendarEndFieldId?: string;
  @Field({ nullable: true }) @Prop() calendarTimeZone?: string;
}
export const SavedCollectionViewSchema = SchemaFactory.createForClass(SavedCollectionView);

@ObjectType()
@Schema({ _id: false })
export class CollectionFormula {
  @Field() @Prop({ required: true }) id!: string;
  @Field() @Prop({ required: true }) name!: string;
  @Field() @Prop({ required: true }) formatId!: string;
  @Field() @Prop({ required: true }) expression!: string;
  @Field() @Prop({ required: true, default: 1 }) version!: number;
  @Field(() => [String]) @Prop({ type: [String], default: [] }) dependencies!: string[];
  @Prop() transferKey?: string;
  @Prop() copiedFromFormulaId?: string;
}
export const CollectionFormulaSchema = SchemaFactory.createForClass(CollectionFormula);

@ObjectType()
@Schema({ timestamps: true })
export class Collection {
  @Field(() => ID)
  id!: string;

  @Field()
  @Prop({ required: true, trim: true })
  name!: string;

  @Field(() => [CollectionField])
  @Prop({ type: [CollectionFieldSchema], required: true })
  fields!: CollectionField[];

  @Field(() => [CollectionFormat])
  @Prop({ type: [CollectionFormatSchema], default: [] })
  formats!: CollectionFormat[];

  @Field(() => [CollectionUnit])
  @Prop({ type: [CollectionUnitSchema], default: [] })
  units!: CollectionUnit[];

  @Field(() => [CollectionExchangeRate])
  @Prop({ type: [CollectionExchangeRateSchema], default: [] })
  exchangeRates!: CollectionExchangeRate[];

  @Field(() => [SharedObjectGrant])
  @Prop({ type: [SharedObjectGrantSchema], default: [] })
  sharedObjects!: SharedObjectGrant[];

  @Field(() => [SavedCollectionView])
  @Prop({ type: [SavedCollectionViewSchema], default: [] })
  savedViews!: SavedCollectionView[];

  @Field(() => [CollectionFormula])
  @Prop({ type: [CollectionFormulaSchema], default: [] })
  formulas!: CollectionFormula[];

  @Field(() => [StockRule])
  @Prop({ type: [StockRuleSchema], default: [] })
  stockRules!: StockRule[];

  @Field()
  @Prop({ default: false })
  allowNegativeStock!: boolean;

  @Field(() => [CollectionMember], { nullable: true })
  @Prop({ type: [CollectionMemberSchema], default: [] })
  members?: CollectionMember[];

  @Prop({ required: true, index: true })
  ownerId!: string;
}

export const CollectionSchema = SchemaFactory.createForClass(Collection);
