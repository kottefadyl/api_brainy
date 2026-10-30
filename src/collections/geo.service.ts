import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CollaborationService } from './collaboration.service';
import { CollectionRole } from './collaboration.schema';
import { Collection, FieldKind } from './collection.schema';
import { EntryFieldFilterInput } from './collection.input';
import { CollectionsService } from './collections.service';
import { AnalysisService } from './analysis.service';
import { Entry } from './entry.schema';
import { distanceMeters, parsePosition, Position } from './geo.logic';

type ImportRow = { sourceId: string; name: string; position: Position };

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quoted && character === '"' && text[i + 1] === '"') { cell += '"'; i++; }
    else if (character === '"') quoted = !quoted;
    else if (character === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += character;
  }
  if (quoted) throw new BadRequestException('CSV has an unclosed quote');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

@Injectable()
export class GeoService {
  constructor(
    @InjectModel(Collection.name) private readonly collections: Model<Collection>,
    @InjectModel(Entry.name) private readonly entries: Model<Entry>,
    private readonly collaboration: CollaborationService,
    private readonly collectionService: CollectionsService,
    private readonly analysisService: AnalysisService,
  ) {}

  private async context(id: string, userId: string, role = CollectionRole.READER): Promise<Collection> {
    if (!Types.ObjectId.isValid(id)) throw new NotFoundException('Collection not found');
    const collection = await this.collections.findById(id).exec();
    if (!collection) throw new NotFoundException('Collection not found');
    this.collaboration.checkAccess(collection, userId, role);
    if (collection.ownerId !== userId) throw new ForbiddenException('Geographic data requires the collection owner');
    return collection;
  }

  private positionField(collection: Collection, formatId: string, fieldId: string) {
    const format = collection.formats.find((item) => item.id === formatId);
    const field = format?.fields.find((item) => item.id === fieldId && item.kind === FieldKind.POSITION);
    if (!format || !field) throw new BadRequestException('Choose a position field in this collection');
    return { format, field };
  }

  async page(collectionId: string, userId: string, formatId: string, fieldId: string, first: number, after?: string, search?: string, filters?: EntryFieldFilterInput[], viewId?: string) {
    const collection = await this.context(collectionId, userId);
    this.positionField(collection, formatId, fieldId);
    if (!Number.isInteger(first) || first < 1 || first > 100) throw new BadRequestException('Choose 1 to 100 points per page');
    if (search && search.length > 100) throw new BadRequestException('Map search is too long');
    const page = await this.collectionService.entriesPage(collectionId, userId, { first, after, search, formatId, filters, viewId });
    const points = page.entries.filter((entry) => entry.formatId === formatId).flatMap((entry) => {
      const value = entry.values.find((item) => item.fieldId === fieldId)?.value;
      if (!value) return [];
      try {
        const position = parsePosition(value);
        const titleField = collection.formats.find((item) => item.id === formatId)?.fields.find((item) => item.kind === FieldKind.TITLE);
        const name = titleField ? entry.values.find((item) => item.fieldId === titleField.id)?.value || '' : '';
        return [{ entryId: entry.id, name, latitude: position.latitude, longitude: position.longitude, accuracy: position.accuracy }];
      } catch { return []; }
    });
    return { points, nextCursor: page.nextCursor, hasMore: page.hasMore };
  }

  async distance(collectionId: string, userId: string, formatId: string, fieldId: string, firstEntryId: string, secondEntryId: string, unit: string) {
    const collection = await this.context(collectionId, userId);
    this.positionField(collection, formatId, fieldId);
    if (!['m', 'km'].includes(unit) || !Types.ObjectId.isValid(firstEntryId) || !Types.ObjectId.isValid(secondEntryId)) throw new BadRequestException('Choose two points and m or km');
    const entries = await this.entries.find({ _id: { $in: [firstEntryId, secondEntryId] }, collectionId, ownerId: collection.ownerId, formatId }).exec();
    if (entries.length !== 2) throw new NotFoundException('Point not found');
    const positions = [firstEntryId, secondEntryId].map((id) => parsePosition(entries.find((entry) => entry.id === id)?.values.find((item) => item.fieldId === fieldId)?.value ?? ''));
    const metres = distanceMeters(positions[0], positions[1]);
    return { value: String(unit === 'km' ? metres / 1000 : metres), unit };
  }

  async zoneSummary(collectionId: string, userId: string, positionFormatId: string, positionFieldId: string, zoneFormatId: string, zoneFieldId: string, search?: string, filters?: EntryFieldFilterInput[], viewId?: string) {
    await this.context(collectionId, userId);
    const result = await this.analysisService.analyse(collectionId, userId, { formatId: positionFormatId, groupFieldId: positionFieldId, zoneFormatId, zoneFieldId, operation: 'COUNT', groupBy: 'ZONE', measureKind: 'EVENT', search, filters, viewId });
    return result.rows.map((row) => ({ zoneEntryId: row.group, label: row.label, count: row.count }));
  }

