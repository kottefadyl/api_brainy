import { Args, Context, Query, Resolver } from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service';
import { ForecastInput, ForecastResult } from './forecast.input';
import { ForecastService } from './forecast.service';

type Request = { headers: { authorization?: string } };

@Resolver()
export class ForecastResolver {
  constructor(private readonly service: ForecastService, private readonly auth: AuthService) {}

  @Query(() => ForecastResult)
  async forecastCollection(@Args('collectionId') collectionId: string, @Args('input') input: ForecastInput, @Context('req') request: Request): Promise<ForecastResult> {
    return this.service.forecast(collectionId, (await this.auth.currentUser(request.headers.authorization)).id, input);
  }
}
