import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuthService } from './auth.service';
import { AuthPayload, LoginInput, RegisterInput } from './auth.types';
import { User } from './user.schema';

type GraphqlRequest = { headers: { authorization?: string } };

@Resolver()
export class AuthResolver {
  constructor(private readonly auth: AuthService) {}

  @Mutation(() => AuthPayload)
  register(@Args('input') input: RegisterInput): Promise<AuthPayload> {
    return this.auth.register(input);
  }

  @Mutation(() => AuthPayload)
  login(@Args('input') input: LoginInput): Promise<AuthPayload> {
    return this.auth.login(input);
  }

  @Mutation(() => AuthPayload)
  loginWithGoogle(@Args('firebaseIdToken') firebaseIdToken: string): Promise<AuthPayload> {
    return this.auth.loginWithGoogle(firebaseIdToken);
  }

  @Query(() => User)
  me(@Context('req') request: GraphqlRequest): Promise<User> {
    return this.auth.currentUser(request.headers.authorization);
  }
}
