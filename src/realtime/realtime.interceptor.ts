// Every successful GraphQL mutation signals the collections it touched, so other people see the change
// without refreshing. The collections are found in the arguments (collectionId, entry or collection IDs)
// and in the result (a collection, an entry, or lists of them).
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { from, mergeMap, type Observable } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { Collection } from '../collections/collection.schema';
import { Entry } from '../collections/entry.schema';
import { RealtimeService } from './realtime.service';

const COLLECTION_KEYS = new Set(['collectionId', 'sourceCollectionId', 'targetCollectionId']);
const MAYBE_ENTRY_OR_COLLECTION_KEYS = new Set(['id', 'entryId', 'objectId', 'fromEntryId', 'toEntryId', 'originalId', 'sourceObjectId']);

type Found = { collections: Set<string>; others: Set<string> };

/** Walks the arguments two levels deep for collection IDs and IDs that may be entries or collections. */
export function idsInArguments(args: unknown, found: Found = { collections: new Set(), others: new Set() }, depth = 0): Found {
  if (!args || typeof args !== 'object' || depth > 2) return found;
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (typeof value === 'string' && Types.ObjectId.isValid(value) && value.length === 24) {
      if (COLLECTION_KEYS.has(key)) found.collections.add(value);
      else if (MAYBE_ENTRY_OR_COLLECTION_KEYS.has(key)) found.others.add(value);
    } else if (value && typeof value === 'object') idsInArguments(value, found, depth + 1);
  }
  return found;
}

/** Collections named by a mutation result: a collection (has formats), or anything with a collectionId. */
export function idsInResult(result: unknown, ids = new Set<string>(), depth = 0): Set<string> {
  if (!result || typeof result !== 'object' || depth > 2) return ids;
  if (Array.isArray(result)) { for (const item of result.slice(0, 200)) idsInResult(item, ids, depth + 1); return ids; }
  const record = result as Record<string, unknown> & { toObject?: () => Record<string, unknown> };
  const plain = typeof record.toObject === 'function' ? record.toObject() : record;
  const id = String(plain.id ?? plain._id ?? '');
  if (Array.isArray(plain.formats) && Types.ObjectId.isValid(id)) ids.add(id);
  if (typeof plain.collectionId === 'string' && Types.ObjectId.isValid(plain.collectionId)) ids.add(plain.collectionId);
  for (const key of ['entry', 'collection', 'entries', 'created']) if (plain[key]) idsInResult(plain[key], ids, depth + 1);
  return ids;
}

@Injectable()
export class RealtimeInterceptor implements NestInterceptor {
  constructor(
    private readonly realtime: RealtimeService,
    private readonly auth: AuthService,
    @InjectModel(Entry.name) private readonly entries: Model<Entry>,
    @InjectModel(Collection.name) private readonly collections: Model<Collection>,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType<GqlContextType>() !== 'graphql' || !this.realtime.enabled) return next.handle();
    const gql = GqlExecutionContext.create(context);
    if (gql.getInfo<{ parentType: { name: string } }>().parentType.name !== 'Mutation') return next.handle();
    const field = gql.getInfo<{ fieldName: string }>().fieldName;
    const actor = this.auth.userIdFromToken(gql.getContext<{ req?: { headers?: { authorization?: string } } }>().req?.headers?.authorization);
    if (!actor) return next.handle();
    // Before the change: an entry about to be deleted still tells which collection it belongs to.
    return from(this.collectionsBefore(field, gql.getArgs(), actor)).pipe(
      mergeMap((before) => next.handle().pipe(mergeMap(async (result: unknown) => {
        await this.realtime.signal([...before, ...idsInResult(result)], actor, field);
        return result;
      }))),
    );
  }

  private async collectionsBefore(field: string, args: unknown, actor: string): Promise<string[]> {
    try {
      const found = idsInArguments(args);
      const others = [...found.others];
      if (others.length) {
        const [entries, collections] = await Promise.all([
          this.entries.find({ _id: { $in: others } }).select('collectionId').lean().exec(),
          this.collections.find({ _id: { $in: others } }).select('_id').lean().exec(),
        ]);
        for (const entry of entries) found.collections.add(entry.collectionId);
        for (const collection of collections) found.collections.add(String(collection._id));
      }
      // Ending a collaboration removes shares in both directions: those collections change for both people.
      const other = (args as { userId?: string }).userId;
      if (field === 'endCollaboration' && other && Types.ObjectId.isValid(other)) {
        const shared = await this.collections.find({ $or: [{ ownerId: actor, 'members.userId': other }, { ownerId: other, 'members.userId': actor }] }).select('_id').lean().exec();
        for (const collection of shared) found.collections.add(String(collection._id));
      }
      return [...found.collections];
    } catch { return []; }
  }
}
