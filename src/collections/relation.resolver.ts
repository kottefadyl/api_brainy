import { Args, Context, Field, InputType, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service.js';
import { EntryRelation, RelationImpact, RelationKind, RelationTotal } from './relation.schema.js';
import { RelationService } from './relation.service.js';

type Request = { headers: { authorization?: string } };

@InputType()
class ImportedRelationInput {
  @Field() fromSourceId!: string;
  @Field() toSourceId!: string;
  @Field(() => RelationKind) kind!: RelationKind;
  @Field() label!: string;
  @Field({ nullable: true }) quantity?: string;
  @Field({ nullable: true }) unit?: string;
  @Field({ nullable: true }) snapshotValue?: string;
  @Field({ nullable: true }) snapshotUnit?: string;
  @Field({ nullable: true }) snapshotFieldId?: string;
}

@Resolver(() => EntryRelation)
export class RelationResolver {
  constructor(private readonly service: RelationService, private readonly auth: AuthService) {}
  private async user(request: Request): Promise<string> { return (await this.auth.currentUser(request.headers.authorization)).id; }

  @Query(() => [EntryRelation])
  async collectionRelations(@Args('collectionId') collectionId: string, @Args('entryId') entryId: string, @Context('req') request: Request) {
    return this.service.list(collectionId, entryId, await this.user(request));
  }

  @Mutation(() => EntryRelation)
  async createCollectionRelation(@Args('collectionId') collectionId: string, @Args('fromEntryId') fromEntryId: string, @Args('toEntryId') toEntryId: string, @Args('kind', { type: () => RelationKind }) kind: RelationKind, @Args('label', { type: () => String, nullable: true }) label: string | undefined, @Args('quantity', { type: () => String, nullable: true }) quantity: string | undefined, @Args('unit', { type: () => String, nullable: true }) unit: string | undefined, @Args('snapshotFieldId', { type: () => String, nullable: true }) snapshotFieldId: string | undefined, @Context('req') request: Request) {
    return this.service.create(collectionId, fromEntryId, toEntryId, kind, label ?? '', quantity, unit, await this.user(request), snapshotFieldId);
  }

  @Query(() => RelationImpact)
  async collectionRelationImpact(@Args('collectionId') collectionId: string, @Args('entryId') entryId: string, @Args('replacementId', { type: () => String, nullable: true }) replacementId: string | undefined, @Context('req') request: Request) {
    return this.service.impact(collectionId, entryId, replacementId, await this.user(request));
  }

  @Mutation(() => Boolean)
  async removeCollectionRelation(@Args('collectionId') collectionId: string, @Args('relationId') relationId: string, @Context('req') request: Request) {
    return this.service.remove(collectionId, relationId, await this.user(request));
  }

  @Mutation(() => Boolean)
  async importCollectionRelations(@Args('collectionId') collectionId: string, @Args('importKey') importKey: string, @Args('rows', { type: () => [ImportedRelationInput] }) rows: ImportedRelationInput[], @Context('req') request: Request) {
    return this.service.importRelations(collectionId, await this.user(request), importKey, rows);
  }

  @Mutation(() => Boolean)
  async detachCollectionRelations(@Args('collectionId') collectionId: string, @Args('entryId') entryId: string, @Args('replacementId', { type: () => String, nullable: true }) replacementId: string | undefined, @Context('req') request: Request) {
    return this.service.detach(collectionId, entryId, replacementId, await this.user(request));
  }

  @Query(() => RelationTotal)
  async collectionRelationTotal(@Args('collectionId') collectionId: string, @Args('rootId') rootId: string, @Args('kind', { type: () => RelationKind }) kind: RelationKind, @Args('fieldName') fieldName: string, @Context('req') request: Request) {
    return this.service.total(collectionId, rootId, kind, fieldName, await this.user(request));
  }
}
