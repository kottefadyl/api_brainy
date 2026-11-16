// GraphQL for the one-click checkbox of the entry list.
import { Args, Context, Mutation, Resolver } from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service.js';
import { Entry } from './entry.schema.js';
import { EntryCheckboxService } from './entry-checkbox.service.js';
import { ReminderService } from './reminder.service.js';

type Request = { headers: { authorization?: string } };

@Resolver(() => Entry)
export class EntryCheckboxResolver {
  constructor(private readonly auth: AuthService, private readonly service: EntryCheckboxService, private readonly reminders: ReminderService) {}

  @Mutation(() => Entry, { description: 'Checks or unchecks one checkbox (yes/no) field of an entry; owner or read-and-write collaborator.' })
  async setEntryCheckbox(
    @Args('entryId') entryId: string,
    @Args('fieldId') fieldId: string,
    @Args('checked') checked: boolean,
    @Args('expectedUpdatedAt', { type: () => String, nullable: true }) expectedUpdatedAt: string | undefined,
    @Context('req') request: Request,
  ): Promise<Entry> {
    const userId = (await this.auth.currentUser(request.headers.authorization)).id;
    const entry = await this.service.set(entryId, fieldId, checked, userId, expectedUpdatedAt);
    await this.reminders.refreshEntry(entryId, userId);
    return entry;
  }
}