  private records(text: string, kind: string): { rows: ImportRow[]; errors: { row: number; message: string }[] } {
    if (text.length > 2_000_000) throw new BadRequestException('Geographic import is too large');
    const rows: ImportRow[] = [], errors: { row: number; message: string }[] = [];
    if (kind === 'GEOJSON') {
      let data: unknown;
      try { data = JSON.parse(text); } catch { throw new BadRequestException('Invalid GeoJSON'); }
      const features = (data as { type?: string; features?: unknown[] })?.features;
      if ((data as { type?: string })?.type !== 'FeatureCollection' || !Array.isArray(features) || features.length > 500) throw new BadRequestException('GeoJSON needs at most 500 point features');
      features.forEach((item, index) => {
        try {
          const feature = item as { id?: string; geometry?: { type?: string; coordinates?: number[] }; properties?: { name?: string; accuracy?: number } };
          if (feature.geometry?.type !== 'Point' || feature.geometry.coordinates?.length !== 2) throw new Error('Feature needs a Point');
          const [longitude, latitude] = feature.geometry.coordinates;
          const position = parsePosition(JSON.stringify({ latitude, longitude, accuracy: feature.properties?.accuracy }));
          rows.push({ sourceId: String(feature.id ?? index + 1), name: String(feature.properties?.name ?? ''), position });
        } catch (error) { errors.push({ row: index + 1, message: (error as Error).message }); }
      });
    } else if (kind === 'CSV') {
      const lines = csvRows(text.replace(/^\uFEFF/, ''));
      const columns = lines.shift()?.map((part) => part.trim().toLowerCase()) ?? [];
      const latitudeIndex = columns.indexOf('latitude'), longitudeIndex = columns.indexOf('longitude'), nameIndex = columns.indexOf('name'), accuracyIndex = columns.indexOf('accuracy');
      if (latitudeIndex < 0 || longitudeIndex < 0 || lines.length > 500) throw new BadRequestException('CSV needs latitude,longitude columns and at most 500 rows');
      lines.forEach((parts, index) => {
        try {
          if (parts.every((part) => !part.trim())) return;
          if (!parts[latitudeIndex]?.trim() || !parts[longitudeIndex]?.trim()) throw new Error('Latitude and longitude are required');
          const position = parsePosition(JSON.stringify({ latitude: Number(parts[latitudeIndex]), longitude: Number(parts[longitudeIndex]), ...(accuracyIndex >= 0 && parts[accuracyIndex] ? { accuracy: Number(parts[accuracyIndex]) } : {}) }));
          rows.push({ sourceId: String(index + 1), name: nameIndex >= 0 ? parts[nameIndex] ?? '' : '', position });
        } catch (error) { errors.push({ row: index + 2, message: (error as Error).message }); }
      });
    } else throw new BadRequestException('Choose GEOJSON or CSV');
    if (new Set(rows.map((row) => row.sourceId)).size !== rows.length) errors.push({ row: 0, message: 'Feature IDs must be unique' });
    return { rows, errors };
  }

  async previewImport(collectionId: string, userId: string, formatId: string, fieldId: string, text: string, kind: string) {
    const collection = await this.context(collectionId, userId, CollectionRole.EDITOR);
    this.positionField(collection, formatId, fieldId);
    const parsed = this.records(text, kind);
    return { count: parsed.rows.length, errors: parsed.errors };
  }

  async importPoints(collectionId: string, userId: string, formatId: string, fieldId: string, text: string, kind: string, importKey: string) {
    const collection = await this.context(collectionId, userId, CollectionRole.EDITOR);
    const { format } = this.positionField(collection, formatId, fieldId);
    if (format.appendOnly) throw new BadRequestException('Import into a register is not supported');
    if (!/^[\w.-]{1,100}$/.test(importKey)) throw new BadRequestException('Invalid import key');
    const parsed = this.records(text, kind);
    if (parsed.errors.length) return { count: 0, errors: parsed.errors };
    const titleId = format.fields.find((field) => field.kind === FieldKind.TITLE)?.id;
    let count = 0;
    for (const row of parsed.rows) {
      const values = [{ fieldId, value: JSON.stringify(row.position) }, ...(titleId ? [{ fieldId: titleId, value: row.name.trim().slice(0, 10000) || `Point ${row.sourceId}` }] : [])];
      const result = await this.entries.updateOne(
        { collectionId, ownerId: collection.ownerId, importKey, sourceId: row.sourceId },
        { $setOnInsert: { collectionId, ownerId: collection.ownerId, formatId, formatVersion: format.version ?? 1, importKey, sourceId: row.sourceId, values } },
        { upsert: true },
      ).exec();
      count += result.upsertedCount;
    }
    return { count, errors: [] };
  }

  async exportPoints(collectionId: string, userId: string, formatId: string, fieldId: string, kind: string) {
    const collection = await this.context(collectionId, userId);
    this.positionField(collection, formatId, fieldId);
    if (!['GEOJSON', 'CSV'].includes(kind)) throw new BadRequestException('Choose GEOJSON or CSV');
    const entries = await this.entries.find({ collectionId, ownerId: collection.ownerId, formatId, values: { $elemMatch: { fieldId } } }).limit(10001).exec();
    if (entries.length > 10000) throw new BadRequestException('Export at most 10000 points at a time');
    const titleId = collection.formats.find((item) => item.id === formatId)?.fields.find((item) => item.kind === FieldKind.TITLE)?.id;
    const rows = entries.flatMap((entry) => {
      try { return [{ id: entry.id, name: entry.values.find((item) => item.fieldId === titleId)?.value || '', position: parsePosition(entry.values.find((item) => item.fieldId === fieldId)!.value) }]; }
      catch { return []; }
    });
    if (kind === 'GEOJSON') return JSON.stringify({ type: 'FeatureCollection', features: rows.map((row) => ({ type: 'Feature', id: row.id, geometry: { type: 'Point', coordinates: [row.position.longitude, row.position.latitude] }, properties: { name: row.name, ...(row.position.accuracy === undefined ? {} : { accuracy: row.position.accuracy }) } })) });
    const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
    return ['latitude,longitude,accuracy,name', ...rows.map((row) => `${row.position.latitude},${row.position.longitude},${row.position.accuracy ?? ''},${escape(row.name)}`)].join('\n');
  }
}
