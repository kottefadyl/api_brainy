import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service';
import { Collection } from './collection.schema';
import { Entry } from './entry.schema';
import { TaskAgenda } from './task-planner.schema';
import { TaskPlannerService } from './task-planner.service';

type Request = { headers: { authorization?: string } };

/** T49: Day and Calendar views of the Task list template. */
@Resolver()
export class TaskPlannerResolver {
  constructor(private readonly service: TaskPlannerService, private readonly auth: AuthService) {}
  private async user(request: Request): Promise<string> { return (await this.auth.currentUser(request.headers.authorization)).id; }

  @Query(() => TaskAgenda)
  async taskAgenda(@Args('collectionId') collectionId: string, @Args('from') from: string, @Args('to') to: string, @Args('today') today: string, @Args('timeZone') timeZone: string, @Context('req') request: Request): Promise<TaskAgenda> {
    return this.service.agenda(collectionId, await this.user(request), from, to, today, timeZone);
  }

  @Mutation(() => Entry)
  async setTaskDayDone(@Args('collectionId') collectionId: string, @Args('entryId') entryId: string, @Args('date') date: string, @Args('done') done: boolean, @Args('timeZone') timeZone: string, @Context('req') request: Request): Promise<Entry> {
    return this.service.setDone(collectionId, await this.user(request), entryId, date, done, timeZone);
  }

  @Mutation(() => Collection)
  async enableTaskPlanner(@Args('collectionId') collectionId: string, @Args('language', { type: () => String, nullable: true }) language: string | undefined, @Context('req') request: Request): Promise<Collection> {
    return this.service.enableForLegacy(collectionId, await this.user(request), language);
  }
}
