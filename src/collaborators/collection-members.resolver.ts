// Paged member list and member count of a collection, for the owner.
import { Args, Context, Int, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service.js';
import { Collection } from '../collections/collection.schema.js';
import { CollectionMembersPage } from './collection-members.schema.js';
import { CollectionMembersService } from './collection-members.service.js';

type Request = { headers: { authorization?: string }; brainyViewerId?: Promise<string> };

@Resolver(() => Collection)
export class CollectionMembersResolver {
  constructor(private readonly auth: AuthService, private readonly service: CollectionMembersService) {}

  private viewer(request: Request): Promise<string> {
    request.brainyViewerId ??= this.auth.currentUser(request.headers.authorization).then((user) => user.id);
    return request.brainyViewerId;
  }

  @Query(() => CollectionMembersPage, { description: 'People a collection is shared with, sorted by name; owner only.' })
  async collectionMembers(
    @Args('collectionId') collectionId: string,
    @Args('search', { type: () => String, nullable: true }) search: string | undefined,
    @Args('offset', { type: () => Int, nullable: true }) offset: number | undefined,
    @Args('limit', { type: () => Int, nullable: true }) limit: number | undefined,
    @Context('req') request: Request,
  ): Promise<CollectionMembersPage> {
    return this.service.page(collectionId, await this.viewer(request), search ?? '', offset ?? 0, limit ?? 50);
  }

  @ResolveField(() => Int, { nullable: true, description: 'Number of people the collection is shared with; null when the viewer is not the owner.' })
  async memberCount(@Parent() collection: Collection, @Context('req') request: Request): Promise<number | null> {
    return collection.ownerId === await this.viewer(request) ? (collection.members ?? []).length : null;
  }
}
