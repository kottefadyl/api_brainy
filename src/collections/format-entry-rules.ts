import { BadRequestException } from '@nestjs/common';
import { Model } from 'mongoose';
import { Collection, CollectionFormat } from './collection.schema';
import { Entry } from './entry.schema';

/** T47: generic data format rules, reusable outside books. */

/** Refuses a new entry when the data format allows a single entry and one already exists. */
export async function assertRoomForEntries(entries: Model<Entry>, collection: Collection, format: CollectionFormat, adding = 1): Promise<void> {
  if (!format.singleEntry) return;
  if (adding > 1) throw new BadRequestException(`${format.name} can only have one entry`);
  const existing = await entries.countDocuments({ collectionId: collection.id, formatId: format.id }).exec();
  if (existing + adding > 1) throw new BadRequestException(`${format.name} can only have one entry. Edit the existing one`);
}

/** Parent formats still present in the collection; an empty result means "no rule". */
export function activeParentFormatIds(collection: Collection, format: CollectionFormat | undefined): string[] {
  return (format?.parentFormatIds ?? []).filter((id) => id !== format?.id && collection.formats.some((item) => item.id === id));
}

/** Refuses a parent relation whose parent format is not one the child format allows. */
export function assertParentAllowed(collection: Collection, childFormatId: string, parentFormatId: string): void {
  const child = collection.formats.find((item) => item.id === childFormatId);
  const allowed = activeParentFormatIds(collection, child);
  if (!allowed.length || allowed.includes(parentFormatId)) return;
  const names = allowed.map((id) => collection.formats.find((item) => item.id === id)!.name).join(', ');
  throw new BadRequestException(`${child!.name} can only be placed under: ${names}`);
}

export function validatedParentFormatIds(collection: Collection, formatId: string, ids: string[]): string[] {
  const unique = [...new Set(ids)];
  if (unique.length > 24 || unique.some((id) => id === formatId || !collection.formats.some((item) => item.id === id))) throw new BadRequestException('Choose other data formats of this collection as parents');
  return unique;
}
