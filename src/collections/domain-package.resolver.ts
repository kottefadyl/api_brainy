import { Args, Context, Field, InputType, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service.js';
import { DomainPackageService } from './domain-package.service.js';
import { DomainPackageExport, DomainPackageInstall, DomainPackageInstallResult, DomainPackagePreview, DomainPackageSummary } from './domain-package.schema.js';

type Request = { headers: { authorization?: string } };

@InputType()
class DomainPackageExportInput {
  @Field() packageId!: string;
  @Field() version!: string;
  @Field() name!: string;
  @Field({ nullable: true }) description?: string;
  @Field({ nullable: true }) notice?: string;
  @Field() author!: string;
  @Field() license!: string;
}

@Resolver()
export class DomainPackageResolver {
  constructor(private readonly packages: DomainPackageService, private readonly auth: AuthService) {}

  private async user(request: Request): Promise<string> { return (await this.auth.currentUser(request.headers.authorization)).id; }

  @Query(() => [DomainPackageSummary])
  domainPackagePilots(@Args('language', { type: () => String, nullable: true }) language?: string): DomainPackageSummary[] {
    return this.packages.pilots(language ?? 'en');
  }

  @Query(() => [DomainPackageInstall])
  async domainPackageInstalls(@Args('collectionId') collectionId: string, @Context('req') request: Request): Promise<DomainPackageInstall[]> {
    return this.packages.listInstalls(collectionId, await this.user(request));
  }

  @Query(() => DomainPackagePreview)
  async previewDomainPackage(@Args('packageJson') packageJson: string, @Args('collectionId', { type: () => String, nullable: true }) collectionId: string | undefined, @Args('language', { type: () => String, nullable: true }) language: string | undefined, @Context('req') request: Request): Promise<DomainPackagePreview> {
    return this.packages.preview(packageJson, await this.user(request), language ?? 'en', collectionId || undefined);
  }

  @Mutation(() => DomainPackageInstallResult)
  async installDomainPackage(@Args('packageJson') packageJson: string, @Args('collectionId', { type: () => String, nullable: true }) collectionId: string | undefined, @Args('collectionName', { type: () => String, nullable: true }) collectionName: string | undefined, @Args('language', { type: () => String, nullable: true }) language: string | undefined, @Context('req') request: Request): Promise<DomainPackageInstallResult> {
    return this.packages.install(packageJson, await this.user(request), language ?? 'en', collectionId || undefined, collectionName);
  }

  @Mutation(() => Boolean)
  async detachDomainPackage(@Args('installId') installId: string, @Context('req') request: Request): Promise<boolean> {
    return this.packages.detach(installId, await this.user(request));
  }

  @Query(() => DomainPackageExport)
  async exportDomainPackage(@Args('collectionId') collectionId: string, @Args('input') input: DomainPackageExportInput, @Args('language', { type: () => String, nullable: true }) language: string | undefined, @Context('req') request: Request): Promise<DomainPackageExport> {
    return this.packages.export(collectionId, await this.user(request), input, language ?? 'en');
  }
}
