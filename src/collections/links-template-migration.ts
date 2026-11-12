// T48/1: "Saved links" collections created before 11 November 2026 have no template provenance, so their
// link previews stay hidden. At start-up, a collection whose data format still has the exact field
// structure of that template (Title, URL, Comment, Category, Saved on) receives templateId "links" (provenance only).
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Collection, FieldKind } from './collection.schema';

const kinds = [FieldKind.TITLE, FieldKind.LINK, FieldKind.LONG_TEXT, FieldKind.TEXT, FieldKind.DATE];
const names = [['title', 'titre'], ['url'], ['comment', 'commentaire'], ['category', 'catégorie'], ['saved on', 'enregistré le']];

/** True when the fields are those of the "Saved links" template, in English or French, in the same order. */
export function looksLikeSavedLinks(fields: { name: string; kind: string }[]): boolean {
  return fields.length === kinds.length && fields.every((field, index) => field.kind === kinds[index] && names[index].includes(field.name.trim().toLocaleLowerCase()));
}

@Injectable()
export class LinksTemplateMigration implements OnModuleInit {
  private readonly logger = new Logger(LinksTemplateMigration.name);
  constructor(@InjectModel(Collection.name) private readonly collections: Model<Collection>) {}

  async onModuleInit(): Promise<void> {
    try {
      const candidates = await this.collections.find({ templateId: { $in: [null, ''] }, 'formats.fields.name': { $in: ['URL', 'Url', 'url'] } }).select('formats.fields.name formats.fields.kind').lean().exec();
      const ids = candidates.filter((item) => item.formats?.some((format) => looksLikeSavedLinks(format.fields ?? []))).map((item) => item._id);
      if (!ids.length) return;
      const result = await this.collections.updateMany({ _id: { $in: ids }, templateId: { $in: [null, ''] } }, { $set: { templateId: 'links' } }).exec();
      this.logger.log(`Saved links provenance restored on ${result.modifiedCount} collection(s)`);
    } catch (error) {
      this.logger.warn(`Saved links provenance skipped: ${(error as Error).message}`);
    }
  }
}
