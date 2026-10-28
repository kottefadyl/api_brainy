import { Field, InputType, ObjectType, Int } from '@nestjs/graphql';

@InputType()
export class ForecastInput {
  @Field() formatId!: string;
  @Field() fieldId!: string;
  @Field() dateFieldId!: string;
  @Field() frequency!: string;
  @Field() method!: string;
  @Field() measureKind!: string;
  @Field({ nullable: true }) from?: string;
  @Field({ nullable: true }) to?: string;
  @Field(() => Int) horizon!: number;
  @Field(() => Int) holdout!: number;
}

@ObjectType()
export class ForecastPoint {
  @Field() date!: string;
  @Field() estimate!: string;
  @Field() lower!: string;
  @Field() upper!: string;
  @Field({ nullable: true }) observed?: string;
}

@ObjectType()
export class ForecastResult {
  @Field() method!: string;
  @Field() frequency!: string;
  @Field() sourceFrom!: string;
  @Field() sourceTo!: string;
  @Field(() => Int) trainingCount!: number;
  @Field(() => Int) holdoutCount!: number;
  @Field() holdoutMae!: string;
  @Field() uncertainty!: string;
  @Field({ nullable: true }) unit?: string;
  @Field({ nullable: true }) dimension?: string;
  @Field(() => [ForecastPoint]) observations!: ForecastPoint[];
  @Field(() => [ForecastPoint]) validation!: ForecastPoint[];
  @Field(() => [ForecastPoint]) forecast!: ForecastPoint[];
}
