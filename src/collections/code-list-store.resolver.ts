import { Args, Context, Field, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { BadRequestException } from '@nestjs/common';
import { AuthService } from '../auth/auth.service.js';
import { ClassificationCode, Collection } from './collection.schema.js';
import { CodeListStore, type ReferentialFormat } from './code-list-store.service.js';

type Request = { headers: { authorization?: string } };

@ObjectType()
class ReferentialError {
  @Field(() => Int) row!: number;
  @Field() message!: string;
}

@ObjectType()
class ReferentialPreview {
  @Field(() => Int) codeCount!: number;
  @Field(() => Int) levels!: number;
  @Field({ description: 'More than 5,000 codes: stored apart and searched on the server' }) large!: boolean;
  @Field(() => [ReferentialError]) errors!: ReferentialError[];
  @Field(() => [ClassificationCode]) sample!: ClassificationCode[];
}

@ObjectType()
class FoundClassificationCode {
  @Field() code!: string;
  @Field() label!: string;
  @Field(() => [String], { description: 'Labels of the ancestors, from the root' }) path!: string[];
  @Field(() => Int) level!: number;
  @Field() active!: boolean;
  @Field() hasChildren!: boolean;
}

const formatOf = (value: string): ReferentialFormat => {
  if (value !== 'CSV' && value !== 'JSON') throw new BadRequestException('Choose CSV or JSON');
  return value;
};

/** Referential imports (T39/1) and server-side search of code lists (T39/3). */
@Resolver()
export class CodeListStoreResolver {
  constructor(private readonly store: CodeListStore, private readonly auth: AuthService) {}
  private async user(request: Request) { return (await this.auth.currentUser(request.headers.authorization)).id; }

  @Query(() => ReferentialPreview)
  async previewReferential(@Args('format') format: string, @Args('content') content: string, @Context('req') request: Request) {
    await this.user(request);
    return this.store.preview(formatOf(format), content);
  }

  @Mutation(() => Collection)
  async importReferential(
    @Args('collectionId') collectionId: string, @Args('name') name: string, @Args('format') format: string, @Args('content') content: string,
    @Args('listId', { type: () => String, nullable: true }) listId: string | undefined, @Args('expectedVersion', { type: () => Int, nullable: true }) expectedVersion: number | undefined,
    @Context('req') request: Request,
  ) {
    return this.store.importReferential(collectionId, await this.user(request), name, formatOf(format), content, listId ?? undefined, expectedVersion ?? undefined);
  }

  @Query(() => [FoundClassificationCode])
  async searchClassificationCodes(
    @Args('collectionId') collectionId: string, @Args('listId') listId: string,
    @Args('query', { type: () => String, nullable: true }) query: string | undefined, @Args('parentCode', { type: () => String, nullable: true }) parentCode: string | undefined,
    @Args('limit', { type: () => Int, nullable: true }) limit: number | undefined, @Args('language', { type: () => String, nullable: true }) language: string | undefined,
    @Args('includeInactive', { type: () => Boolean, nullable: true }) includeInactive: boolean | undefined,
    @Context('req') request: Request,
  ) {
    return this.store.search(collectionId, listId, await this.user(request), { query: query ?? undefined, parentCode: parentCode ?? undefined, limit: limit ?? undefined, language: language ?? undefined, includeInactive: includeInactive ?? false });
  }

  @Query(() => [ClassificationCode], { description: 'Codes by value, to label the codes already saved in entries' })
  async classificationCodesByValue(@Args('collectionId') collectionId: string, @Args('listId') listId: string, @Args('codes', { type: () => [String] }) codes: string[], @Context('req') request: Request) {
    if (codes.length > 500) throw new BadRequestException('Ask for 500 codes at most');
    return this.store.lookupFor(collectionId, listId, await this.user(request), codes);
  }
}
