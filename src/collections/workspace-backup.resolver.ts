import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service.js';
import { WorkspaceBackupPreview } from './workspace-backup.schema.js';
import { WorkspaceBackupService } from './workspace-backup.service.js';

type Request = { headers: { authorization?: string } };
@Resolver()
export class WorkspaceBackupResolver {
  constructor(private readonly backup: WorkspaceBackupService, private readonly auth: AuthService) {}
  private async user(request: Request): Promise<string> { return (await this.auth.currentUser(request.headers.authorization)).id; }
  @Query(() => String)
  async workspaceBackup(@Args('includeSensitive', { type: () => Boolean, nullable: true }) includeSensitive: boolean | undefined, @Context('req') request: Request): Promise<string> { return this.backup.export(await this.user(request), includeSensitive === true); }
  @Mutation(() => WorkspaceBackupPreview)
  async restoreWorkspaceBackup(@Args('archive') archive: string, @Args('dryRun') dryRun: boolean, @Context('req') request: Request): Promise<WorkspaceBackupPreview> { return this.backup.restore(archive, await this.user(request), dryRun); }
}
