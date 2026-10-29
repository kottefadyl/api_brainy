import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service';
import { Collection } from './collection.schema';
import { Entry } from './entry.schema';
import { WorkflowAssignmentInput, WorkflowDefinitionInput, WorkflowNotification } from './workflow.schema';
import { WorkflowService } from './workflow.service';

type Request = { headers: { authorization?: string } };

@Resolver()
export class WorkflowResolver {
  constructor(private readonly service: WorkflowService, private readonly auth: AuthService) {}
  private async actor(request: Request): Promise<string> { return (await this.auth.currentUser(request.headers.authorization)).id; }

  @Mutation(() => Collection)
  async setCollectionFormatWorkflow(@Args('collectionId') collectionId: string, @Args('formatId') formatId: string, @Args('input') input: WorkflowDefinitionInput, @Context('req') request: Request): Promise<Collection> {
    return this.service.configure(collectionId, formatId, input, await this.actor(request));
  }

  @Mutation(() => Collection)
  async addCollectionWorkflowTemplate(@Args('collectionId') collectionId: string, @Args('templateId') templateId: string, @Args('color') color: string, @Args('language', { type: () => String, nullable: true }) language: string | undefined, @Context('req') request: Request): Promise<Collection> {
    return this.service.addTemplate(collectionId, templateId, color, language, await this.actor(request));
  }

  @Mutation(() => Entry)
  async transitionWorkflowEntry(@Args('entryId') entryId: string, @Args('to') to: string, @Args('expectedUpdatedAt') expectedUpdatedAt: string, @Context('req') request: Request): Promise<Entry> {
    return this.service.transition(entryId, to, expectedUpdatedAt, await this.actor(request));
  }

  @Mutation(() => Entry)
  async assignWorkflowEntry(@Args('entryId') entryId: string, @Args('input') input: WorkflowAssignmentInput, @Context('req') request: Request): Promise<Entry> {
    return this.service.assign(entryId, input, await this.actor(request));
  }

  @Query(() => [WorkflowNotification])
  async workflowNotifications(@Context('req') request: Request): Promise<WorkflowNotification[]> {
    return this.service.notificationsFor(await this.actor(request));
  }

  @Mutation(() => Boolean)
  async readWorkflowNotification(@Args('id') id: string, @Context('req') request: Request): Promise<boolean> {
    return this.service.readNotification(id, await this.actor(request));
  }
}
