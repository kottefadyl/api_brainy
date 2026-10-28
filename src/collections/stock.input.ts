import { Field, InputType, ObjectType } from '@nestjs/graphql';
import { StockMovement } from './stock.schema';

@InputType()
export class StockRuleInput {
  @Field() name!: string;
  @Field() formatId!: string;
  @Field() productFieldId!: string;
  @Field() quantityFieldId!: string;
  @Field() kind!: string;
  @Field({ nullable: true }) dateFieldId?: string;
  @Field({ nullable: true }) priceFieldId?: string;
  @Field({ nullable: true }) reasonFieldId?: string;
  @Field({ nullable: true }) fromLocationFieldId?: string;
  @Field({ nullable: true }) toLocationFieldId?: string;
  @Field({ nullable: true }) lotFieldId?: string;
  @Field({ nullable: true }) packageFactor?: string;
  @Field({ nullable: true }) expectedVersion?: number;
}

@InputType()
export class StockMovementInput {
  @Field() kind!: string;
  @Field() productId!: string;
  @Field() quantity!: string;
  @Field({ nullable: true }) packageFactor?: string;
  @Field({ nullable: true }) fromLocation?: string;
  @Field({ nullable: true }) toLocation?: string;
  @Field({ nullable: true }) lot?: string;
  @Field() occurredAt!: string;
  @Field({ nullable: true }) priceSnapshot?: string;
  @Field({ nullable: true }) priceUnit?: string;
  @Field({ nullable: true }) reason?: string;
  @Field({ nullable: true }) reversalOf?: string;
  @Field() idempotencyKey!: string;
}

@ObjectType()
export class StockPreview {
  @Field() kind!: string;
  @Field() productId!: string;
  @Field() productName!: string;
  @Field() baseQuantity!: string;
  @Field() fromLocation!: string;
  @Field() toLocation!: string;
  @Field() lot!: string;
  @Field() beforeFrom!: string;
  @Field() afterFrom!: string;
  @Field() beforeTo!: string;
  @Field() afterTo!: string;
  @Field() allowed!: boolean;
  @Field({ nullable: true }) reason?: string;
  @Field({ nullable: true }) existingMovementId?: string;
}

@ObjectType()
export class StockPosition {
  @Field() productId!: string;
  @Field() productName!: string;
  @Field() location!: string;
  @Field() lot!: string;
  @Field() quantity!: string;
}

@ObjectType()
export class StockDailyRow {
  @Field() date!: string;
  @Field() opening!: string;
  @Field() incoming!: string;
  @Field() outgoing!: string;
  @Field() closing!: string;
  @Field(() => [StockMovement]) movements!: StockMovement[];
}
