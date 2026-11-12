// T53: who created an entry and who changed it last, with the photo shown to people who share a collection.
import { Args, Context, Field, ID, ObjectType, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuthService } from '../auth/auth.service.js';
import { User } from '../auth/user.schema.js';
import { Collection } from '../collections/collection.schema.js';
import { Entry } from '../collections/entry.schema.js';
import { CollaboratorsService } from './collaborators.service.js';

@ObjectType()
export class PersonSummary {
  @Field(() => ID)
  userId!: string;

  @Field()
  name!: string;

  @Field()
  hasPhoto!: boolean;
}

type Request = { headers: { authorization?: string }; brainyViewerId?: Promise<string>; brainyPeople?: Map<string, Promise<PersonSummary | null>> };

@Resolver(() => Entry)
export class EntryAuthorsResolver {
  constructor(
    private readonly auth: AuthService,
    private readonly collaborators: CollaboratorsService,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Collection.name) private readonly collections: Model<Collection>,
  ) {}

  /** Name and photo flag of one person, read once per request without loading the photo itself. */
  private person(request: Request, userId?: string): Promise<PersonSummary | null> {
    if (!userId || !Types.ObjectId.isValid(userId)) return Promise.resolve(null);
    request.brainyPeople ??= new Map();
    let found = request.brainyPeople.get(userId);
    if (!found) {
      found = this.users.aggregate<{ _id: Types.ObjectId; name: string; hasPhoto: boolean }>([
        { $match: { _id: new Types.ObjectId(userId) } },
        { $project: { name: 1, hasPhoto: { $gt: [{ $strLenBytes: { $ifNull: ['$profilePhoto', ''] } }, 0] } } },
      ]).exec().then(([row]) => row ? { userId, name: row.name, hasPhoto: row.hasPhoto } : null);
      request.brainyPeople.set(userId, found);
    }
    return found;
  }

  @ResolveField(() => PersonSummary, { nullable: true, description: 'Person who created the entry (the owner for older entries).' })
  createdBy(@Parent() entry: Entry & { ownerId?: string }, @Context('req') request: Request): Promise<PersonSummary | null> {
    return this.person(request, entry.createdBy ?? entry.ownerId);
  }

  @ResolveField(() => PersonSummary, { nullable: true, description: 'Last person who changed the entry.' })
  updatedBy(@Parent() entry: Entry & { ownerId?: string }, @Context('req') request: Request): Promise<PersonSummary | null> {
    return this.person(request, entry.updatedBy ?? entry.createdBy ?? entry.ownerId);
  }

  /** Photo of yourself, a collaborator or someone who shares a collection with you. */
  @Query(() => String, { nullable: true })
  async personPhoto(@Args('userId') userId: string, @Context('req') request: Request): Promise<string | null> {
    const viewerId = (await this.auth.currentUser(request.headers.authorization)).id;
    if (!Types.ObjectId.isValid(userId)) return null;
    const allowed = viewerId === userId
      || await this.collaborators.isCollaborator(viewerId, userId)
      || !!(await this.collections.exists({
        $and: [
          { $or: [{ ownerId: viewerId }, { 'members.userId': viewerId }] },
          { $or: [{ ownerId: userId }, { 'members.userId': userId }] },
        ],
      }).exec());
    if (!allowed) return null;
    return (await this.users.findById(userId).select('+profilePhoto').exec())?.profilePhoto ?? null;
  }
}
