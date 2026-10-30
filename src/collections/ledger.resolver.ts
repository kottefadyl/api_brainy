import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service';
import { Collection } from './collection.schema';
import { SaveEntryInput } from './collection.input';
import { CollectionsService } from './collections.service';
import { Entry } from './entry.schema';
import { LedgerIntegrity } from './ledger.schema';
import { LedgerService } from './ledger.service';

type Request = { headers: { authorization?: string } };

@Resolver()
export class LedgerResolver {
  constructor(private readonly ledger: LedgerService, private readonly collections: CollectionsService, private readonly auth: AuthService) {}
  private async actor(request: Request): Promise<string> { return (await this.auth.currentUser(request.headers.authorization)).id; }

  @Mutation(() => Collection)
  async enableLedger(@Args('collectionId') collectionId: string, @Args('formatId') formatId: string, @Context('req') request: Request): Promise<Collection> {
    return this.ledger.enable(collectionId, formatId, await this.actor(request));
  }

  @Mutation(() => Entry)
  async correctLedgerEntry(@Args('originalId') originalId: string, @Args('input') input: SaveEntryInput, @Context('req') request: Request): Promise<Entry> {
    return this.collections.correctLedgerEntry(originalId, input.values, await this.actor(request), input.clientMutationId);
  }

  @Mutation(() => LedgerIntegrity)
  async redactLedgerFields(@Args('collectionId') collectionId: string, @Args('formatId') formatId: string,
    @Args('entryId') entryId: string, @Args('fieldIds', { type: () => [String] }) fieldIds: string[],
    @Args('reason') reason: string, @Context('req') request: Request): Promise<LedgerIntegrity> {
    return this.ledger.redact(collectionId, formatId, entryId, fieldIds, reason, await this.actor(request));
  }

  @Query(() => LedgerIntegrity)
  async verifyLedger(@Args('collectionId') collectionId: string, @Args('formatId') formatId: string, @Context('req') request: Request): Promise<LedgerIntegrity> {
    return this.ledger.verify(collectionId, formatId, await this.actor(request));
  }

  @Query(() => String)
  async ledgerProof(@Args('collectionId') collectionId: string, @Args('formatId') formatId: string, @Context('req') request: Request): Promise<string> {
    return this.ledger.proof(collectionId, formatId, await this.actor(request));
  }

  @Query(() => String)
  async ledgerBalance(@Args('collectionId') collectionId: string, @Args('formatId') formatId: string, @Args('fieldId') fieldId: string, @Context('req') request: Request): Promise<string> {
    return this.ledger.balance(collectionId, formatId, fieldId, await this.actor(request));
  }
}
