import { Field, ID, ObjectType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ _id: false })
export class DomainPackageKey {
  @Prop({ required: true }) kind!: string;
  @Prop({ required: true }) key!: string;
  @Prop({ required: true }) id!: string;
}
export const DomainPackageKeySchema = SchemaFactory.createForClass(DomainPackageKey);

/** Link between a collection and the package it copied from. Detaching keeps every copied element. */
@ObjectType()
@Schema({ timestamps: true })
export class DomainPackageInstall {
  @Field(() => ID) id!: string;
  @Field() @Prop({ required: true, index: true }) collectionId!: string;
  @Prop({ required: true, index: true }) ownerId!: string;
  @Field() @Prop({ required: true }) packageId!: string;
  @Field() @Prop({ required: true }) version!: string;
  @Field() @Prop({ required: true }) name!: string;
  @Field() @Prop({ required: true }) author!: string;
  @Field() @Prop({ required: true }) license!: string;
  @Field() @Prop({ required: true }) publishedAt!: string;
  @Field() @Prop({ required: true }) signatureStatus!: string;
  @Field({ nullable: true }) @Prop() keyFingerprint?: string;
  @Field() @Prop({ required: true }) installedAt!: Date;
  @Field({ nullable: true }) @Prop() updatedFrom?: string;
  @Field({ nullable: true }) @Prop() detachedAt?: Date;
  @Field() dataFormatCount!: number;
  @Prop({ type: [DomainPackageKeySchema], default: [] }) keys!: DomainPackageKey[];
}
export const DomainPackageInstallSchema = SchemaFactory.createForClass(DomainPackageInstall);
DomainPackageInstallSchema.index({ collectionId: 1, packageId: 1, detachedAt: 1 });

@ObjectType()
export class DomainPackageSummary {
  @Field() id!: string;
  @Field() version!: string;
  @Field() name!: string;
  @Field() description!: string;
  @Field() packageJson!: string;
}

@ObjectType()
export class DomainPackagePreview {
  @Field() packageId!: string;
  @Field() version!: string;
  @Field() name!: string;
  @Field() description!: string;
  @Field() notice!: string;
  @Field() author!: string;
  @Field() license!: string;
  @Field() publishedAt!: string;
  @Field({ nullable: true }) homepage?: string;
  @Field() signatureStatus!: string;
  @Field({ nullable: true }) keyFingerprint?: string;
  @Field() mode!: string;
  @Field({ nullable: true }) installedVersion?: string;
  @Field(() => [String]) dataFormats!: string[];
  @Field(() => [String]) addedFields!: string[];
  @Field(() => [String]) units!: string[];
  @Field(() => [String]) codeLists!: string[];
  @Field(() => [String]) views!: string[];
  @Field(() => [String]) formulas!: string[];
  @Field(() => [String]) stockRules!: string[];
  @Field() exampleObjects!: number;
  @Field(() => [String]) dependencies!: string[];
  @Field(() => [String]) adjustments!: string[];
  @Field(() => [String]) conflicts!: string[];
  @Field() allowed!: boolean;
}

@ObjectType()
export class DomainPackageInstallResult {
  @Field() collectionId!: string;
  @Field() installId!: string;
  @Field() mode!: string;
  @Field() version!: string;
  @Field() addedDataFormats!: number;
  @Field() addedFields!: number;
  @Field() exampleObjects!: number;
}

@ObjectType()
export class DomainPackageExport {
  @Field() packageJson!: string;
  @Field() fileName!: string;
  @Field(() => [String]) warnings!: string[];
  @Field() dataFormats!: number;
}
