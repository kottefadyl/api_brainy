// T44 — large files stored by reference in S3-compatible storage.
import { Field, Float, ID, InputType, Int, ObjectType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

export const LARGE_FILE_THRESHOLD = 2_097_152; // above 2 MiB an attachment switches to reference mode
export const LARGE_FILE_CHUNK = 6 * 1024 * 1024; // S3 parts must be ≥ 5 MiB except the last one
export const LARGE_FILE_MAX = Number(process.env.LARGE_FILE_MAX_BYTES ?? 2 * 1024 * 1024 * 1024);

@Schema({ _id: false })
export class LargeFilePart {
  @Prop({ required: true }) partNumber!: number;
  @Prop({ required: true }) size!: number;
  @Prop({ required: true }) sha256!: string;
  @Prop({ required: true }) etag!: string;
}
const LargeFilePartSchema = SchemaFactory.createForClass(LargeFilePart);

@Schema({ timestamps: true, collection: 'large_files' })
export class LargeFile {
  id!: string;
  @Prop({ required: true, index: true }) collectionId!: string;
  /** Owner of the collection: references only resolve inside the same account. */
  @Prop({ required: true }) ownerId!: string;
  @Prop({ required: true }) uploaderId!: string;
  @Prop({ required: true }) fileName!: string;
  @Prop({ required: true }) mimeType!: string;
  @Prop({ required: true }) size!: number;
  @Prop({ required: true }) chunkSize!: number;
  @Prop({ required: true }) partCount!: number;
  @Prop({ required: true, unique: true }) objectKey!: string;
  @Prop() uploadId?: string;
  @Prop({ type: [LargeFilePartSchema], default: [] }) parts!: LargeFilePart[];
  /** UPLOADING → COMPLETE; then AVAILABLE/MISSING/CORRUPTED after checks; ABORTED. */
  @Prop({ required: true, index: true }) state!: string;
  @Prop() sha256?: string;
  @Prop() completedAt?: Date;
  @Prop() checkedAt?: Date;
  @Prop() unreferencedSince?: Date;
  createdAt!: Date;
  updatedAt!: Date;
}
export const LargeFileSchema = SchemaFactory.createForClass(LargeFile);
LargeFileSchema.index({ state: 1, updatedAt: 1 });

@ObjectType()
export class LargeFileUpload {
  @Field(() => ID) id!: string;
  @Field() fileName!: string;
  @Field(() => Float) size!: number;
  @Field(() => Int) chunkSize!: number;
  @Field(() => Int) partCount!: number;
  @Field(() => [Int]) receivedParts!: number[];
  @Field() state!: string;
  @Field({ nullable: true }) sha256?: string;
}

@ObjectType()
export class LargeFileLink {
  @Field() url!: string;
  @Field() expiresAt!: Date;
  @Field() fileName!: string;
  @Field(() => Float) size!: number;
  @Field({ nullable: true }) sha256?: string;
}

@ObjectType()
export class LargeFileStatus {
  @Field() largeFileId!: string;
  @Field() fileName!: string;
  @Field(() => Float) size!: number;
  @Field() state!: string;
  @Field({ nullable: true }) checkedAt?: Date;
}

@InputType()
export class StartLargeFileUploadInput {
  @Field() fileName!: string;
  @Field() mimeType!: string;
  @Field(() => Float) size!: number;
}
