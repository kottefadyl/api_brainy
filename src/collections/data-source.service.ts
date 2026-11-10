// T32 — data sources: owner-managed mappings, CSV/JSON deliveries (upload or push key) and a leased worker.
import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { CollectionRole } from './collaboration.schema';
import { CollaborationService } from './collaboration.service';
import { Collection, CollectionFormat, FieldKind } from './collection.schema';
import { CollectionsService } from './collections.service';
import { DATA_SOURCE_KINDS, DeliveryError, PreparedRow, RowRejection, checkHeader, duplicateRows, mergeValues, parseDelivery, prepareRow, sameValues, toCsv, unitMismatch } from './data-source.logic';
import { DataSource, DataSourceInput, DataSourceKey, DataSourceRejection, DataSourceRun } from './data-source.schema';
import { Entry, EntryValue } from './entry.schema';
import { StockMovement } from './stock.schema';
import { protectedFields } from './sensitivity.logic';
import { assertNotFrozen, isFrozen } from '../platform';

const batchSize = 200;
const leaseMs = 120_000;
const expiryMs = 30 * 24 * 60 * 60 * 1000;
const maxStoredRejections = 1000;
const maxSourcesPerCollection = 20;
const maxPushPerHour = 120;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const newKey = () => `bds_${randomBytes(32).toString('base64url')}`;
const validKey = (value: string) => /^bds_[A-Za-z0-9_-]{43}$/.test(value);
const columnName = (value: unknown) => typeof value === 'string' && value.trim().length > 0 && value.length <= 100;

