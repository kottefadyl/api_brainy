// T44 — GraphQL surface for large files stored by reference.
import { Args, Context, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service';
import { LargeFileLink, LargeFileStatus, LargeFileUpload, StartLargeFileUploadInput } from './large-file.schema';
import { LargeFileService } from './large-file.service';

type Request = { headers: { authorization?: string } };

@Resolver()
export class LargeFileResolver {
  constructor(private readonly service: LargeFileService, private readonly auth: AuthService) {}
  private async actor(request: Request): Promise<string> { return (await this.auth.currentUser(request.headers.authorization)).id; }

  @Mutation(() => LargeFileUpload)
  async startLargeFileUpload(@Args('collectionId') collectionId: string, @Args('input') input: StartLargeFileUploadInput, @Context('req') request: Request) { return this.service.start(collectionId, input, await this.actor(request)); }

  @Mutation(() => LargeFileUpload)
  async uploadLargeFilePart(@Args('uploadId') uploadId: string, @Args('partNumber', { type: () => Int }) partNumber: number, @Args('base64') base64: string, @Args('sha256') sha256: string, @Context('req') request: Request) {
    return this.service.uploadPart(uploadId, partNumber, base64, sha256, await this.actor(request));
  }

  @Query(() => LargeFileUpload)
  async largeFileUpload(@Args('uploadId') uploadId: string, @Context('req') request: Request) { return this.service.status(uploadId, await this.actor(request)); }

  @Mutation(() => LargeFileUpload)
  async completeLargeFileUpload(@Args('uploadId') uploadId: string, @Args('sha256') sha256: string, @Context('req') request: Request) { return this.service.complete(uploadId, sha256, await this.actor(request)); }

  @Mutation(() => Boolean)
  async abortLargeFileUpload(@Args('uploadId') uploadId: string, @Context('req') request: Request) { return this.service.abort(uploadId, await this.actor(request)); }

  @Query(() => LargeFileLink)
  async largeFileDownloadLink(@Args('entryId') entryId: string, @Args('fieldId') fieldId: string, @Context('req') request: Request) { return this.service.link(entryId, fieldId, await this.actor(request)); }

  @Mutation(() => LargeFileStatus)
  async verifyLargeFile(@Args('entryId') entryId: string, @Args('fieldId') fieldId: string, @Context('req') request: Request) { return this.service.verify(entryId, fieldId, await this.actor(request)); }

  @Mutation(() => [LargeFileStatus])
  async checkLargeFiles(@Args('collectionId') collectionId: string, @Context('req') request: Request) { return this.service.check(collectionId, await this.actor(request)); }
}
