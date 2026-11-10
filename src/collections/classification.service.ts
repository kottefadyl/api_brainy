import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { CollaborationService } from './collaboration.service';
import { CollectionRole } from './collaboration.schema';
import { ClassificationCode, ClassificationList, Collection, FieldKind } from './collection.schema';
import { Entry } from './entry.schema';
import { parseClassificationCsv, resolveClassificationPaths, validateClassificationCodes } from './classification.logic';

@Injectable()
export class ClassificationService {
  constructor(
    @InjectModel(Collection.name) private readonly collections: Model<Collection>,
    @InjectModel(Entry.name) private readonly entries: Model<Entry>,
    private readonly collaboration: CollaborationService,
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

  async save(collectionId: string, userId: string, listId: string | undefined, expectedVersion: number | undefined, name: string, supplied: ClassificationCode[]): Promise<Collection> {
    const collection = await this.context(collectionId, userId, CollectionRole.OWNER);
    const cleanName = name.trim();
    if (!cleanName || cleanName.length > 80) throw new BadRequestException('Code list name must be 1 to 80 characters');
    if ((collection.codeLists ?? []).some((item) => item.id !== listId && item.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase())) throw new BadRequestException('Code list names must be unique');
    const codes = validateClassificationCodes(supplied);
    if (!listId) {
      if (codes.some((code) => code.mergedInto)) throw new BadRequestException('Use the merge action to replace a code');
      if ((collection.codeLists ?? []).length >= 100) throw new BadRequestException('Too many code lists');
      const created: ClassificationList = { id: randomUUID(), name: cleanName, version: 1, codes };
      const result = await this.collections.findOneAndUpdate({ _id: collectionId, 'codeLists.name': { $ne: cleanName } }, { $push: { codeLists: created } }, { new: true, runValidators: true }).exec();
      if (!result) throw new BadRequestException('Code lists changed. Refresh and try again');
      return result;
    }
    const prior = this.list(collection, listId);
    if (prior.external) throw new BadRequestException('Replace a large code list by importing a referential');
    if (expectedVersion !== prior.version) throw new BadRequestException('Code list changed. Refresh and try again');
    const next = new Map(codes.map((item) => [item.code, item]));
    for (const old of prior.codes) {
      const replacement = next.get(old.code);
      if (!replacement) throw new BadRequestException(`Keep code ${old.code}; mark it obsolete instead of deleting it`);
      if (replacement.mergedInto !== old.mergedInto) throw new BadRequestException('Use the merge action to replace a code');
    }
    if (codes.some((code) => !prior.codes.some((old) => old.code === code.code) && code.mergedInto)) throw new BadRequestException('Use the merge action to replace a code');
    const result = await this.collections.findOneAndUpdate(
      { _id: collectionId, codeLists: { $elemMatch: { id: listId, version: expectedVersion } } },
      { $set: { 'codeLists.$.name': cleanName, 'codeLists.$.codes': codes, 'codeLists.$.version': prior.version + 1 } },
      { new: true, runValidators: true },
    ).exec();
    if (!result) throw new BadRequestException('Code list changed. Refresh and try again');
    return result;
  }

  csvPreview(csv: string) { return parseClassificationCsv(csv); }

  async codePaths(collectionId: string, listId: string, userId: string, language?: string) {
    const list = this.list(await this.context(collectionId, userId), listId);
    // A large list is searched on the server (searchClassificationCodes), never sent whole.
    return list.external ? [] : resolveClassificationPaths(list, language);
  }

  async copyPreview(collectionId: string, listId: string, targetId: string, userId: string): Promise<{ allowed: boolean; sourceName: string; targetName: string; codeCount: number; conflicts: string[] }> {
    const source = await this.context(collectionId, userId);
    const target = await this.context(targetId, userId, CollectionRole.OWNER);
    const list = this.list(source, listId);
    const conflicts: string[] = [];
    if (source.id === target.id) conflicts.push('Choose another collection');
    if (list.external) conflicts.push('Large code lists cannot be copied to another collection yet');
    if ((target.codeLists ?? []).some((item) => item.name.toLocaleLowerCase() === list.name.toLocaleLowerCase())) conflicts.push('Target has a code list with this name');
    if ((target.codeLists ?? []).length >= 100) conflicts.push('Target has too many code lists');
    return { allowed: !conflicts.length, sourceName: source.name, targetName: target.name, codeCount: list.external ? list.codeCount ?? 0 : list.codes.length, conflicts };
  }

  async copy(collectionId: string, listId: string, targetId: string, userId: string): Promise<Collection> {
    const preview = await this.copyPreview(collectionId, listId, targetId, userId);
    if (!preview.allowed) throw new BadRequestException(preview.conflicts.join('; '));
    const source = await this.context(collectionId, userId);
    const list = this.list(source, listId);
    const result = await this.collections.findOneAndUpdate(
      { _id: targetId, 'codeLists.name': { $ne: list.name } },
      { $push: { codeLists: { id: randomUUID(), name: list.name, version: 1, codes: list.codes.map((item) => ({ ...item })), copiedFromListId: list.id } } },
      { new: true, runValidators: true },
    ).exec();
    if (!result) throw new BadRequestException('Target changed. Refresh and try again');
    return result;
  }

  async mergePreview(collectionId: string, listId: string, fromCode: string, toCode: string, userId: string): Promise<{ affectedEntries: number; allowed: boolean }> {
    const collection = await this.context(collectionId, userId, CollectionRole.OWNER);
    const list = this.list(collection, listId);
    if (list.external) throw new BadRequestException('Codes of a large code list cannot be merged yet');
    const source = list.codes.find((item) => item.code === fromCode);
    const target = list.codes.find((item) => item.code === toCode);
    if (!source || !target || fromCode === toCode || !target.active || (source.mergedInto && source.mergedInto !== toCode)) throw new BadRequestException('Choose two compatible codes');
    const fieldIds = collection.formats.flatMap((format) => format.fields.filter((field) => field.kind === FieldKind.CODE && field.codeListId === listId).map((field) => field.id));
    const affectedEntries = fieldIds.length ? await this.entries.countDocuments({ collectionId, 'values': { $elemMatch: { fieldId: { $in: fieldIds }, value: fromCode } } }).exec() : 0;
    const registerFieldIds = collection.formats.filter((format) => format.appendOnly).flatMap((format) => format.fields.filter((field) => field.kind === FieldKind.CODE && field.codeListId === listId).map((field) => field.id));
    const inRegister = registerFieldIds.length ? await this.entries.exists({ collectionId, values: { $elemMatch: { fieldId: { $in: registerFieldIds }, value: fromCode } } }) : false;
    return { affectedEntries, allowed: !inRegister };
  }

  async merge(collectionId: string, listId: string, fromCode: string, toCode: string, expectedVersion: number, userId: string): Promise<Collection> {
    const preview = await this.mergePreview(collectionId, listId, fromCode, toCode, userId);
    if (!preview.allowed) throw new BadRequestException('A code used in a register cannot be merged');
    const collection = await this.context(collectionId, userId, CollectionRole.OWNER);
    const list = this.list(collection, listId);
    if (list.version !== expectedVersion && list.codes.find((item) => item.code === fromCode)?.mergedInto !== toCode) throw new BadRequestException('Code list changed. Refresh and try again');
    if (list.version === expectedVersion) {
      const result = await this.collections.updateOne(
        { _id: collectionId, codeLists: { $elemMatch: { id: listId, version: expectedVersion } } },
        { $set: { 'codeLists.$[list].codes.$[code].active': false, 'codeLists.$[list].codes.$[code].mergedInto': toCode }, $inc: { 'codeLists.$[list].version': 1 } },
        { arrayFilters: [{ 'list.id': listId }, { 'code.code': fromCode }] },
      ).exec();
      if (!result.modifiedCount) throw new BadRequestException('Code list changed. Refresh and try again');
    }
    const fieldIds = collection.formats.flatMap((format) => format.fields.filter((field) => field.kind === FieldKind.CODE && field.codeListId === listId).map((field) => field.id));
    if (fieldIds.length) await this.entries.updateMany(
      { collectionId, values: { $elemMatch: { fieldId: { $in: fieldIds }, value: fromCode } } },
      { $set: { 'values.$[value].value': toCode } },
      { arrayFilters: [{ 'value.fieldId': { $in: fieldIds }, 'value.value': fromCode }] },
    ).exec();
    return (await this.collections.findById(collectionId).exec())!;
  }
}
