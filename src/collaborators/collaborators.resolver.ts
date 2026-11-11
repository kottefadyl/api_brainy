// T52: GraphQL for collaborators and the "shared by" summary of a collection.
import { Args, Context, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service';
import { Collection } from '../collections/collection.schema';
import { CollaborationInvitePreview, Collaborator, CollectionOwnerSummary } from './collaborator.schema';
import { CollaboratorsService } from './collaborators.service';

type Request = { headers: { authorization?: string } };

@Resolver()
export class CollaboratorsResolver {
  constructor(private readonly auth: AuthService, private readonly service: CollaboratorsService) {}

  private async userId(request: Request): Promise<string> {
    return (await this.auth.currentUser(request.headers.authorization)).id;
  }

  @Query(() => String, { description: 'Token of my personal collaboration link.' })
  async collaborationInviteToken(@Context('req') request: Request): Promise<string> {
    return this.service.inviteToken(await this.userId(request));
  }

  @Mutation(() => String, { description: 'New collaboration link token; the previous link stops working.' })
  async regenerateCollaborationInvite(@Context('req') request: Request): Promise<string> {
    return this.service.regenerateInviteToken(await this.userId(request));
  }

  @Query(() => CollaborationInvitePreview, { description: 'Readable without signing in: shows only the inviter name.' })
  async collaborationInvite(@Args('token') token: string, @Context('req') request: Request): Promise<CollaborationInvitePreview> {
    const viewerId = request.headers.authorization ? await this.userId(request).catch(() => undefined) : undefined;
    return this.service.preview(token, viewerId);
  }

  @Mutation(() => Collaborator)
  async acceptCollaboration(@Args('token') token: string, @Context('req') request: Request): Promise<Collaborator> {
    return this.service.accept(token, await this.userId(request));
  }

  @Query(() => [Collaborator])
  async collaborators(@Context('req') request: Request): Promise<Collaborator[]> {
    return this.service.list(await this.userId(request));
  }

  @Query(() => String, { nullable: true })
  async collaboratorPhoto(@Args('userId') userId: string, @Context('req') request: Request): Promise<string | null> {
    return this.service.photo(await this.userId(request), userId);
  }

  @Mutation(() => Boolean, { description: 'Ends the collaboration and removes every share between both people.' })
  async endCollaboration(@Args('userId') userId: string, @Context('req') request: Request): Promise<boolean> {
    return this.service.end(await this.userId(request), userId);
  }
}

@Resolver(() => Collection)
export class CollectionOwnerResolver {
  constructor(private readonly auth: AuthService, private readonly service: CollaboratorsService) {}

  @ResolveField(() => CollectionOwnerSummary, { nullable: true, description: 'Owner of a collection shared with me; null for my own collections.' })
  async sharedBy(@Parent() collection: Collection, @Context('req') request: Request): Promise<CollectionOwnerSummary | null> {
    return this.service.owner(collection, (await this.auth.currentUser(request.headers.authorization)).id);
  }
}
