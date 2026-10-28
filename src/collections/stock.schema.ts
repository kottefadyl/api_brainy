import { Field, ID, ObjectType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@ObjectType()
@Schema({ _id: false })
export class StockRule {
  @Field() @Prop({ required: true }) id!: string;
  @Field() @Prop({ required: true }) name!: string;
  @Field() @Prop({ required: true }) formatId!: string;
  @Field() @Prop({ required: true }) productFieldId!: string;
  @Field() @Prop({ required: true }) quantityFieldId!: string;
  @Field() @Prop({ required: true, enum: ['IN', 'OUT', 'TRANSFER', 'CORRECTION'] }) kind!: string;
  @Field({ nullable: true }) @Prop() dateFieldId?: string;
  @Field({ nullable: true }) @Prop() priceFieldId?: string;
  @Field({ nullable: true }) @Prop() reasonFieldId?: string;
  @Field({ nullable: true }) @Prop() fromLocationFieldId?: string;
  @Field({ nullable: true }) @Prop() toLocationFieldId?: string;
  @Field({ nullable: true }) @Prop() lotFieldId?: string;
  @Field() @Prop({ required: true }) packageFactor!: string;
  @Field() @Prop({ required: true, default: 1 }) version!: number;
}
export const StockRuleSchema = SchemaFactory.createForClass(StockRule);

@ObjectType()
@Schema({ timestamps: true })
export class StockMovement {
  @Field(() => ID) id!: string;
  @Prop({ required: true, index: true }) ownerId!: string;
  @Field() @Prop({ required: true, index: true }) collectionId!: string;
  @Field() @Prop({ required: true, index: true }) productId!: string;
  @Field() @Prop({ required: true }) productName!: string;
  @Field() @Prop({ required: true, enum: ['IN', 'OUT', 'TRANSFER', 'CORRECTION', 'RETURN'] }) kind!: string;
  @Field() @Prop({ required: true }) quantity!: string;
  @Field() @Prop({ required: true }) packageFactor!: string;
  @Field() @Prop({ required: true }) baseQuantity!: string;
  @Field() @Prop({ default: '' }) fromLocation!: string;
  @Field() @Prop({ default: '' }) toLocation!: string;
  @Field() @Prop({ default: '' }) lot!: string;
  @Field() @Prop({ required: true }) occurredAt!: Date;
  @Field() @Prop({ default: Date.now }) createdAt!: Date;
  @Field({ nullable: true }) @Prop() priceSnapshot?: string;
  @Field({ nullable: true }) @Prop() priceUnit?: string;
  @Field({ nullable: true }) @Prop() reason?: string;
  @Field({ nullable: true }) @Prop() sourceEntryId?: string;
  @Field({ nullable: true }) @Prop() sourceEntryUpdatedAt?: Date;
  @Field({ nullable: true }) @Prop() ruleId?: string;
  @Field({ nullable: true }) @Prop() reversalOf?: string;
  @Field() @Prop({ required: true }) actorId!: string;
  @Field() @Prop({ required: true }) idempotencyKey!: string;
}
export const StockMovementSchema = SchemaFactory.createForClass(StockMovement);
StockMovementSchema.index({ ownerId: 1, collectionId: 1, idempotencyKey: 1 }, { unique: true });
StockMovementSchema.index({ ownerId: 1, collectionId: 1, productId: 1, occurredAt: 1 });

@Schema()
export class StockLock {
  @Prop({ required: true }) ownerId!: string;
  @Prop({ required: true }) collectionId!: string;
  @Prop({ required: true }) productId!: string;
  @Prop({ required: true, default: new Date(0) }) lockedUntil!: Date;
  @Prop() token?: string;
}
export const StockLockSchema = SchemaFactory.createForClass(StockLock);
StockLockSchema.index({ ownerId: 1, collectionId: 1, productId: 1 }, { unique: true });
