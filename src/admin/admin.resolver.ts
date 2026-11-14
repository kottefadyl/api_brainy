import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
type Request = { headers: { authorization?: string } };
import { AdminService } from './admin.service.js';
import { AdminErasure, AdminOverview } from './admin.types.js';

/** Administration panel (web `/admin`): every call checks the administrator again. */
@Resolver()
export class AdminResolver {
  constructor(private readonly admin: AdminService) {}

  @Query(() => Boolean, { description: 'True when the signed-in account may open the administration' })
  adminAccess(@Context('req') request: Request): Promise<boolean> {
    return this.admin.isAdministrator(request.headers.authorization);
  }

  @Query(() => AdminOverview)
  async adminOverview(@Context('req') request: Request): Promise<AdminOverview> {
    await this.admin.administrator(request.headers.authorization);
    return this.admin.overview();
  }

  @Mutation(() => Boolean)
  async adminSetUserBlocked(@Args('userId') userId: string, @Args('blocked') blocked: boolean, @Context('req') request: Request): Promise<boolean> {
    return this.admin.setBlocked(userId, blocked, await this.admin.administrator(request.headers.authorization));
  }

  @Mutation(() => AdminErasure, { description: 'Removes everything the account owns; with deleteAccount the account goes too' })
  async adminEraseUser(@Args('userId') userId: string, @Args('confirmEmail') confirmEmail: string, @Args('deleteAccount') deleteAccount: boolean, @Context('req') request: Request): Promise<AdminErasure> {
    return this.admin.erase(userId, confirmEmail, deleteAccount, await this.admin.administrator(request.headers.authorization));
  }
}
