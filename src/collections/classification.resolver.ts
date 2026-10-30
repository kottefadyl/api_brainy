import { Args, Context, Field, InputType, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service';
import { ClassificationCode, Collection } from './collection.schema';
import { ClassificationService } from './classification.service';

type Request = { headers: { authorization?: string } };

@InputType()
class ClassificationCodeInput {
  @Field() code!: string;
  @Field() labelEn!: string;
  @Field() labelFr!: string;
  @Field({ nullable: true }) parentCode?: string;
  @Field({ nullable: true }) active?: boolean;
  @Field({ nullable: true }) mergedInto?: string;
}

@ObjectType()
class ClassificationCsvError {
  @Field(() => Int) row!: number;
  @Field() message!: string;
}

@ObjectType()
class ClassificationCsvPreview {
  @Field(() => [ClassificationCode]) codes!: ClassificationCode[];
  @Field(() => [ClassificationCsvError]) errors!: ClassificationCsvError[];
}

@ObjectType()
class ClassificationCopyPreview {
  @Field() allowed!: boolean;
  @Field() sourceName!: string;
  @Field() targetName!: string;
  @Field(() => Int) codeCount!: number;
  @Field(() => [String]) conflicts!: string[];
}

@ObjectType()
class ClassificationMergePreview {
  @Field(() => Int) affectedEntries!: number;
  @Field() allowed!: boolean;
}

@Resolver()
export class ClassificationResolver {
  constructor(private readonly service: ClassificationService, private readonly auth: AuthService) {}
  private async user(request: Request) { return (await this.auth.currentUser(request.headers.authorization)).id; }

  @Mutation(() => Collection)
  async saveClassification(@Args('collectionId') collectionId: string, @Args('name') name: string, @Args('codes', { type: () => [ClassificationCodeInput] }) codes: ClassificationCodeInput[], @Args('listId', { type: () => String, nullable: true }) listId: string | undefined, @Args('expectedVersion', { type: () => Int, nullable: true }) expectedVersion: number | undefined, @Context('req') request: Request) {
    return this.service.save(collectionId, await this.user(request), listId, expectedVersion, name, codes as ClassificationCode[]);
  }

  @Query(() => ClassificationCsvPreview)
  async previewClassificationCsv(@Args('csv') csv: string, @Context('req') request: Request) {
    await this.user(request);
    return this.service.csvPreview(csv);
  }

  @Query(() => ClassificationCopyPreview)
  async classificationCopyPreview(@Args('collectionId') collectionId: string, @Args('listId') listId: string, @Args('targetCollectionId') targetCollectionId: string, @Context('req') request: Request) {
    return this.service.copyPreview(collectionId, listId, targetCollectionId, await this.user(request));
  }

  @Mutation(() => Collection)
  async copyClassification(@Args('collectionId') collectionId: string, @Args('listId') listId: string, @Args('targetCollectionId') targetCollectionId: string, @Context('req') request: Request) {
    return this.service.copy(collectionId, listId, targetCollectionId, await this.user(request));
  }

  @Query(() => ClassificationMergePreview)
  async classificationMergePreview(@Args('collectionId') collectionId: string, @Args('listId') listId: string, @Args('fromCode') fromCode: string, @Args('toCode') toCode: string, @Context('req') request: Request) {
    return this.service.mergePreview(collectionId, listId, fromCode, toCode, await this.user(request));
  }

  @Mutation(() => Collection)
  async mergeClassificationCodes(@Args('collectionId') collectionId: string, @Args('listId') listId: string, @Args('fromCode') fromCode: string, @Args('toCode') toCode: string, @Args('expectedVersion', { type: () => Int }) expectedVersion: number, @Context('req') request: Request) {
    return this.service.merge(collectionId, listId, fromCode, toCode, expectedVersion, await this.user(request));
  }
}
