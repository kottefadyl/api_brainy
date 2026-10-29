import { Args, Context, Field, Float, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service';
import { GeoService } from './geo.service';
import { EntryFieldFilterInput } from './collection.input';

type Request = { headers: { authorization?: string } };

@ObjectType()
class GeoPoint {
  @Field() entryId!: string;
  @Field() name!: string;
  @Field(() => Float) latitude!: number;
  @Field(() => Float) longitude!: number;
  @Field(() => Float, { nullable: true }) accuracy?: number;
}
@ObjectType()
class GeoPage {
  @Field(() => [GeoPoint]) points!: GeoPoint[];
  @Field({ nullable: true }) nextCursor?: string;
  @Field() hasMore!: boolean;
}
@ObjectType()
class GeoDistance {
  @Field() value!: string;
  @Field() unit!: string;
}
@ObjectType()
class GeoZoneCount {
  @Field() zoneEntryId!: string;
  @Field() label!: string;
  @Field(() => Int) count!: number;
}
@ObjectType()
class GeoImportError {
  @Field(() => Int) row!: number;
  @Field() message!: string;
}
@ObjectType()
class GeoImportResult {
  @Field(() => Int) count!: number;
  @Field(() => [GeoImportError]) errors!: GeoImportError[];
}

@Resolver()
export class GeoResolver {
  constructor(private readonly service: GeoService, private readonly auth: AuthService) {}
  private async user(request: Request) { return (await this.auth.currentUser(request.headers.authorization)).id; }

  @Query(() => GeoPage)
  async collectionGeoPage(@Args('collectionId') collectionId: string, @Args('formatId') formatId: string, @Args('fieldId') fieldId: string, @Args('first', { type: () => Int }) first: number, @Args('after', { nullable: true }) after: string | undefined, @Args('search', { nullable: true }) search: string | undefined, @Args('filters', { type: () => [EntryFieldFilterInput], nullable: true }) filters: EntryFieldFilterInput[] | undefined, @Args('viewId', { nullable: true }) viewId: string | undefined, @Context('req') request: Request) {
    return this.service.page(collectionId, await this.user(request), formatId, fieldId, first, after, search, filters, viewId);
  }

  @Query(() => GeoDistance)
  async collectionGeoDistance(@Args('collectionId') collectionId: string, @Args('formatId') formatId: string, @Args('fieldId') fieldId: string, @Args('firstEntryId') firstEntryId: string, @Args('secondEntryId') secondEntryId: string, @Args('unit') unit: string, @Context('req') request: Request) {
    return this.service.distance(collectionId, await this.user(request), formatId, fieldId, firstEntryId, secondEntryId, unit);
  }

  @Query(() => [GeoZoneCount])
  async collectionGeoZoneSummary(@Args('collectionId') collectionId: string, @Args('positionFormatId') positionFormatId: string, @Args('positionFieldId') positionFieldId: string, @Args('zoneFormatId') zoneFormatId: string, @Args('zoneFieldId') zoneFieldId: string, @Context('req') request: Request) {
    return this.service.zoneSummary(collectionId, await this.user(request), positionFormatId, positionFieldId, zoneFormatId, zoneFieldId);
  }

  @Query(() => GeoImportResult)
  async previewGeoImport(@Args('collectionId') collectionId: string, @Args('formatId') formatId: string, @Args('fieldId') fieldId: string, @Args('text') input: string, @Args('kind') kind: string, @Context('req') request: Request) {
    return this.service.previewImport(collectionId, await this.user(request), formatId, fieldId, input, kind);
  }

  @Mutation(() => GeoImportResult)
  async importGeoPoints(@Args('collectionId') collectionId: string, @Args('formatId') formatId: string, @Args('fieldId') fieldId: string, @Args('text') input: string, @Args('kind') kind: string, @Args('importKey') importKey: string, @Context('req') request: Request) {
    return this.service.importPoints(collectionId, await this.user(request), formatId, fieldId, input, kind, importKey);
  }

  @Query(() => String)
  async exportGeoPoints(@Args('collectionId') collectionId: string, @Args('formatId') formatId: string, @Args('fieldId') fieldId: string, @Args('kind') kind: string, @Context('req') request: Request) {
    return this.service.exportPoints(collectionId, await this.user(request), formatId, fieldId, kind);
  }
}
