import { Args, Context, Query, Resolver } from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service.js';
import { LinkPreview, LinkPreviewService } from './link-preview.service.js';

type Request = { headers: { authorization?: string } };

/** T48: signed-in users only, so the API is never an open proxy. */
@Resolver(() => LinkPreview)
export class LinkPreviewResolver {
  constructor(private readonly service: LinkPreviewService, private readonly auth: AuthService) {}

  @Query(() => LinkPreview)
  async linkPreview(@Args('url') url: string, @Context('req') request: Request): Promise<LinkPreview> {
    return this.service.preview(url, (await this.auth.currentUser(request.headers.authorization)).id);
  }
}
