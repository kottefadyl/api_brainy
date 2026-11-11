import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuthService } from './auth.service';
import { AuthPayload, LoginInput, ProfileInput, RegisterInput } from './auth.types';
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

  @Query(() => String, { nullable: true })
  async profilePhoto(@Context('req') request: GraphqlRequest): Promise<string | null> {
    const user = await this.auth.currentUser(request.headers.authorization);
    return this.auth.profilePhoto(user.id);
  }

  @Mutation(() => User)
  async updateProfilePhoto(
    @Args('photo', { type: () => String, nullable: true }) photo: string | null,
    @Context('req') request: GraphqlRequest,
  ): Promise<User> {
    const user = await this.auth.currentUser(request.headers.authorization);
    return this.auth.updateProfilePhoto(user.id, photo);
  }

  @Mutation(() => User)
  async updateProfile(
    @Args('input') input: ProfileInput,
    @Context('req') request: GraphqlRequest,
  ): Promise<User> {
    const user = await this.auth.currentUser(request.headers.authorization);
    return this.auth.updateProfile(user.id, input);
  }

  @Mutation(() => User)
  async setOnboardingCompleted(@Args('completed') completed: boolean, @Context('req') request: GraphqlRequest): Promise<User> {
    const user = await this.auth.currentUser(request.headers.authorization);
    return this.auth.setOnboardingCompleted(user.id, completed);
  }
}
