// T54: people a collaborator field can name in a collection (owner and the owner's collaborators).
import { Args, Context, ID, Query, Resolver } from '@nestjs/graphql';
import { InjectModel } from '@nestjs/mongoose';
import { NotFoundException } from '@nestjs/common';
import { Model, Types } from 'mongoose';
import { AuthService } from '../auth/auth.service.js';
import { Collection } from '../collections/collection.schema.js';
import { PersonSummary } from './entry-authors.resolver.js';
import { PersonFieldService } from './person-field.service.js';

type Request = { headers: { authorization?: string } };

@Resolver()
export class PersonFieldResolver {
  constructor(
    private readonly auth: AuthService,
    private readonly service: PersonFieldService,
    @InjectModel(Collection.name) private readonly collections: Model<Collection>,
  ) {}

  @Query(() => [PersonSummary], { description: 'People a collaborator field of this collection can name: the owner, then the owner\'s collaborators.' })
  async collectionPeople(@Args('collectionId', { type: () => ID }) collectionId: string, @Context('req') request: Request): Promise<PersonSummary[]> {
    const viewerId = (await this.auth.currentUser(request.headers.authorization)).id;
    const collection = Types.ObjectId.isValid(collectionId)
      ? await this.collections.findOne({ _id: collectionId, $or: [{ ownerId: viewerId }, { 'members.userId': viewerId }] }).select('ownerId').lean().exec()
      : null;
    if (!collection) throw new NotFoundException('Collection not found');
    return this.service.people(collection);
  }
}
