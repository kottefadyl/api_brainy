import { Field, Int, InputType, ObjectType } from '@nestjs/graphql';
import { EntryFieldFilterInput } from './collection.input';

@InputType()
export class FormulaInput {
  @Field() name!: string;
  @Field() formatId!: string;
  @Field() expression!: string;
  @Field({ nullable: true }) expectedVersion?: number;
}

@ObjectType()
export class FormulaStaticType {
  @Field() type!: string;
  @Field({ nullable: true }) unit?: string;
  @Field({ nullable: true }) dimension?: string;
  @Field({ description: 'True when the unit can only be known while calculating' }) unitOpen!: boolean;
}

@ObjectType()
export class FormulaResult {
  @Field() entryId!: string;
  @Field({ nullable: true }) value?: string;
  @Field({ nullable: true }) unit?: string;
  @Field({ nullable: true }) dimension?: string;
  @Field({ nullable: true }) missing?: string;
}

@ObjectType()
export class AnalysisOperationSpec {
  @Field() id!: string;
  @Field(() => Int) version!: number;
  @Field(() => [String]) acceptedMeasureKinds!: string[];
  @Field() requiresNumeric!: boolean;
  @Field() requiresDateOrder!: boolean;
  @Field() missingValuePolicy!: string;
  @Field(() => Int) minObservations!: number;
  @Field() outputKind!: string;
}

@InputType()
export class AnalysisInput {
  @Field() formatId!: string;
  @Field({ nullable: true }) fieldId?: string;
  @Field({ nullable: true }) formulaId?: string;
  @Field({ nullable: true }) dateFieldId?: string;
  @Field({ nullable: true }) groupFieldId?: string;
  @Field({ nullable: true }) zoneFormatId?: string;
  @Field({ nullable: true }) zoneFieldId?: string;
  @Field({ nullable: true }) search?: string;
  @Field({ nullable: true }) viewId?: string;
  @Field() groupBy!: string;
  @Field({ nullable: true }) secondaryGroupBy?: string;
  @Field({ nullable: true }) secondaryGroupFieldId?: string;
  @Field(() => Int, { nullable: true }) groupDepth?: number;
  @Field(() => Int, { nullable: true }) secondaryGroupDepth?: number;
  @Field({ nullable: true }) language?: string;
  @Field() operation!: string;
  @Field() measureKind!: string;
  @Field(() => Int, { nullable: true }) percentile?: number;
  @Field(() => Int, { nullable: true }) rateBase?: number;
  @Field({ nullable: true }) denominatorFieldId?: string;
  @Field({ nullable: true }) denominatorValue?: string;
  @Field({ nullable: true }) weightFieldId?: string;
  @Field(() => Int, { nullable: true }) windowSize?: number;
  @Field({ nullable: true }) counterResetFieldId?: string;
  @Field({ nullable: true }) from?: string;
  @Field({ nullable: true }) to?: string;
  @Field({ nullable: true }) comparisonFrom?: string;
  @Field({ nullable: true }) comparisonTo?: string;
  @Field(() => [EntryFieldFilterInput], { nullable: true }) filters?: EntryFieldFilterInput[];
  @Field({ nullable: true }) sourceGroup?: string;
  @Field({ nullable: true }) sourceOffset?: number;
}

@ObjectType()
export class AnalysisSource {
  @Field() entryId!: string;
  @Field() value!: string;
}

@ObjectType()
export class AnalysisRow {
  @Field() group!: string;
  @Field() label!: string;
  @Field({ nullable: true }) rowKey?: string;
  @Field({ nullable: true }) columnKey?: string;
  @Field() value!: string;
  @Field() count!: number;
  @Field(() => [AnalysisSource]) sources!: AnalysisSource[];
  @Field() sourcesHasMore!: boolean;
}

@ObjectType()
export class AnalysisResult {
  @Field() operation!: string;
  @Field(() => Int, { nullable: true }) operationVersion?: number;
  @Field() groupBy!: string;
  @Field({ nullable: true }) secondaryGroupBy?: string;
  @Field({ nullable: true }) unit?: string;
  @Field({ nullable: true }) dimension?: string;
  @Field(() => Int, { nullable: true }) skippedMissingCount?: number;
  @Field({ nullable: true }) slope?: string;
  @Field({ nullable: true }) explanation?: string;
  @Field({ nullable: true }) hasEstimated?: boolean;
  @Field({ nullable: true }) propagatedUncertainty?: string;
  @Field() refreshedAt!: string;
  @Field(() => [AnalysisRow]) rows!: AnalysisRow[];
  @Field(() => [AnalysisRow], { nullable: true }) comparisonRows?: AnalysisRow[];
}
