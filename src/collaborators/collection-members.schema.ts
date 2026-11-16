// GraphQL types of the paged member list of a shared collection.
import { Field, Int, ObjectType } from '@nestjs/graphql';
import { CollectionRole } from '../collections/collaboration.schema.js';

@ObjectType()
export class CollectionMemberSummary {
  @Field() userId!: string;
  @Field() name!: string;
  @Field() email!: string;
  @Field(() => CollectionRole) role!: CollectionRole;
  @Field() addedAt!: Date;
  @Field() hasPhoto!: boolean;
}

@ObjectType()
export class CollectionMembersPage {
  @Field(() => Int) total!: number;
  @Field(() => Int) offset!: number;
  @Field(() => [CollectionMemberSummary]) items!: CollectionMemberSummary[];
}
