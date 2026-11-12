// T32 — GraphQL surface of data sources. `pushDataSourceDelivery` is public and authenticated by the source key only.
import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service.js';
import { DataSource, DataSourceInput, DataSourceKey, DataSourceRun } from './data-source.schema.js';
import { DataSourceService } from './data-source.service.js';

type Request = { headers: { authorization?: string } };

@Resolver()
export class DataSourceResolver {
  constructor(private readonly service: DataSourceService, private readonly auth: AuthService) {}
  private async actor(request: Request): Promise<string> { return (await this.auth.currentUser(request.headers.authorization)).id; }

  @Query(() => [DataSource])
  async dataSources(@Args('collectionId') collectionId: string, @Context('req') request: Request) { return this.service.list(collectionId, await this.actor(request)); }

  @Mutation(() => DataSource)
  async createDataSource(@Args('collectionId') collectionId: string, @Args('input') input: DataSourceInput, @Context('req') request: Request) { return this.service.create(collectionId, input, await this.actor(request)); }

  @Mutation(() => DataSource)
  async updateDataSource(@Args('sourceId') sourceId: string, @Args('input') input: DataSourceInput, @Context('req') request: Request) { return this.service.update(sourceId, input, await this.actor(request)); }

  @Mutation(() => Boolean)
  async deleteDataSource(@Args('sourceId') sourceId: string, @Context('req') request: Request) { return this.service.remove(sourceId, await this.actor(request)); }

  @Mutation(() => DataSourceKey)
  async rotateDataSourceKey(@Args('sourceId') sourceId: string, @Context('req') request: Request) { return this.service.rotateKey(sourceId, await this.actor(request)); }

  @Mutation(() => DataSource)
  async revokeDataSourceKey(@Args('sourceId') sourceId: string, @Context('req') request: Request) { return this.service.revokeKey(sourceId, await this.actor(request)); }

  @Mutation(() => DataSourceRun)
  async uploadDataSourceDelivery(@Args('sourceId') sourceId: string, @Args('deliveryId') deliveryId: string, @Args('content') content: string, @Args('contentType') contentType: string, @Context('req') request: Request) {
    return this.service.upload(sourceId, deliveryId, content, contentType, await this.actor(request));
  }

  @Mutation(() => DataSourceRun)
  async pushDataSourceDelivery(@Args('key') key: string, @Args('deliveryId') deliveryId: string, @Args('content') content: string, @Args('contentType') contentType: string) {
    return this.service.push(key, deliveryId, content, contentType);
  }

  @Query(() => [DataSourceRun])
  async dataSourceRuns(@Args('sourceId') sourceId: string, @Context('req') request: Request) { return this.service.runsFor(sourceId, await this.actor(request)); }

  @Query(() => DataSourceRun)
  async dataSourceRun(@Args('runId') runId: string, @Context('req') request: Request) { return this.service.detail(runId, await this.actor(request)); }

  @Query(() => String)
  async dataSourceRejectionsCsv(@Args('runId') runId: string, @Context('req') request: Request) { return this.service.rejectionsCsv(runId, await this.actor(request)); }

  @Mutation(() => DataSourceRun)
  async cancelDataSourceRun(@Args('runId') runId: string, @Context('req') request: Request) { return this.service.cancel(runId, await this.actor(request)); }

  @Mutation(() => DataSourceRun)
  async resumeDataSourceRun(@Args('runId') runId: string, @Context('req') request: Request) { return this.service.resume(runId, await this.actor(request)); }

  @Mutation(() => DataSourceRun)
  async retryDataSourceRejections(@Args('runId') runId: string, @Context('req') request: Request) { return this.service.retryRejections(runId, await this.actor(request)); }
}
