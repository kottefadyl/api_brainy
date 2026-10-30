import { Args, Context, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service';
import { Collection } from './collection.schema';
import { StockDailyRow, StockMovementInput, StockPosition, StockPreview, StockRuleInput } from './stock.input';
import { StockMovement } from './stock.schema';
import { StockService } from './stock.service';
import { StockLedgerService } from './stock-ledger.service';
import { LedgerIntegrity } from './ledger.schema';

type Request = { headers: { authorization?: string } };

@Resolver()
export class StockResolver {
  constructor(private readonly service: StockService, private readonly auth: AuthService, private readonly ledger: StockLedgerService) {}
  private async owner(request: Request): Promise<string> { return (await this.auth.currentUser(request.headers.authorization)).id; }

  @Query(() => [StockPosition])
  async stockPositions(@Args('collectionId') collectionId: string, @Context('req') request: Request): Promise<StockPosition[]> {
    return this.service.positions(collectionId, await this.owner(request));
  }

  @Query(() => LedgerIntegrity)
  async verifyStockLedger(@Args('collectionId') collectionId: string, @Args('productId') productId: string, @Context('req') request: Request): Promise<LedgerIntegrity> {
    return this.ledger.verify(collectionId, productId, await this.owner(request));
  }

  @Query(() => String)
  async stockLedgerProof(@Args('collectionId') collectionId: string, @Args('productId') productId: string, @Context('req') request: Request): Promise<string> {
    return this.ledger.proof(collectionId, productId, await this.owner(request));
  }

  @Mutation(() => LedgerIntegrity)
  async sealStockHistory(@Args('collectionId') collectionId: string, @Args('productId') productId: string, @Context('req') request: Request): Promise<LedgerIntegrity> {
    return this.ledger.sealHistory(collectionId, productId, await this.owner(request));
  }

  @Query(() => [StockMovement])
  async stockMovements(@Args('collectionId') collectionId: string, @Args('productId', { type: () => String, nullable: true }) productId: string | undefined, @Args('before', { type: () => String, nullable: true }) before: string | undefined, @Args('limit', { type: () => Int, nullable: true }) limit: number | undefined, @Context('req') request: Request): Promise<StockMovement[]> {
    return this.service.listMovements(collectionId, await this.owner(request), productId, before, limit);
  }

  @Query(() => [StockDailyRow])
  async stockDailyReport(@Args('collectionId') collectionId: string, @Args('productId') productId: string, @Args('from') from: string, @Args('to') to: string, @Args('timeZone') timeZone: string, @Args('location', { type: () => String, nullable: true }) location: string | undefined, @Args('lot', { type: () => String, nullable: true }) lot: string | undefined, @Context('req') request: Request): Promise<StockDailyRow[]> {
    return this.service.dailyReport(collectionId, await this.owner(request), productId, from, to, timeZone, location, lot);
  }

  @Query(() => StockPreview)
  async previewStockMovement(@Args('collectionId') collectionId: string, @Args('input') input: StockMovementInput, @Context('req') request: Request): Promise<StockPreview> {
    return this.service.preview(collectionId, await this.owner(request), input);
  }

  @Query(() => StockPreview)
  async previewEntryStockEffect(@Args('collectionId') collectionId: string, @Args('entryId') entryId: string, @Args('ruleId') ruleId: string, @Context('req') request: Request): Promise<StockPreview> {
    return this.service.previewEntry(collectionId, await this.owner(request), entryId, ruleId);
  }

  @Mutation(() => Collection)
  async setStockNegativePolicy(@Args('collectionId') collectionId: string, @Args('allowNegative') allowNegative: boolean, @Context('req') request: Request): Promise<Collection> {
    return this.service.setNegativePolicy(collectionId, await this.owner(request), allowNegative);
  }

  @Mutation(() => Collection)
  async saveStockRule(@Args('collectionId') collectionId: string, @Args('input') input: StockRuleInput, @Args('ruleId', { type: () => String, nullable: true }) ruleId: string | undefined, @Context('req') request: Request): Promise<Collection> {
    return this.service.saveRule(collectionId, await this.owner(request), input, ruleId);
  }

  @Mutation(() => Collection)
  async deleteStockRule(@Args('collectionId') collectionId: string, @Args('ruleId') ruleId: string, @Context('req') request: Request): Promise<Collection> {
    return this.service.deleteRule(collectionId, await this.owner(request), ruleId);
  }

  @Mutation(() => StockMovement)
  async commitStockMovement(@Args('collectionId') collectionId: string, @Args('input') input: StockMovementInput, @Context('req') request: Request): Promise<StockMovement> {
    return this.service.commit(collectionId, await this.owner(request), input);
  }

  @Mutation(() => StockMovement)
  async commitEntryStockEffect(@Args('collectionId') collectionId: string, @Args('entryId') entryId: string, @Args('ruleId') ruleId: string, @Args('expectedUpdatedAt') expectedUpdatedAt: string, @Context('req') request: Request): Promise<StockMovement> {
    return this.service.commitEntry(collectionId, await this.owner(request), entryId, ruleId, expectedUpdatedAt);
  }
}
