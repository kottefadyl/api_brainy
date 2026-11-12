// Firebase custom token for the live signals; null when real-time synchronisation is off.
import { Context, Query, Resolver } from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service';
import { RealtimeService } from './realtime.service';

@Resolver()
export class RealtimeResolver {
  constructor(private readonly auth: AuthService, private readonly realtime: RealtimeService) {}

  @Query(() => String, { nullable: true, description: 'Firebase custom token to listen to the change signals of my collections; null when real-time sync is off.' })
  async realtimeToken(@Context('req') request: { headers: { authorization?: string } }): Promise<string | null> {
    const user = await this.auth.currentUser(request.headers.authorization);
    return this.realtime.token(user.id);
  }
}
