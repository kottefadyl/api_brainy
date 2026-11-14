import { BadRequestException } from '@nestjs/common';
import { Model } from 'mongoose';
import { Collection, CollectionFormat } from './collection.schema.js';
import { CollectionMember } from './collaboration.schema.js';
import { Entry, EntryValue } from './entry.schema.js';
import { protectedFields } from './sensitivity.logic.js';

/** T47: generic data format rules, reusable outside books. */

/** Most entries a data format accepts; undefined = no limit. `singleEntry` (T47) is a limit of 1. */
export function entryLimit(format: CollectionFormat): number | undefined {
  return format.maxEntries ?? (format.singleEntry ? 1 : undefined);
}

export const MAX_ENTRIES_LIMIT = 1_000_000;

/** A chosen limit: a whole number from 1; empty (null, undefined or 0) = no limit. */
export function validatedMaxEntries(value: number | null | undefined): number | undefined {
  if (value == null || value === 0) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > MAX_ENTRIES_LIMIT) throw new BadRequestException('The number of entries must be a whole number from 1');
  return value;
}

/** Refuses new entries beyond the data format's limit. */
export async function assertRoomForEntries(entries: Model<Entry>, collection: Collection, format: CollectionFormat, adding = 1): Promise<void> {
  const limit = entryLimit(format);
  if (limit == null) return;
  if (limit === 1 && adding > 1) throw new BadRequestException(`${format.name} can only have one entry`);
  const existing = await entries.countDocuments({ collectionId: collection.id, formatId: format.id }).exec();
  if (existing + adding <= limit) return;
  if (limit === 1) throw new BadRequestException(`${format.name} can only have one entry. Edit the existing one`);
  throw new BadRequestException(`${format.name} can only have ${limit} entries`);
}

/**
 * Refuses an entry that leaves a required field empty. A collaborator is only held to the fields shared
 * with them: a field they cannot see is never required from them.
 */
export function assertRequiredFields(format: CollectionFormat, values: EntryValue[], member?: CollectionMember): void {
  const filled = new Set(values.map((value) => value.fieldId));
  const hidden = member ? protectedFields(format) : new Set<string>();
  const shared = member?.sharedFieldIds?.length ? new Set(member.sharedFieldIds) : undefined;
  const missing = format.fields.filter((field) => field.required && !filled.has(field.id)
    && (!shared || shared.has(field.id)) && (!hidden.has(field.id) || member?.sensitiveFieldIds?.includes(field.id)));
  if (missing.length) throw new BadRequestException(`Required fields are empty: ${missing.map((field) => field.name).join(', ')}`);
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
