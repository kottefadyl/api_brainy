import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AnalysisInput, AnalysisResult } from './analysis.input';
import { Collection, FieldKind } from './collection.schema';
import { CollectionsService } from './collections.service';
import { Entry } from './entry.schema';
import { analysePointsByZone, NamedPoint, NamedZone } from './geo-grouping';
import { parsePosition, parseZone } from './geo.logic';

@Injectable()
export class ZoneAnalysisService {
  constructor(
    @InjectModel(Entry.name) private readonly entries: Model<Entry>,
    private readonly collectionsService: CollectionsService,
  ) {}

  async analyse(collection: Collection, ownerId: string, input: AnalysisInput): Promise<AnalysisResult> {
    if (input.operation !== 'COUNT' || input.measureKind !== 'EVENT' || input.secondaryGroupBy) throw new BadRequestException('Zone grouping currently supports event counts only');
    const format = collection.formats.find((item) => item.id === input.formatId);
    const position = format?.fields.find((field) => field.id === input.groupFieldId && field.kind === FieldKind.POSITION);
    const zoneFormat = collection.formats.find((item) => item.id === input.zoneFormatId);
    const zoneField = zoneFormat?.fields.find((field) => field.id === input.zoneFieldId && field.kind === FieldKind.ZONE);
    if (!format || !position || !zoneFormat || !zoneField) throw new BadRequestException('Choose position and zone fields in this collection');
    if (input.search && input.search.length > 100) throw new BadRequestException('Map search is too long');
    if (input.sourceGroup !== undefined && (typeof input.sourceGroup !== 'string' || input.sourceGroup.length > 200)) throw new BadRequestException('Invalid source group');
    if (input.sourceOffset !== undefined && (!Number.isInteger(input.sourceOffset) || input.sourceOffset < 0 || input.sourceOffset > 100000 || !input.sourceGroup)) throw new BadRequestException('Invalid source offset');
    const zoneEntries = await this.entries.find({ collectionId: collection.id, ownerId: collection.ownerId, formatId: zoneFormat.id, values: { $elemMatch: { fieldId: zoneField.id } } }).limit(101).exec();
    if (zoneEntries.length > 100) throw new BadRequestException('Group at most 100 zones');
    const titleId = zoneFormat.fields.find((field) => field.kind === FieldKind.TITLE)?.id;
    const zones: NamedZone[] = zoneEntries.map((entry) => ({ id: entry.id, label: entry.values.find((value) => value.fieldId === titleId)?.value || entry.id, shape: parseZone(entry.values.find((value) => value.fieldId === zoneField.id)!.value) }));
    const points: NamedPoint[] = [];
    let after: string | undefined;
    let scanned = 0;
    do {
      const page = await this.collectionsService.entriesPage(collection.id, ownerId, { first: 100, after, search: input.search, formatId: format.id, filters: input.filters, viewId: input.viewId });
      scanned += page.entries.length;
      if (scanned > 10000) throw new BadRequestException('Narrow the map to at most 10000 entries');
      for (const entry of page.entries) {
        if (entry.formatId !== format.id) continue;
        const raw = entry.values.find((value) => value.fieldId === position.id)?.value;
        if (raw) points.push({ entryId: entry.id, position: parsePosition(raw) });
      }
      after = page.nextCursor ?? undefined;
    } while (after);
    const rows = analysePointsByZone(points, zones, input);
    return { operation: 'COUNT', operationVersion: 1, groupBy: 'ZONE', refreshedAt: new Date().toISOString(), rows, explanation: `COUNT v1 · zones=${zones.length} · points=${points.length}` };
  }
}
