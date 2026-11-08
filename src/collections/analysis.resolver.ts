import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service';
import { AnalysisInput, AnalysisOperationSpec, AnalysisResult, FormulaInput, FormulaResult, FormulaStaticType } from './analysis.input';
import { ANALYSIS_REGISTRY } from './analysis_registry';
import { AnalysisService } from './analysis.service';
import { Collection } from './collection.schema';

type Request = { headers: { authorization?: string } };

@Resolver()
export class AnalysisResolver {
  constructor(private readonly service: AnalysisService, private readonly auth: AuthService) {}
  private async owner(request: Request): Promise<string> { return (await this.auth.currentUser(request.headers.authorization)).id; }

  @Query(() => [AnalysisOperationSpec])
  analysisOperations(): readonly AnalysisOperationSpec[] {
    return ANALYSIS_REGISTRY;
  }

  @Query(() => FormulaStaticType)
  async inferCollectionFormula(@Args('collectionId') collectionId: string, @Args('formatId') formatId: string, @Args('expression') expression: string, @Context('req') request: Request): Promise<FormulaStaticType> {
    return this.service.inferFormula(collectionId, await this.owner(request), formatId, expression);
  }

  @Mutation(() => Collection)
  async saveCollectionFormula(@Args('collectionId') collectionId: string, @Args('input') input: FormulaInput, @Args('formulaId', { type: () => String, nullable: true }) formulaId: string | undefined, @Context('req') request: Request) {
    return this.service.saveFormula(collectionId, await this.owner(request), input, formulaId);
  }

  @Mutation(() => Collection)
  async deleteCollectionFormula(@Args('collectionId') collectionId: string, @Args('formulaId') formulaId: string, @Context('req') request: Request) {
    return this.service.deleteFormula(collectionId, await this.owner(request), formulaId);
  }

  @Query(() => FormulaResult)
  async calculateCollectionFormula(@Args('collectionId') collectionId: string, @Args('formulaId') formulaId: string, @Args('entryId') entryId: string, @Context('req') request: Request) {
    return this.service.calculate(collectionId, await this.owner(request), formulaId, entryId);
  }

  @Query(() => AnalysisResult)
  async analyseCollection(@Args('collectionId') collectionId: string, @Args('input') input: AnalysisInput, @Context('req') request: Request) {
    return this.service.analyse(collectionId, await this.owner(request), input);
  }
}
