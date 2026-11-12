// T47/3: Book collections created before the 17-part Book template (Chapter, Scene, Note) had no
// provenance and therefore no book view. At start-up, a collection that still has those data formats
// receives templateId "book" and a book view, switched off, where Chapter is a chapter and Scene a
// section. Note stays outside the book; the owner can give it a role from the book view (T47/3).
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { defaultBookView } from './book-view.schema';
import { Collection, CollectionFormat, FieldKind } from './collection.schema';

const named = (format: CollectionFormat, names: string[]) => names.includes(format.name.trim().toLocaleLowerCase());
const writing = (format: CollectionFormat) => format.fields.length === 3
  && format.fields[0].kind === FieldKind.TITLE && format.fields[1].kind === FieldKind.NUMBER && format.fields[2].kind === FieldKind.LONG_TEXT
  && ['order', 'ordre'].includes(format.fields[1].name.trim().toLocaleLowerCase());

/** Roles for an older Book collection, or null when the collection does not look like one. */
export function legacyBookRoles(formats: CollectionFormat[]): { formatId: string; role: string }[] | null {
  const chapter = formats.find((format) => named(format, ['chapter', 'chapitre']) && writing(format));
  const scene = formats.find((format) => named(format, ['scene', 'scène']) && writing(format));
  return chapter && scene ? [{ formatId: chapter.id, role: 'CHAPTER' }, { formatId: scene.id, role: 'SECTION' }] : null;
}

@Injectable()
export class LegacyBookMigration implements OnModuleInit {
  private readonly logger = new Logger(LegacyBookMigration.name);
  constructor(@InjectModel(Collection.name) private readonly collections: Model<Collection>) {}

  async onModuleInit(): Promise<void> {
    try {
      const candidates = await this.collections.find({ templateId: { $in: [null, ''] }, 'formats.name': { $in: ['Chapter', 'Chapitre'] } }).select('formats').lean().exec();
      let count = 0;
      for (const collection of candidates) {
        const roles = legacyBookRoles(collection.formats as CollectionFormat[]);
        if (!roles) continue;
        const result = await this.collections.updateOne({ _id: collection._id, templateId: { $in: [null, ''] } }, { $set: { templateId: 'book', bookView: defaultBookView(roles, false) } }).exec();
        count += result.modifiedCount;
      }
      if (count) this.logger.log(`Book view prepared for ${count} older Book collection(s)`);
    } catch (error) {
      this.logger.warn(`Older Book collections skipped: ${(error as Error).message}`);
    }
  }
}
