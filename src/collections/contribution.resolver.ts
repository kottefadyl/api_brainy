import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service';
import { EntryValueInput } from './collection.input';
import { ContributionLink, ContributionReceipt, ContributionSubmission, CreatedContributionLink, CreateContributionLinkInput, PublicContributionForm, RespondentContribution, SubmitContributionInput } from './contribution.schema';
import { ContributionService } from './contribution.service';

type Request = { headers: { authorization?: string } };

@Resolver()
export class ContributionResolver {
  constructor(private readonly service: ContributionService, private readonly auth: AuthService) {}
  private async actor(request: Request): Promise<string> { return (await this.auth.currentUser(request.headers.authorization)).id; }

  @Mutation(() => CreatedContributionLink)
  async createContributionLink(@Args('collectionId') collectionId: string, @Args('input') input: CreateContributionLinkInput, @Context('req') request: Request): Promise<CreatedContributionLink> {
    return this.service.create(collectionId, input, await this.actor(request));
  }

  @Query(() => [ContributionLink])
  async contributionLinks(@Args('collectionId') collectionId: string, @Context('req') request: Request): Promise<ContributionLink[]> {
    return this.service.list(collectionId, await this.actor(request));
  }

  @Mutation(() => ContributionLink)
  async revokeContributionLink(@Args('id') id: string, @Context('req') request: Request): Promise<ContributionLink> {
    return this.service.revoke(id, await this.actor(request));
  }

  @Query(() => PublicContributionForm)
  async publicContributionForm(@Args('token') token: string): Promise<PublicContributionForm> { return this.service.form(token); }

  @Mutation(() => ContributionReceipt)
  async submitContribution(@Args('token') token: string, @Args('input') input: SubmitContributionInput): Promise<ContributionReceipt> { return this.service.submit(token, input); }

  @Query(() => [ContributionSubmission])
  async contributionSubmissions(@Args('collectionId') collectionId: string, @Context('req') request: Request): Promise<ContributionSubmission[]> {
    return this.service.submissionsFor(collectionId, await this.actor(request));
  }

  @Mutation(() => ContributionSubmission)
  async correctContribution(@Args('id') id: string, @Args('values', { type: () => [EntryValueInput] }) values: EntryValueInput[], @Context('req') request: Request): Promise<ContributionSubmission> {
    return this.service.correct(id, values, await this.actor(request));
  }

  @Mutation(() => ContributionSubmission)
  async reviewContribution(@Args('id') id: string, @Args('action') action: string, @Args('duplicateOf', { type: () => String, nullable: true }) duplicateOf: string | undefined, @Context('req') request: Request): Promise<ContributionSubmission> {
    return this.service.review(id, action, await this.actor(request), duplicateOf);
  }

  @Query(() => RespondentContribution)
  async contributionByReceipt(@Args('receipt') receipt: string): Promise<RespondentContribution> { return this.service.exportByReceipt(receipt); }

  @Mutation(() => Boolean)
  async eraseContribution(@Args('id') id: string, @Context('req') request: Request): Promise<boolean> { return this.service.erase(id, await this.actor(request)); }

  @Mutation(() => Boolean)
  async eraseContributionByReceipt(@Args('receipt') receipt: string): Promise<boolean> { return this.service.erase('', undefined, receipt); }
}
