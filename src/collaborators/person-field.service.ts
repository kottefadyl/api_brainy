// T54: collaborator fields. A value names one or more people chosen among the collection owner and the
// owner's collaborators. The value keeps the people's IDs and, as readable text, their names at saving time.
import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { User } from '../auth/user.schema';
import { Collection, CollectionFormat, FieldKind } from '../collections/collection.schema';
import { EntryValue } from '../collections/entry.schema';
import { Collaboration } from './collaborator.schema';
import type { PersonSummary } from './entry-authors.resolver';

export const MAX_PEOPLE_PER_VALUE = 20;

/** Parses the client value: a JSON array of distinct user IDs (1 to 20). */
export function parsePersonIds(text: string, fieldName: string): string[] {
  let ids: unknown;
  try { ids = JSON.parse(text); } catch { throw new BadRequestException(`${fieldName} needs collaborators`); }
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_PEOPLE_PER_VALUE || ids.some((id) => typeof id !== 'string' || !Types.ObjectId.isValid(id)) || new Set(ids).size !== ids.length) {
    throw new BadRequestException(`${fieldName} needs collaborators`);
  }
  return ids as string[];
}

@Injectable()
export class PersonFieldService {
  constructor(
    @InjectModel(Collaboration.name) private readonly collaborations: Model<Collaboration>,
    @InjectModel(User.name) private readonly users: Model<User>,
  ) {}

  /** The people a collaborator field of this collection can name: the owner first, then the owner's collaborators. */
  async people(collection: Pick<Collection, 'ownerId'>): Promise<PersonSummary[]> {
    const ownerId = collection.ownerId;
    const rows = await this.collaborations.find({ userIds: ownerId }).select('userIds').lean().exec();
    const ids = [ownerId, ...rows.map((row) => row.userIds.find((id) => id !== ownerId)).filter((id): id is string => !!id)]
      .filter((id) => Types.ObjectId.isValid(id));
    const found = await this.users.aggregate<{ _id: Types.ObjectId; name: string; hasPhoto: boolean }>([
      { $match: { _id: { $in: ids.map((id) => new Types.ObjectId(id)) } } },
      { $project: { name: 1, hasPhoto: { $gt: [{ $strLenBytes: { $ifNull: ['$profilePhoto', ''] } }, 0] } } },
    ]).exec();
    const byId = new Map(found.map((row) => [String(row._id), row]));
    const others = ids.slice(1).flatMap((id) => {
      const row = byId.get(id);
      return row ? [{ userId: id, name: row.name, hasPhoto: row.hasPhoto }] : [];
    }).sort((a, b) => a.name.localeCompare(b.name));
    const owner = byId.get(ownerId);
    return [...(owner ? [{ userId: ownerId, name: owner.name, hasPhoto: owner.hasPhoto }] : []), ...others];
  }

  /**
   * Checks the people of every collaborator field and writes their names as the readable value.
   * A person kept from the previous version of the entry stays allowed after a collaboration ends.
   */
  async bind(collection: Collection, format: CollectionFormat, values: EntryValue[], previous: EntryValue[] = []): Promise<void> {
    const targets = values.filter((value) => format.fields.some((field) => field.id === value.fieldId && field.kind === FieldKind.COLLABORATOR));
    if (!targets.length) return;
    const people = new Map((await this.people(collection)).map((person) => [person.userId, person.name]));
    for (const value of targets) {
      const field = format.fields.find((item) => item.id === value.fieldId)!;
      const kept = previous.find((item) => item.fieldId === value.fieldId);
      const ids = value.personIds ?? [];
      const names = ids.map((id) => {
        const name = people.get(id);
        if (name) return name;
        const index = kept?.personIds?.indexOf(id) ?? -1;
        if (index >= 0) return kept!.personNames?.[index] ?? '?';
        throw new BadRequestException(`${field.name} can only name the collection owner or their collaborators`);
      });
      value.personNames = names;
      value.value = names.join(', ');
    }
  }
}
