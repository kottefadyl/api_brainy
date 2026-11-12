import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Args, Context, Mutation, Query, Resolver } from '@nestjs/graphql';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AuthService } from '../auth/auth.service';
import { bookAlignments, bookFonts, bookPageSizes, BookViewSettingsInput, defaultBookView } from './book-view.schema';

/** T47/3: book roles the owner can give to any data format (front and back matter stay with the template formats). */
export const assignableBookRoles = ['PART', 'CHAPTER', 'SECTION', 'SUBSECTION', 'APPENDIX', 'TERM', 'SOURCE'] as const;
import { CollectionRole } from './collaboration.schema';
import { CollaborationService } from './collaboration.service';
import { Collection } from './collection.schema';
import { CollectionsService } from './collections.service';
import { Entry } from './entry.schema';
import { validatedParentFormatIds } from './format-entry-rules';
import { EntryRelation, RelationKind } from './relation.schema';

type Request = { headers: { authorization?: string } };
const between = (value: number, min: number, max: number) => Number.isFinite(value) && value >= min && value <= max;

/** T47: format entry rules (single entry, allowed parents) and book view settings. */
@Resolver()
export class BookResolver {
  constructor(
    private readonly collections: CollectionsService,
    private readonly collaboration: CollaborationService,
    private readonly auth: AuthService,
    @InjectModel(Collection.name) private readonly collectionModel: Model<Collection>,
    @InjectModel(Entry.name) private readonly entries: Model<Entry>,
    @InjectModel(EntryRelation.name) private readonly relations: Model<EntryRelation>,
  ) {}

  private async user(request: Request): Promise<string> { return (await this.auth.currentUser(request.headers.authorization)).id; }

  /** Every active parent relation of the collection, used to build the book outline in one call. */
  @Query(() => [EntryRelation])
  async collectionParentRelations(@Args('collectionId') collectionId: string, @Context('req') request: Request): Promise<EntryRelation[]> {
    const collection = await this.collections.one(collectionId, await this.user(request));
    return this.relations.find({ collectionId: collection.id, kind: RelationKind.PARENT, deletedAt: null }).limit(20000).exec();
  }

  @Mutation(() => Collection)
  async setFormatEntryRules(@Args('collectionId') collectionId: string, @Args('formatId') formatId: string, @Args('singleEntry') singleEntry: boolean, @Args('parentFormatIds', { type: () => [String] }) parentFormatIds: string[], @Context('req') request: Request): Promise<Collection> {
    const userId = await this.user(request);
    const collection = await this.collections.one(collectionId, userId);
    this.collaboration.checkAccess(collection, userId, CollectionRole.OWNER);
    if (!collection.formats.some((item) => item.id === formatId)) throw new NotFoundException('Data format not found in this collection');
    const parents = validatedParentFormatIds(collection, formatId, parentFormatIds);
    if (singleEntry && await this.entries.countDocuments({ collectionId, formatId }).exec() > 1) throw new BadRequestException('This data format already has several entries. Keep one before allowing a single entry');
    const updated = await this.collectionModel.findOneAndUpdate({ _id: collectionId, 'formats.id': formatId }, { $set: { 'formats.$.singleEntry': singleEntry, 'formats.$.parentFormatIds': parents } }, { returnDocument: 'after' }).exec();
    if (!updated) throw new NotFoundException('Data format not found in this collection');
    await this.collaboration.logAction(collectionId, userId, 'UPDATE_FORMAT', 'Updated data format entry rules');
    return updated;
  }

  @Mutation(() => Collection)
  async setBookView(@Args('collectionId') collectionId: string, @Args('input') input: BookViewSettingsInput, @Context('req') request: Request): Promise<Collection> {
    const userId = await this.user(request);
    const collection = await this.collections.one(collectionId, userId);
    this.collaboration.checkAccess(collection, userId, CollectionRole.EDITOR);
    if (collection.templateId !== 'book') throw new BadRequestException('The book view is only available in collections created from the Book template');
    const valid = (bookFonts as readonly string[]).includes(input.bodyFont) && (bookFonts as readonly string[]).includes(input.headingFont)
      && (bookPageSizes as readonly string[]).includes(input.pageSize) && (bookAlignments as readonly string[]).includes(input.textAlign)
      && between(input.fontSize, 10, 32) && between(input.lineHeight, 1, 3) && between(input.paragraphSpacing, 0, 3)
      && between(input.firstLineIndent, 0, 4) && between(input.marginMm, 5, 50);
    if (!valid) throw new BadRequestException('Invalid book view settings');
    const roles = collection.bookView?.roles ?? [];
    const bookView = { ...defaultBookView(roles), ...input, roles };
    const updated = await this.collectionModel.findOneAndUpdate({ _id: collectionId }, { $set: { bookView } }, { returnDocument: 'after' }).exec();
    if (!updated) throw new NotFoundException('Collection not found');
    return updated;
  }

  /** T47/3: shows a data format in the book with a role (chapter, section…), or hides it with no role. */
  @Mutation(() => Collection)
  async setBookFormatRole(@Args('collectionId') collectionId: string, @Args('formatId') formatId: string, @Args('role', { type: () => String, nullable: true }) role: string | null | undefined, @Context('req') request: Request): Promise<Collection> {
    const userId = await this.user(request);
    const collection = await this.collections.one(collectionId, userId);
    this.collaboration.checkAccess(collection, userId, CollectionRole.OWNER);
    if (collection.templateId !== 'book') throw new BadRequestException('The book view is only available in collections created from the Book template');
    if (!collection.formats.some((item) => item.id === formatId)) throw new NotFoundException('Data format not found in this collection');
    if (role != null && !(assignableBookRoles as readonly string[]).includes(role)) throw new BadRequestException('Choose a part, chapter, section, sub-section, appendix, term or source');
    const roles = [...(collection.bookView?.roles ?? []).filter((item) => item.formatId !== formatId), ...(role ? [{ formatId, role }] : [])];
    const update = collection.bookView ? { 'bookView.roles': roles } : { bookView: defaultBookView(roles, false) };
    const updated = await this.collectionModel.findOneAndUpdate({ _id: collectionId }, { $set: update }, { returnDocument: 'after' }).exec();
    if (!updated) throw new NotFoundException('Collection not found');
    await this.collaboration.logAction(collectionId, userId, 'UPDATE_FORMAT', 'Updated the book role of a data format');
    return updated;
  }
}
