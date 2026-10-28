import { Field, ObjectType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@ObjectType()
@Schema({ _id: false })
export class CollectionUnit {
  @Field()
  @Prop({ required: true })
  id!: string;

  @Field()
  @Prop({ required: true })
  name!: string;

  @Field()
  @Prop({ required: true })
  symbol!: string;

  @Field()
  @Prop({ required: true })
  dimension!: string;

  @Field({ nullable: true })
  @Prop()
  baseUnitId?: string;

  @Field()
  @Prop({ required: true })
  factor!: string;

  @Field({ nullable: true })
  @Prop()
  objectFormatId?: string;

  @Field()
  @Prop({ default: 1 })
  version!: number;

  @Field({ nullable: true }) @Prop() copiedFromUnitId?: string;
}
export const CollectionUnitSchema = SchemaFactory.createForClass(CollectionUnit);

@ObjectType()
@Schema({ _id: false })
export class CollectionExchangeRate {
  @Field()
  @Prop({ required: true })
  id!: string;

  @Field()
  @Prop({ required: true })
  from!: string;

  @Field()
  @Prop({ required: true })
  to!: string;

  @Field()
  @Prop({ required: true })
  rate!: string;

  @Field()
  @Prop({ required: true })
  effectiveAt!: Date;
}
export const CollectionExchangeRateSchema = SchemaFactory.createForClass(CollectionExchangeRate);

@ObjectType()
@Schema({ _id: false })
export class UnitSnapshot {
  @Field()
  @Prop({ required: true })
  id!: string;
  @Field()
  @Prop({ required: true })
  version!: number;
  @Field()
  @Prop({ required: true })
  symbol!: string;
  @Field()
  @Prop({ required: true })
  dimension!: string;
  @Field()
  @Prop({ required: true })
  factor!: string;
  @Field()
  @Prop({ required: true })
  root!: string;
  @Field({ nullable: true })
  @Prop()
  objectFormatId?: string;
}
export const UnitSnapshotSchema = SchemaFactory.createForClass(UnitSnapshot);

@ObjectType()
export class QuantityConversion {
  @Field()
  value!: string;

  @Field()
  fromSymbol!: string;

  @Field()
  toSymbol!: string;

  @Field({ nullable: true })
  rateDate?: Date;
}
