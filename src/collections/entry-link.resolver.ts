import { Args, Context, Field, InputType, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service.js';
import { EntryLink } from './entry-link.schema.js';
import { EntryLinkService } from './entry-link.service.js';
import { Entry } from './entry.schema.js';

type Request = { headers: { authorization?: string } };
@InputType()
class ImportedEntryLinkInput {
  @Field() fromSourceId!: string;
  @Field() toSourceId!: string;
  @Field() label!: string;
}
@Resolver(() => EntryLink)
export class EntryLinkResolver {
  constructor(private readonly service: EntryLinkService, private readonly auth: AuthService) {}
  private async owner(request: Request): Promise<string> { return (await this.auth.currentUser(request.headers.authorization)).id; }

  @Query(() => [EntryLink])
  async collectionEntryLinks(@Args('collectionId') collectionId: string, @Args('entryId') entryId: string, @Args('includeDeleted', { type: () => Boolean, nullable: true }) includeDeleted: boolean | undefined, @Context('req') request: Request) {
    return this.service.list(collectionId, await this.owner(request), entryId, includeDeleted);
  }

  @Mutation(() => EntryLink)
  async createCollectionEntryLink(@Args('collectionId') collectionId: string, @Args('fromEntryId') fromEntryId: string, @Args('toEntryId') toEntryId: string, @Args('label', { type: () => String, nullable: true }) label: string | undefined, @Context('req') request: Request) {
    return this.service.create(collectionId, await this.owner(request), fromEntryId, toEntryId, label);
  }

  @Mutation(() => EntryLink)
  async setCollectionEntryLinkActive(@Args('collectionId') collectionId: string, @Args('linkId') linkId: string, @Args('active') active: boolean, @Context('req') request: Request) {
    return this.service.change(collectionId, await this.owner(request), linkId, active);
  }

  @Mutation(() => Boolean)
  async linkImportedEntries(@Args('collectionId') collectionId: string, @Args('importKey') importKey: string, @Args('links', { type: () => [ImportedEntryLinkInput] }) links: ImportedEntryLinkInput[], @Context('req') request: Request) {
    return this.service.importLinks(collectionId, await this.owner(request), importKey, links);
  }

  @Query(() => [Entry])
  async collectionDuplicateLinks(@Args('collectionId') collectionId: string, @Args('formatId') formatId: string, @Args('fieldId') fieldId: string, @Args('url') url: string, @Args('excludeEntryId', { type: () => String, nullable: true }) excludeEntryId: string | undefined, @Context('req') request: Request) {
    return this.service.duplicateLinks(collectionId, await this.owner(request), formatId, fieldId, url, excludeEntryId);
  }
}