@Injectable()
export class DataSourceService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(DataSourceService.name);
  private readonly workerId = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    @InjectModel(DataSource.name) private readonly sources: Model<DataSource>,
    @InjectModel(DataSourceRun.name) private readonly runs: Model<DataSourceRun>,
    @InjectModel(Entry.name) private readonly entries: Model<Entry>,
    @InjectModel(StockMovement.name) private readonly stockMovements: Model<StockMovement>,
    private readonly collections: CollectionsService,
    private readonly collaboration: CollaborationService,
  ) {}

  onApplicationBootstrap() {
    if (isFrozen('dataSources')) return;
    this.timer = setInterval(() => { void this.tick(); }, 1000);
  }

  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }

  // ---- management (owner) ----

  private async access(collectionId: string, actorId: string, role: CollectionRole): Promise<Collection> {
    const collection = await this.collections.one(collectionId, actorId);
    this.collaboration.checkAccess(collection, actorId, role);
    return collection;
  }

  private async source(sourceId: string): Promise<DataSource> {
    if (!Types.ObjectId.isValid(sourceId)) throw new NotFoundException('Data source not found');
    const source = await this.sources.findById(sourceId).exec();
    if (!source) throw new NotFoundException('Data source not found');
    return source;
  }

  /** Editors use a source only with access to every mapped field: raw rejected rows show all columns. */
  private async sourceAccess(source: DataSource, actorId: string): Promise<Collection> {
    const collection = await this.collections.one(source.collectionId, actorId);
    const { member } = this.collaboration.checkAccess(collection, actorId, CollectionRole.EDITOR);
    if (!member || member.role === CollectionRole.OWNER) return collection;
    const format = collection.formats.find((item) => item.id === source.formatId);
    const isProtected = format ? protectedFields(format) : new Set<string>();
    if (member.sharedFieldIds?.length || source.mappings.some((item) => isProtected.has(item.fieldId) && !member.sensitiveFieldIds?.includes(item.fieldId))) {
      throw new ForbiddenException('This data source needs access to every field of its data format');
    }
    return collection;
  }

  private validate(collection: Collection, input: DataSourceInput): CollectionFormat {
    if (!input.name?.trim() || input.name.trim().length > 80) throw new BadRequestException('Name the data source (up to 80 characters)');
    const format = collection.formats.find((item) => item.id === input.formatId);
    if (!format) throw new BadRequestException('Choose a data format in this collection');
    if (format.appendOnly || format.workflow) throw new BadRequestException('A data source cannot write into a register or a data format with a state flow');
    if (!['DOT', 'COMMA'].includes(input.decimalSeparator)) throw new BadRequestException('Choose a decimal separator');
    if (![',', ';', '\t'].includes(input.delimiter)) throw new BadRequestException('Choose comma, semicolon or tab as the CSV separator');
    if (!['UPDATE', 'KEEP_FIRST'].includes(input.updatePolicy)) throw new BadRequestException('Choose how repeated records are handled');
    if (!columnName(input.recordIdColumn)) throw new BadRequestException('Choose the record ID column');
    for (const column of [input.observedAtColumn, input.qualityColumn, input.statusColumn]) if (column !== undefined && column !== null && column !== '' && !columnName(column)) throw new BadRequestException('Column names must be 1 to 100 characters');
    if (!input.mappings?.length || input.mappings.length > 30) throw new BadRequestException('Map 1 to 30 columns');
    if (new Set(input.mappings.map((item) => item.fieldId)).size !== input.mappings.length || new Set(input.mappings.map((item) => item.column)).size !== input.mappings.length) throw new BadRequestException('Each column and field can be mapped once');
    for (const mapping of input.mappings) {
      if (!columnName(mapping.column) || (mapping.unitColumn && !columnName(mapping.unitColumn))) throw new BadRequestException('Column names must be 1 to 100 characters');
      const field = format.fields.find((item) => item.id === mapping.fieldId);
      if (!field || !DATA_SOURCE_KINDS.has(field.kind)) throw new BadRequestException(`Field ${field?.name ?? mapping.fieldId} cannot be filled by a data source`);
      if (mapping.unitColumn && field.kind !== FieldKind.NUMBER && field.kind !== FieldKind.MEASURE) throw new BadRequestException(`Only number and measure fields can have a unit column`);
    }
    if (format.objectModel) {
      const title = format.fields.find((field) => field.kind === FieldKind.TITLE);
      if (!title || !input.mappings.some((item) => item.fieldId === title.id)) throw new BadRequestException('Map a column to the object name');
    }
    return format;
  }

  private clean(input: DataSourceInput, format: CollectionFormat) {
    const optional = (value?: string) => (value?.trim() ? value.trim() : undefined);
    return {
      name: input.name.trim(), formatId: format.id, formatVersion: format.version ?? 1, recordIdColumn: input.recordIdColumn.trim(),
      observedAtColumn: optional(input.observedAtColumn), qualityColumn: optional(input.qualityColumn), statusColumn: optional(input.statusColumn),
      decimalSeparator: input.decimalSeparator, delimiter: input.delimiter, updatePolicy: input.updatePolicy,
      mappings: input.mappings.map((item) => ({ column: item.column.trim(), fieldId: item.fieldId, unitColumn: optional(item.unitColumn) })),
    };
  }

  async create(collectionId: string, input: DataSourceInput, actorId: string): Promise<DataSource> {
    assertNotFrozen('dataSources');
    const collection = await this.access(collectionId, actorId, CollectionRole.OWNER);
    const format = this.validate(collection, input);
    if (await this.sources.countDocuments({ collectionId }).exec() >= maxSourcesPerCollection) throw new BadRequestException(`A collection can have up to ${maxSourcesPerCollection} data sources`);
    const source = await this.sources.create({ collectionId, ownerId: collection.ownerId, ...this.clean(input, format), rateCount: 0 });
    await this.collaboration.logAction(collectionId, actorId, 'CREATE_DATA_SOURCE', `Data source ${source.id} into format ${format.id}`);
    return source;
  }

  async update(sourceId: string, input: DataSourceInput, actorId: string): Promise<DataSource> {
    assertNotFrozen('dataSources');
    const source = await this.source(sourceId);
    const collection = await this.access(source.collectionId, actorId, CollectionRole.OWNER);
    if (input.formatId !== source.formatId) throw new BadRequestException('The target data format of a data source cannot change; create another source');
    const format = this.validate(collection, input);
    const saved = await this.sources.findByIdAndUpdate(sourceId, { $set: this.clean(input, format) }, { new: true }).exec();
    await this.collaboration.logAction(source.collectionId, actorId, 'UPDATE_DATA_SOURCE', `Data source ${sourceId}`);
    return saved!;
  }

  async remove(sourceId: string, actorId: string): Promise<boolean> {
    const source = await this.source(sourceId);
    await this.access(source.collectionId, actorId, CollectionRole.OWNER);
    if (await this.runs.exists({ sourceId, state: { $in: ['QUEUED', 'RUNNING'] } })) throw new BadRequestException('Cancel the running delivery before deleting this data source');
    await this.runs.deleteMany({ sourceId }).exec();
    await this.sources.deleteOne({ _id: sourceId }).exec();
    await this.collaboration.logAction(source.collectionId, actorId, 'DELETE_DATA_SOURCE', `Data source ${sourceId}; entries kept`);
    return true;
  }

  async list(collectionId: string, actorId: string): Promise<DataSource[]> {
    await this.access(collectionId, actorId, CollectionRole.EDITOR);
    return this.sources.find({ collectionId }).sort({ createdAt: -1 }).exec();
  }

  async rotateKey(sourceId: string, actorId: string): Promise<DataSourceKey> {
    const source = await this.source(sourceId);
    await this.access(source.collectionId, actorId, CollectionRole.OWNER);
    const key = newKey();
    const saved = await this.sources.findByIdAndUpdate(sourceId, { $set: { keyHash: digest(key), keyHint: key.slice(-4), keyCreatedAt: new Date(), rateCount: 0, rateWindowAt: new Date() } }, { new: true }).exec();
    await this.collaboration.logAction(source.collectionId, actorId, 'ROTATE_DATA_SOURCE_KEY', `Data source ${sourceId}`);
    return { source: saved!, key };
  }

  async revokeKey(sourceId: string, actorId: string): Promise<DataSource> {
    const source = await this.source(sourceId);
    await this.access(source.collectionId, actorId, CollectionRole.OWNER);
    const saved = await this.sources.findByIdAndUpdate(sourceId, { $unset: { keyHash: '', keyHint: '', keyCreatedAt: '' } }, { new: true }).exec();
    await this.collaboration.logAction(source.collectionId, actorId, 'REVOKE_DATA_SOURCE_KEY', `Data source ${sourceId}`);
    return saved!;
  }

  // ---- deliveries ----

  private async enqueue(source: DataSource, collection: Collection, deliveryId: string, content: string, contentType: string, origin: string, actorId?: string, retryOf?: string): Promise<DataSourceRun> {
    if (!/^[\w.:-]{1,100}$/.test(deliveryId)) throw new BadRequestException('Delivery ID must be 1 to 100 letters, digits, dots, colons, dashes or underscores');
    if (typeof content !== 'string') throw new BadRequestException('Send the delivery content');
    const contentHash = digest(`${contentType}\n${content}`);
    const prior = await this.runs.findOne({ sourceId: source.id, deliveryId }).select('-content -rejections').exec();
    if (prior) {
      if (prior.contentHash !== contentHash) throw new BadRequestException('This delivery ID was already used for different content');
      return prior;
    }
    const format = collection.formats.find((item) => item.id === source.formatId);
    if (!format) throw new BadRequestException('MAPPING_STALE: the target data format no longer exists');
    let parsed;
    let ignoredColumns: string[];
    try {
      parsed = parseDelivery(content, contentType, source.delimiter);
      ignoredColumns = checkHeader(source, parsed.header);
    } catch (error) {
      if (error instanceof DeliveryError) throw new BadRequestException(`${error.code}: ${error.message}`);
      throw error;
    }
    try {
      const run = await this.runs.create({ sourceId: source.id, collectionId: source.collectionId, ownerId: source.ownerId, deliveryId, origin, actorId, contentType, content, contentHash, retryOf, state: 'QUEUED', total: parsed.rows.length, ignoredColumns, receivedAt: new Date() });
      await this.collaboration.logAction(source.collectionId, actorId ?? source.ownerId, 'DATA_SOURCE_DELIVERY', `Data source ${source.id}; delivery ${deliveryId}; ${origin}; rows ${parsed.rows.length}`);
      void this.tick();
      return run;
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      const existing = await this.runs.findOne({ sourceId: source.id, deliveryId }).select('-content -rejections').exec();
      if (existing?.contentHash === contentHash) return existing;
      throw new BadRequestException('This delivery ID was already used for different content');
    }
  }

  async upload(sourceId: string, deliveryId: string, content: string, contentType: string, actorId: string): Promise<DataSourceRun> {
    assertNotFrozen('dataSources');
    const source = await this.source(sourceId);
    const collection = await this.sourceAccess(source, actorId);
    return this.enqueue(source, collection, deliveryId, content, contentType, 'UPLOAD', actorId);
  }

  async push(key: string, deliveryId: string, content: string, contentType: string): Promise<DataSourceRun> {
    assertNotFrozen('dataSources');
    if (!validKey(key)) throw new NotFoundException('Data source key unavailable');
    const source = await this.sources.findOne({ keyHash: digest(key) }).exec();
    if (!source) throw new NotFoundException('Data source key unavailable');
    const windowStart = new Date(Date.now() - 3600_000);
    const allowed = await this.sources.findOneAndUpdate(
      { _id: source.id, keyHash: source.keyHash, $or: [{ rateWindowAt: { $lt: windowStart } }, { rateWindowAt: null }, { rateCount: { $lt: maxPushPerHour } }] },
      // A missing window sorts before any date, so it also starts a new window.
      [{ $set: { rateCount: { $cond: [{ $lt: ['$rateWindowAt', windowStart] }, 1, { $add: ['$rateCount', 1] }] }, rateWindowAt: { $cond: [{ $lt: ['$rateWindowAt', windowStart] }, new Date(), '$rateWindowAt'] } } }],
      { new: true, updatePipeline: true },
    ).exec();
    if (!allowed) throw new HttpException(`At most ${maxPushPerHour} deliveries per hour for one key`, HttpStatus.TOO_MANY_REQUESTS);
    const collection = await this.collections.one(source.collectionId, source.ownerId);
    return this.enqueue(source, collection, deliveryId, content, contentType, 'PUSH');
  }

  private async runFor(runId: string, actorId: string, withContent = false): Promise<DataSourceRun> {
    if (!Types.ObjectId.isValid(runId)) throw new NotFoundException('Delivery not found');
    const run = await this.runs.findById(runId).select(withContent ? '' : '-content').exec();
    if (!run) throw new NotFoundException('Delivery not found');
    await this.sourceAccess(await this.source(run.sourceId), actorId);
    return run;
  }

  async runsFor(sourceId: string, actorId: string): Promise<DataSourceRun[]> {
    await this.sourceAccess(await this.source(sourceId), actorId);
    return this.runs.find({ sourceId }).select('-content -rejections').sort({ createdAt: -1 }).limit(30).exec();
  }

  async detail(runId: string, actorId: string): Promise<DataSourceRun> { return this.runFor(runId, actorId); }

  async cancel(runId: string, actorId: string): Promise<DataSourceRun> {
    await this.runFor(runId, actorId);
    await this.runs.updateOne({ _id: runId, state: 'QUEUED' }, { $set: { state: 'CANCELLED', finishedAt: new Date(), expiresAt: new Date(Date.now() + expiryMs) } }).exec();
    await this.runs.updateOne({ _id: runId, state: 'RUNNING' }, { $set: { cancelRequested: true } }).exec();
    return this.runFor(runId, actorId);
  }

  async resume(runId: string, actorId: string): Promise<DataSourceRun> {
    assertNotFrozen('dataSources');
    await this.runFor(runId, actorId);
    const run = await this.runs.findOneAndUpdate({ _id: runId, state: { $in: ['CANCELLED', 'FAILED'] } }, { $set: { state: 'QUEUED', cancelRequested: false }, $unset: { failure: '', expiresAt: '', leaseUntil: '', workerId: '', finishedAt: '' } }, { new: true }).select('-content').exec();
    if (!run) throw new BadRequestException('Only cancelled or failed deliveries can be resumed');
    void this.tick();
    return run;
  }

  /** Re-send only the rejected rows (as stored) once the source or data format has been fixed. */
  async retryRejections(runId: string, actorId: string): Promise<DataSourceRun> {
    assertNotFrozen('dataSources');
    const run = await this.runFor(runId, actorId, true);
    if (!['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.state)) throw new BadRequestException('Wait for the delivery to finish');
    const rows = run.rejections.filter((item) => item.cells.length).map((item) => item.cells);
    if (!rows.length) throw new BadRequestException('No rejected row to retry');
    const source = await this.source(run.sourceId);
    const collection = await this.collections.one(run.collectionId, actorId);
    const header = parseDelivery(run.content, run.contentType, source.delimiter).header;
    const content = toCsv(header, rows, source.delimiter);
    const attempt = await this.runs.countDocuments({ retryOf: run.id }).exec();
    return this.enqueue(source, collection, `retry-${run.id}-${attempt + 1}`, content, 'text/csv', 'RETRY', actorId, run.id);
  }

  async rejectionsCsv(runId: string, actorId: string): Promise<string> {
    const run = await this.runFor(runId, actorId, true);
    const source = await this.source(run.sourceId);
    const header = parseDelivery(run.content, run.contentType, source.delimiter).header;
    return toCsv(['row', 'code', 'message', ...header], run.rejections.map((item) => [String(item.row), item.code, item.message, ...item.cells]), source.delimiter);
  }

  // ---- worker ----

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let guard = 0; guard < 5; guard += 1) {
        const now = new Date();
        const busy = await this.runs.distinct('sourceId', { state: 'RUNNING', leaseUntil: { $gte: now } }).exec();
        const run = await this.runs.findOneAndUpdate(
          { sourceId: { $nin: busy }, $or: [{ state: 'QUEUED' }, { state: 'RUNNING', leaseUntil: { $lt: now } }] },
          { $set: { state: 'RUNNING', workerId: this.workerId, leaseUntil: new Date(now.getTime() + leaseMs) } },
          { sort: { createdAt: 1 }, new: true },
        ).exec();
        if (!run) return;
        // One delivery per source at a time keeps record versions in order.
        const other = await this.runs.exists({ _id: { $ne: run.id }, sourceId: run.sourceId, state: 'RUNNING', leaseUntil: { $gte: now } });
        if (other) { await this.runs.updateOne({ _id: run.id, workerId: this.workerId }, { $set: { state: 'QUEUED' }, $unset: { workerId: '', leaseUntil: '' } }).exec(); continue; }
        await this.process(run);
      }
    } catch (error) { this.logger.error(error); }
    finally { this.running = false; }
  }

  private async finish(run: DataSourceRun, state: 'COMPLETED' | 'CANCELLED' | 'FAILED', failure?: string) {
    const fresh = await this.runs.findById(run.id).select('processed durationMs').exec();
    const durationMs = fresh?.durationMs ?? 0;
    await this.runs.updateOne({ _id: run.id, workerId: this.workerId }, {
      $set: { state, failure, finishedAt: new Date(), expiresAt: new Date(Date.now() + expiryMs), rowsPerSecond: durationMs > 0 ? Math.round(((fresh?.processed ?? 0) / durationMs) * 100_000) / 100 : undefined },
      $unset: { workerId: '', leaseUntil: '' },
    }).exec();
  }

  private async process(run: DataSourceRun): Promise<void> {
    try {
      const source = await this.sources.findById(run.sourceId).exec();
      if (!source) throw new Error('Data source deleted');
      const collection = await this.collections.one(source.collectionId, source.ownerId);
      const format = collection.formats.find((item) => item.id === source.formatId);
      if (!format) throw new Error('MAPPING_STALE: the target data format no longer exists');
      const stale = source.mappings.filter((item) => !format.fields.some((field) => field.id === item.fieldId && DATA_SOURCE_KINDS.has(field.kind)));
      if (stale.length) throw new Error(`MAPPING_STALE: mapped fields were removed or changed type (${stale.map((item) => item.column).join(', ')}); update the mapping and resume`);
      const parsed = parseDelivery(run.content, run.contentType, source.delimiter);
      checkHeader(source, parsed.header);
      const duplicates = duplicateRows(parsed.header, parsed.rows, source.recordIdColumn);
      if (!run.startedAt) await this.runs.updateOne({ _id: run.id }, { $set: { startedAt: new Date() } }).exec();
      for (let start = run.processed; start < parsed.rows.length; start += batchSize) {
        const fresh = await this.runs.findOne({ _id: run.id, workerId: this.workerId, state: 'RUNNING' }).select('cancelRequested').exec();
        if (!fresh) return;
        if (fresh.cancelRequested) { await this.finish(run, 'CANCELLED'); return; }
        const began = Date.now();
        const counts = await this.batch(run, source, collection, format, parsed.header, parsed.rows.slice(start, start + batchSize), start, duplicates);
        const updated = await this.runs.updateOne({ _id: run.id, workerId: this.workerId, state: 'RUNNING', processed: start }, {
          $inc: { processed: Math.min(batchSize, parsed.rows.length - start), createdCount: counts.created, updatedCount: counts.updated, unchangedCount: counts.unchanged, olderCount: counts.older, rejectedCount: counts.rejections.length, durationMs: Date.now() - began },
          $push: { rejections: { $each: counts.rejections, $slice: maxStoredRejections } },
          $max: { maxLagSeconds: counts.maxLag },
          $set: { leaseUntil: new Date(Date.now() + leaseMs) },
        }).exec();
        if (updated.modifiedCount !== 1) throw new Error('Delivery lease lost');
      }
      await this.finish(run, 'COMPLETED');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Delivery failed';
      if (message !== 'Delivery lease lost') await this.finish(run, 'FAILED', message.slice(0, 500));
    }
  }

  private async batch(run: DataSourceRun, source: DataSource, collection: Collection, format: CollectionFormat, header: string[], rows: string[][], offset: number, duplicates: Set<number>) {
    const importKey = `ds-${source.id}`;
    const ownerId = collection.ownerId;
    const now = new Date();
    const rejections: DataSourceRejection[] = [];
    const reject = (index: number, cells: string[], rejection: RowRejection, recordId?: string) => rejections.push({ row: offset + index + 1, recordId, code: rejection.code, message: rejection.message.slice(0, 300), cells: cells.map((cell) => cell.slice(0, 2000)) });
    const prepared: { index: number; cells: string[]; row: PreparedRow }[] = [];
    rows.forEach((cells, index) => {
      if (duplicates.has(offset + index)) { reject(index, cells, { code: 'DUPLICATE_IN_DELIVERY', message: 'This record ID appears earlier in the delivery' }); return; }
      const result = prepareRow(source, format, header, cells);
      if ('code' in result) reject(index, cells, result); else prepared.push({ index, cells, row: result });
    });
    // `$type` lets MongoDB use the partial unique index (importKey, sourceId) instead of scanning the collection.
    const existing = await this.entries.find({ ownerId, collectionId: collection.id, importKey: { $eq: importKey, $type: 'string' }, sourceId: { $in: prepared.map((item) => item.row.recordId), $type: 'string' } }).exec();
    const byRecord = new Map(existing.map((entry) => [entry.sourceId!, entry]));
    const locked = new Set((await this.stockMovements.distinct('sourceEntryId', { collectionId: collection.id, sourceEntryId: { $in: existing.map((entry) => entry.id) } }).exec()).map(String));
    const operations: Parameters<Model<Entry>['bulkWrite']>[0] = [];
    const updatedIds: { id: string; index: number; cells: string[]; recordId: string }[] = [];
    let created = 0; let unchanged = 0; let older = 0; let maxLag = 0;
    for (const { index, cells, row } of prepared) {
      const entry = byRecord.get(row.recordId);
      let values: EntryValue[];
      try { values = this.collections.validateSourceValues(collection, format, row.inputs, entry?.values ?? []); }
      catch (error) { reject(index, cells, { code: 'INVALID_VALUE', message: error instanceof Error ? error.message : 'Invalid value' }, row.recordId); continue; }
      const unit = unitMismatch(row.units, values, format);
      if (unit) { reject(index, cells, { code: 'UNIT_MISMATCH', message: unit }, row.recordId); continue; }
      const merged = entry ? mergeValues(entry.values, values) : values;
      if (format.objectModel) {
        const title = format.fields.find((field) => field.kind === FieldKind.TITLE);
        if (!title || !merged.some((item) => item.fieldId === title.id && item.value.trim())) { reject(index, cells, { code: 'INVALID_VALUE', message: 'Give this object a name' }, row.recordId); continue; }
      }
      if (row.observedAt) maxLag = Math.max(maxLag, Math.round((run.receivedAt.getTime() - row.observedAt.getTime()) / 1000));
      if (!entry) {
        created += 1;
        operations.push({ updateOne: {
          filter: { ownerId, collectionId: collection.id, importKey: { $eq: importKey, $type: 'string' }, sourceId: { $eq: row.recordId, $type: 'string' } },
          update: { $setOnInsert: { ownerId, collectionId: collection.id, importKey, sourceId: row.recordId, formatId: format.id, formatVersion: format.version ?? 1, values, dataSourceId: source.id, sourceObservedAt: row.observedAt, sourceReceivedAt: run.receivedAt, sourceRunId: run.id, createdAt: now, updatedAt: now } },
          upsert: true,
        } });
        continue;
      }
      if (entry.movingOperationId || locked.has(entry.id)) { reject(index, cells, { code: 'LOCKED_ENTRY', message: 'This entry has a validated stock effect or is being moved; it is left unchanged' }, row.recordId); continue; }
      if (source.updatePolicy === 'KEEP_FIRST' || sameValues(entry.values, merged)) { unchanged += 1; continue; }
      if (row.observedAt && entry.sourceObservedAt && row.observedAt < entry.sourceObservedAt) { older += 1; continue; }
      updatedIds.push({ id: entry.id, index, cells, recordId: row.recordId });
      operations.push({ updateOne: {
        filter: { _id: entry.id, movingOperationId: null, updatedAt: entry.updatedAt },
        update: {
          $set: { values: merged, formatVersion: format.version ?? 1, dataSourceId: source.id, sourceObservedAt: row.observedAt ?? entry.sourceObservedAt, sourceReceivedAt: run.receivedAt, sourceRunId: run.id, updatedAt: now },
          $push: { revisions: { $each: [{ at: entry.updatedAt, formatVersion: entry.formatVersion ?? 1, values: entry.values }], $slice: -20 } },
        },
      } });
    }
    let updated = updatedIds.length;
    if (operations.length) {
      const result = await this.entries.bulkWrite(operations, { ordered: false, timestamps: false });
      created = result.upsertedCount;
      if (result.matchedCount - (operations.length - updatedIds.length - result.upsertedCount) < updatedIds.length) {
        // Someone edited one of these entries during the batch: report it rather than overwrite.
        const after = await this.entries.find({ _id: { $in: updatedIds.map((item) => item.id) } }).select('sourceRunId updatedAt').exec();
        const written = new Set(after.filter((entry) => entry.sourceRunId === run.id && entry.updatedAt.getTime() === now.getTime()).map((entry) => entry.id));
        for (const item of updatedIds.filter((candidate) => !written.has(candidate.id))) reject(item.index, item.cells, { code: 'CHANGED_DURING_RUN', message: 'This entry changed while the delivery ran; retry the rejected rows' }, item.recordId);
        updated = written.size;
      }
      unchanged += operations.length - updatedIds.length - result.upsertedCount; // rows inserted by an interrupted earlier attempt
    }
    rejections.sort((a, b) => a.row - b.row);
    return { created, updated, unchanged, older, rejections, maxLag };
  }
}
