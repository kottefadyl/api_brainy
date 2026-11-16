// Choices of a single or multiple choice field that entries actually use: only those must be kept when
// the data format is edited. An unused choice can be renamed or removed freely.
import { Model } from 'mongoose';
import { Entry } from './entry.schema.js';

export async function usedChoices(entries: Model<Entry>, collectionId: string, formatId: string, fieldId: string): Promise<Set<string>> {
  const rows = await entries.aggregate<{ _id: string }>([
    { $match: { collectionId, formatId, 'values.fieldId': fieldId } },
    { $unwind: '$values' },
    { $match: { 'values.fieldId': fieldId } },
    { $project: { choices: { $ifNull: ['$values.selectedValues', ['$values.value']] } } },
    { $unwind: '$choices' },
    { $group: { _id: '$choices' } },
  ]).exec();
  return new Set(rows.map((row) => row._id));
}
