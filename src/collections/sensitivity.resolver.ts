import { Args, Context, Int, Mutation, Resolver } from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service';
import { Collection, SensitivityLevel } from './collection.schema';
import { SensitivityService } from './sensitivity.service';

type Request = { headers: { authorization?: string } };
@Resolver(() => Collection)
export class SensitivityResolver {
  constructor(private readonly service: SensitivityService, private readonly auth: AuthService) {}
  private async actor(request: Request): Promise<string> { return (await this.auth.currentUser(request.headers.authorization)).id; }

  @Mutation(() => Collection)
  async setFormatSensitivity(@Args('collectionId') collectionId: string, @Args('formatId') formatId: string,
    @Args('level', { type: () => SensitivityLevel }) level: SensitivityLevel, @Args('expectedVersion', { type: () => Int }) expectedVersion: number,
    @Context('req') request: Request): Promise<Collection> { return this.service.setFormat(collectionId, formatId, level, expectedVersion, await this.actor(request)); }

  @Mutation(() => Collection)
  async setFieldSensitivity(@Args('collectionId') collectionId: string, @Args('formatId') formatId: string, @Args('fieldId') fieldId: string,
    @Args('level', { type: () => SensitivityLevel }) level: SensitivityLevel, @Args('expectedVersion', { type: () => Int }) expectedVersion: number,
    @Context('req') request: Request): Promise<Collection> { return this.service.setField(collectionId, formatId, fieldId, level, expectedVersion, await this.actor(request)); }

  @Mutation(() => Collection)
  async setMinimumAggregateSize(@Args('collectionId') collectionId: string, @Args('minimum', { type: () => Int }) minimum: number,
    @Context('req') request: Request): Promise<Collection> { return this.service.setMinimum(collectionId, minimum, await this.actor(request)); }
}
