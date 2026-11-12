import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service.js';
import { StartBackgroundJobInput } from './background-job.input.js';
import { BackgroundJob } from './background-job.schema.js';
import { BackgroundJobService } from './background-job.service.js';

type Request = { headers: { authorization?: string } };

@Resolver()
export class BackgroundJobResolver {
  constructor(private readonly service: BackgroundJobService, private readonly auth: AuthService) {}
  private async user(request: Request) { return (await this.auth.currentUser(request.headers.authorization)).id; }

  @Mutation(() => BackgroundJob)
  async startBackgroundJob(@Args('collectionId') collectionId: string, @Args('input') input: StartBackgroundJobInput, @Context('req') request: Request) {
    return this.service.start(collectionId, await this.user(request), input);
  }

  @Query(() => [BackgroundJob])
  async backgroundJobs(@Args('collectionId') collectionId: string, @Context('req') request: Request) {
    return this.service.list(collectionId, await this.user(request));
  }

  @Query(() => BackgroundJob)
  async backgroundJob(@Args('jobId') jobId: string, @Context('req') request: Request) {
    return this.service.detail(jobId, await this.user(request));
  }

  @Mutation(() => BackgroundJob)
  async cancelBackgroundJob(@Args('jobId') jobId: string, @Context('req') request: Request) {
    return this.service.cancel(jobId, await this.user(request));
  }

  @Mutation(() => BackgroundJob)
  async resumeBackgroundJob(@Args('jobId') jobId: string, @Context('req') request: Request) {
    return this.service.resume(jobId, await this.user(request));
  }
}
