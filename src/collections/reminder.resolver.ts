import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service';
import { EntryReminderInput } from './collection.input';
import { EntryReminder, PushDevice, ReminderCapabilities } from './reminder.schema';
import { ReminderService } from './reminder.service';

type Request = { headers: { authorization?: string } };

@Resolver(() => EntryReminder)
export class ReminderResolver {
  constructor(private readonly service: ReminderService, private readonly auth: AuthService) {}
  private async ownerId(request: Request): Promise<string> { return (await this.auth.currentUser(request.headers.authorization)).id; }

  @Query(() => ReminderCapabilities)
  async reminderCapabilities(@Context('req') request: Request): Promise<ReminderCapabilities> { await this.ownerId(request); return this.service.capabilities(); }

  @Query(() => [EntryReminder])
  async entryReminders(@Args('entryId') entryId: string, @Context('req') request: Request): Promise<EntryReminder[]> { return this.service.list(entryId, await this.ownerId(request)); }

  @Mutation(() => EntryReminder)
  async saveEntryReminder(@Args('entryId') entryId: string, @Args('input') input: EntryReminderInput, @Args('reminderId', { type: () => String, nullable: true }) reminderId: string | undefined, @Context('req') request: Request): Promise<EntryReminder> { return this.service.save(entryId, await this.ownerId(request), input, reminderId); }

  @Mutation(() => Boolean)
  async cancelEntryReminder(@Args('reminderId') reminderId: string, @Context('req') request: Request): Promise<boolean> { return this.service.cancel(reminderId, await this.ownerId(request)); }

  @Query(() => [PushDevice])
  async pushDevices(@Context('req') request: Request): Promise<PushDevice[]> { return this.service.devicesFor(await this.ownerId(request)); }

  @Mutation(() => PushDevice)
  async registerPushDevice(@Args('token') token: string, @Args('platform') platform: string, @Args('label') label: string, @Args('targetKind', { type: () => String, nullable: true }) targetKind: string | undefined, @Context('req') request: Request): Promise<PushDevice> { return this.service.registerDevice(await this.ownerId(request), token, platform, label, targetKind); }

  @Mutation(() => Boolean)
  async unregisterPushDevice(@Args('id') id: string, @Context('req') request: Request): Promise<boolean> { return this.service.unregisterDevice(await this.ownerId(request), id); }
}
