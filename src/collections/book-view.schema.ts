import { Field, Float, InputType, ObjectType } from '@nestjs/graphql';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

/** T47: presentation settings of the book view. They never change entry values. */
export const bookFonts = ['SERIF', 'SANS', 'GARAMOND', 'MONO'] as const;
export const bookPageSizes = ['A5', 'A4', 'POCKET'] as const;
export const bookAlignments = ['LEFT', 'JUSTIFY'] as const;

export const bookRoles = ['COVER', 'TITLE_PAGE', 'DEDICATION', 'EPIGRAPH', 'FOREWORD', 'PREFACE', 'ACKNOWLEDGEMENTS', 'INTRODUCTION', 'PART', 'CHAPTER', 'SECTION', 'SUBSECTION', 'CONCLUSION', 'AFTERWORD', 'APPENDIX', 'TERM', 'SOURCE'] as const;
export type BookRole = typeof bookRoles[number];

/** Which data format plays which part of the book. Set by the Book template, kept when formats are renamed. */
@ObjectType()
@Schema({ _id: false })
export class BookFormatRole {
  @Field() @Prop({ required: true }) formatId!: string;
  @Field() @Prop({ required: true, enum: bookRoles }) role!: string;
}
export const BookFormatRoleSchema = SchemaFactory.createForClass(BookFormatRole);

@ObjectType()
@Schema({ _id: false })
export class BookViewSettings {
  @Field(() => [BookFormatRole]) @Prop({ type: [BookFormatRoleSchema], default: [] }) roles!: BookFormatRole[];
  @Field() @Prop({ default: false }) enabled!: boolean;
  @Field() @Prop({ default: 'SERIF' }) bodyFont!: string;
  @Field() @Prop({ default: 'SERIF' }) headingFont!: string;
  @Field(() => Float) @Prop({ default: 16 }) fontSize!: number;
  @Field(() => Float) @Prop({ default: 1.6 }) lineHeight!: number;
  @Field(() => Float) @Prop({ default: 0.8 }) paragraphSpacing!: number;
  @Field(() => Float) @Prop({ default: 1.5 }) firstLineIndent!: number;
  @Field(() => Float) @Prop({ default: 20 }) marginMm!: number;
  @Field() @Prop({ default: 'JUSTIFY' }) textAlign!: string;
  @Field() @Prop({ default: 'A5' }) pageSize!: string;
  @Field() @Prop({ default: true }) showRuler!: boolean;
  @Field() @Prop({ default: true }) chapterOnNewPage!: boolean;
}
export const BookViewSettingsSchema = SchemaFactory.createForClass(BookViewSettings);

@InputType()
export class BookViewSettingsInput {
  @Field() enabled!: boolean;
  @Field() bodyFont!: string;
  @Field() headingFont!: string;
  @Field(() => Float) fontSize!: number;
  @Field(() => Float) lineHeight!: number;
  @Field(() => Float) paragraphSpacing!: number;
  @Field(() => Float) firstLineIndent!: number;
  @Field(() => Float) marginMm!: number;
  @Field() textAlign!: string;
  @Field() pageSize!: string;
  @Field() showRuler!: boolean;
  @Field() chapterOnNewPage!: boolean;
}

export function defaultBookView(roles: BookFormatRole[], enabled = true): BookViewSettings {
  return { roles, enabled, bodyFont: 'SERIF', headingFont: 'SERIF', fontSize: 16, lineHeight: 1.6, paragraphSpacing: 0.8, firstLineIndent: 1.5, marginMm: 20, textAlign: 'JUSTIFY', pageSize: 'A5', showRuler: true, chapterOnNewPage: true };
}
