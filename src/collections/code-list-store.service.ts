import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { CollaborationService } from './collaboration.service';
import { CollectionRole } from './collaboration.schema';
import { ClassificationCode, ClassificationList, Collection, FieldKind } from './collection.schema';
import { ClassificationService } from './classification.service';
import { codeHierarchy, EMBEDDED_CODE_LIMIT, foldSearch, MAX_REFERENTIAL_CODES, parseReferential, validateClassificationCodes } from './classification.logic';
import { StoredCode } from './code-list-store.schema';

export type ReferentialFormat = 'CSV' | 'JSON';
export type FoundCode = { code: string; label: string; path: string[]; level: number; active: boolean; hasChildren: boolean };

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Large code lists (T39/3) and referential imports (T39/1). Lists of up to
 * 5,000 codes stay in the collection document as before; larger ones, up to
 * 50,000, are stored apart and searched here, so that no response carries
 * the whole list.
 */
@Injectable()
export class CodeListStore {
  constructor(
    @InjectModel(Collection.name) private readonly collections: Model<Collection>,
    @InjectModel(StoredCode.name) private readonly codes: Model<StoredCode>,
    private readonly collaboration: CollaborationService,
    private readonly classification: ClassificationService,
  ) {}

  private async context(id: string, userId: string, role = CollectionRole.READER): Promise<Collection> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Collection not found');
    const collection = await this.collections.findById(id).exec();
    if (!collection) throw new NotFoundException('Collection not found');
    this.collaboration.checkAccess(collection, userId, role);
    return collection;
  }

  private list(collection: Collection, id: string): ClassificationList {
    const list = (collection.codeLists ?? []).find((item) => item.id === id);
    if (!list) throw new NotFoundException('Code list not found');
    return list;
  }

  preview(format: ReferentialFormat, content: string) {
    const { codes, errors } = parseReferential(format, content);
    const levels = codeHierarchy(codes).levels;
    return { codeCount: codes.length, levels: Math.max(0, ...levels.values()), large: codes.length > EMBEDDED_CODE_LIMIT, errors, sample: codes.slice(0, 20) };
  }

  /** Creates a list, or replaces one keeping every existing code, from a referential file. */
  async importReferential(collectionId: string, userId: string, name: string, format: ReferentialFormat, content: string, listId?: string, expectedVersion?: number): Promise<Collection> {
    const { codes: parsed, errors } = parseReferential(format, content);
    if (errors.length) throw new BadRequestException(`Referential has errors: row ${errors[0].row}: ${errors[0].message}`);
    const collection = await this.context(collectionId, userId, CollectionRole.OWNER);
    const prior = listId ? this.list(collection, listId) : undefined;
    if (parsed.length <= EMBEDDED_CODE_LIMIT && !prior?.external) return this.classification.save(collectionId, userId, listId, expectedVersion, name, parsed);
    const codes = validateClassificationCodes(parsed, MAX_REFERENTIAL_CODES);
    const cleanName = name.trim();
    if (!cleanName || cleanName.length > 80) throw new BadRequestException('Code list name must be 1 to 80 characters');
    if ((collection.codeLists ?? []).some((item) => item.id !== listId && item.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase())) throw new BadRequestException('Code list names must be unique');
    if (prior) {
      if (expectedVersion !== prior.version) throw new BadRequestException('Code list changed. Refresh and try again');
      const kept = new Set(codes.map((item) => item.code));
      const earlier = prior.external ? (await this.codes.find({ listId: prior.id, version: prior.version }, { code: 1 }).lean().exec()).map((item) => item.code) : prior.codes.map((item) => item.code);
      const missing = earlier.find((code) => !kept.has(code));
      if (missing) throw new BadRequestException(`Keep code ${missing}; mark it obsolete instead of deleting it`);
    } else if ((collection.codeLists ?? []).length >= 100) throw new BadRequestException('Too many code lists');
    const id = prior?.id ?? randomUUID();
    const version = (prior?.version ?? 0) + 1;
    const levels = codeHierarchy(codes).levels;
    const documents = codes.map((item) => ({
      collectionId, listId: id, version, code: item.code, labelEn: item.labelEn, labelFr: item.labelFr, parentCode: item.parentCode, active: item.active,
      level: levels.get(item.code) ?? 1, search: foldSearch(`${item.code} ${item.labelEn} ${item.labelFr}`),
    }));
    // A failed earlier attempt may have left codes of this version: start clean.
    await this.codes.deleteMany({ listId: id, version }).exec();
    try {
      for (let start = 0; start < documents.length; start += 5000) await this.codes.insertMany(documents.slice(start, start + 5000), { ordered: false });
      const meta = { external: true, codeCount: codes.length, levels: Math.max(...levels.values()) };
      const result = prior
        ? await this.collections.findOneAndUpdate(
          { _id: collectionId, codeLists: { $elemMatch: { id, version: prior.version } } },
          { $set: { 'codeLists.$.name': cleanName, 'codeLists.$.codes': [], 'codeLists.$.version': version, 'codeLists.$.external': true, 'codeLists.$.codeCount': meta.codeCount, 'codeLists.$.levels': meta.levels } },
          { returnDocument: 'after' },
        ).exec()
        : await this.collections.findOneAndUpdate(
          { _id: collectionId, 'codeLists.name': { $ne: cleanName } },
          { $push: { codeLists: { id, name: cleanName, version, codes: [], ...meta } } },
          { returnDocument: 'after' },
        ).exec();
      if (!result) throw new BadRequestException('Code lists changed. Refresh and try again');
      await this.codes.deleteMany({ listId: id, version: { $ne: version } }).exec();
      return result;
    } catch (error) {
      await this.codes.deleteMany({ listId: id, version }).exec();
      throw error;
    }
  }

  /** Codes matching a search, or the children of a code (roots when `parentCode` is empty), with their ancestors' labels. */
  async search(collectionId: string, listId: string, userId: string, options: { query?: string; parentCode?: string; limit?: number; language?: string; includeInactive?: boolean }): Promise<FoundCode[]> {
    const collection = await this.context(collectionId, userId);
    const list = this.list(collection, listId);
    const limit = Math.min(Math.max(options.limit ?? 30, 1), 50);
    const label = (item: { labelEn: string; labelFr: string }) => (options.language === 'fr' ? item.labelFr : item.labelEn);
    const query = foldSearch((options.query ?? '').trim()).slice(0, 80);
    let found: (ClassificationCode & { level?: number })[];
    if (!list.external) {
      const byCode = new Map(list.codes.map((item) => [item.code, item]));
      found = list.codes.filter((item) => (options.includeInactive || item.active) && (query ? foldSearch(`${item.code} ${item.labelEn} ${item.labelFr}`).includes(query) : (item.parentCode ?? '') === (options.parentCode ?? '') || (!options.parentCode && item.parentCode && !byCode.has(item.parentCode)))).slice(0, limit);
    } else {
      const filter: Record<string, unknown> = { listId, version: list.version, ...(options.includeInactive ? {} : { active: true }) };
      if (query) filter.search = { $regex: escapeRegex(query) };
      else filter.parentCode = options.parentCode ? options.parentCode : { $exists: false };
      found = await this.codes.find(filter).sort({ level: 1, code: 1 }).limit(limit).lean().exec();
    }
    const ancestors = await this.withAncestors(list, found);
    const parents = new Set(list.external
      ? (await this.codes.find({ listId, version: list.version, parentCode: { $in: found.map((item) => item.code) } }, { parentCode: 1 }).lean().exec()).map((item) => item.parentCode!)
      : list.codes.filter((item) => item.parentCode && found.some((candidate) => candidate.code === item.parentCode)).map((item) => item.parentCode!));
    return found.map((item) => {
      const path: string[] = [];
      for (let parent = item.parentCode ? ancestors.get(item.parentCode) : undefined, guard = 0; parent && guard < 8; parent = parent.parentCode ? ancestors.get(parent.parentCode) : undefined, guard++) path.unshift(label(parent));
      return { code: item.code, label: label(item), path, level: path.length + 1, active: item.active, hasChildren: parents.has(item.code) };
    });
  }

  private async withAncestors(list: ClassificationList, found: Pick<ClassificationCode, 'code' | 'parentCode'>[]): Promise<Map<string, ClassificationCode>> {
    if (!list.external) return new Map(list.codes.map((item) => [item.code, item]));
    const known = new Map<string, ClassificationCode>();
    let wanted = [...new Set(found.map((item) => item.parentCode).filter((code): code is string => !!code))];
    for (let round = 0; round < 8 && wanted.length; round++) {
      const rows = await this.codes.find({ listId: list.id, version: list.version, code: { $in: wanted } }).lean().exec();
      for (const row of rows) known.set(row.code, row);
      wanted = [...new Set(rows.map((row) => row.parentCode).filter((code): code is string => !!code && !known.has(code)))];
    }
    return known;
  }

  async lookupFor(collectionId: string, listId: string, userId: string, codes: string[]): Promise<ClassificationCode[]> {
    return this.lookup(this.list(await this.context(collectionId, userId), listId), codes);
  }

  /** The codes asked for, of any status; used to label values and check entries. */
  async lookup(list: ClassificationList, codes: string[]): Promise<ClassificationCode[]> {
    if (!list.external) return list.codes.filter((item) => codes.includes(item.code));
    if (!codes.length) return [];
    return this.codes.find({ listId: list.id, version: list.version, code: { $in: [...new Set(codes)].slice(0, 5000) } }, { _id: 0, code: 1, labelEn: 1, labelFr: 1, parentCode: 1, active: 1 }).lean().exec();
  }

  /**
   * The collection's lists, where each large list holds only the codes used
   * by `values`: enough to check an entry without loading the whole list.
   */
  async listsForValues(collection: Collection, values: { fieldId: string; value?: string | null }[]): Promise<ClassificationList[]> {
    const lists = collection.codeLists ?? [];
    if (!lists.some((list) => list.external)) return lists;
    const fields = new Map(collection.formats.flatMap((format) => format.fields).filter((field) => field.kind === FieldKind.CODE && field.codeListId).map((field) => [field.id, field.codeListId!]));
    return Promise.all(lists.map(async (list) => {
      if (!list.external) return list;
      const used = values.filter((item) => fields.get(item.fieldId) === list.id && item.value).map((item) => String(item.value).trim());
      return { id: list.id, name: list.name, version: list.version, external: true, codes: await this.lookup(list, used) } as ClassificationList;
    }));
  }

  /** Every code of the given large lists, for analyses grouping by level. */
  async materialize(collection: Collection, listIds: string[]): Promise<ClassificationList[]> {
    return Promise.all((collection.codeLists ?? []).map(async (list) => {
      if (!list.external || !listIds.includes(list.id)) return list;
      const codes = await this.codes.find({ listId: list.id, version: list.version }, { _id: 0, code: 1, labelEn: 1, labelFr: 1, parentCode: 1, active: 1 }).lean().exec();
      return { id: list.id, name: list.name, version: list.version, external: true, codes } as ClassificationList;
    }));
  }

  async forgetCollection(collectionId: string): Promise<void> { await this.codes.deleteMany({ collectionId }).exec(); }
}
