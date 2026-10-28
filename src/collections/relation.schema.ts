import { Field, Float, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

export enum RelationKind { ASSOCIATION = 'ASSOCIATION', PARENT = 'PARENT', COMPONENT = 'COMPONENT' }
registerEnumType(RelationKind, { name: 'RelationKind' });

@ObjectType()
@Schema({ timestamps: true })
export class EntryRelation {
  @Field(() => ID) id!: string;
  @Field() @Prop({ required: true, index: true }) collectionId!: string;
  @Field() @Prop({ required: true }) ownerId!: string;
  @Field() @Prop({ required: true }) fromEntryId!: string;
  @Field() @Prop({ required: true }) toEntryId!: string;
  @Field(() => RelationKind) @Prop({ required: true, enum: Object.values(RelationKind) }) kind!: RelationKind;
  @Field() @Prop({ default: '' }) label!: string;
  @Field({ nullable: true }) @Prop() quantity?: string;
  @Field({ nullable: true }) @Prop() unit?: string;
  @Field({ nullable: true }) @Prop() snapshotValue?: string;
  @Field({ nullable: true }) @Prop() snapshotUnit?: string;
  @Field({ nullable: true }) @Prop() snapshotFieldId?: string;
  @Field() @Prop({ required: true }) createdBy!: string;
  @Field() @Prop({ default: Date.now }) createdAt!: Date;
  @Field({ nullable: true }) @Prop() deletedAt?: Date;
  @Prop({ index: true }) transferKey?: string;
}
export const EntryRelationSchema = SchemaFactory.createForClass(EntryRelation);
EntryRelationSchema.index({ collectionId: 1, kind: 1, fromEntryId: 1, toEntryId: 1 }, { unique: true });
EntryRelationSchema.index({ collectionId: 1, kind: 1, toEntryId: 1, deletedAt: 1 });

@ObjectType()
export class RelationImpact {
  @Field(() => [EntryRelation]) relations!: EntryRelation[];
  @Field() replacementAllowed!: boolean;
}

@ObjectType()
export class RelationTotal {
  @Field() value!: string;
  @Field({ nullable: true }) unit?: string;
  @Field() nodes!: number;
}
