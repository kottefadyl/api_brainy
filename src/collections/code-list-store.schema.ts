import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

/**
 * One code of a large list (T39/3), stored apart from the collection
 * document. A list's codes carry its version: a replacement writes the new
 * version, switches the list to it, then removes the old one.
 */
@Schema({ timestamps: false })
export class StoredCode {
  @Prop({ required: true, index: true }) collectionId!: string;
  @Prop({ required: true }) listId!: string;
  @Prop({ required: true }) version!: number;
  @Prop({ required: true }) code!: string;
  @Prop({ required: true }) labelEn!: string;
  @Prop({ required: true }) labelFr!: string;
  @Prop() parentCode?: string;
  @Prop({ required: true, default: true }) active!: boolean;
  /** Level from the root, 1 for a root code. */
  @Prop({ required: true }) level!: number;
  /** Code and both labels, lower case and without accents. */
  @Prop({ required: true }) search!: string;
}

export const StoredCodeSchema = SchemaFactory.createForClass(StoredCode);
StoredCodeSchema.index({ listId: 1, version: 1, code: 1 }, { unique: true });
StoredCodeSchema.index({ listId: 1, version: 1, parentCode: 1, code: 1 });
