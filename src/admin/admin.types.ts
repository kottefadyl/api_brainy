import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';

/** One Brainy account as the administrator sees it: identity, activity and storage used. */
@ObjectType()
export class AdminUser {
  @Field(() => ID) id!: string;
  @Field() name!: string;
  @Field() email!: string;
  @Field({ nullable: true }) createdAt?: Date;
  @Field({ nullable: true }) lastActiveAt?: Date;
  @Field() blocked!: boolean;
  @Field({ nullable: true }) blockedAt?: Date;
  @Field() admin!: boolean;
  @Field() googleSignIn!: boolean;
  @Field(() => Int) collections!: number;
  @Field(() => Int) entries!: number;
  /** Database bytes: collections, entries (with small attachments), profile photo and everything else the account owns. */
  @Field(() => Float) databaseBytes!: number;
  /** Large files kept in object storage (S3). */
  @Field(() => Float) fileBytes!: number;
  @Field(() => Float) totalBytes!: number;
}

@ObjectType()
export class AdminOverview {
  @Field(() => [AdminUser]) users!: AdminUser[];
  @Field(() => Int) userCount!: number;
  @Field(() => Int) blockedCount!: number;
  @Field(() => Float) totalBytes!: number;
  @Field() generatedAt!: Date;
}

@ObjectType()
export class AdminErasure {
  @Field(() => Int) collections!: number;
  @Field(() => Int) documents!: number;
  @Field(() => Int) files!: number;
  @Field() accountDeleted!: boolean;
}
