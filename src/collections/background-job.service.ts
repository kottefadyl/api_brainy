import { BadRequestException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { AnalysisInput } from './analysis.input';
import { AnalysisService } from './analysis.service';
import { StartBackgroundJobInput } from './background-job.input';
import { BackgroundJob, BackgroundJobLog } from './background-job.schema';
import { ImportEntriesInput } from './collection.input';
import { CollectionsService } from './collections.service';
import { ForecastInput } from './forecast.input';
import { ForecastService } from './forecast.service';
import { CollaborationService } from './collaboration.service';
import { protectedFields } from './sensitivity.logic';
import { EntryValue } from './entry.schema';
import { LargeFileService } from './large-file.service';
import { assertNotFrozen, isFrozen } from '../platform';

type ImportPayload = Pick<ImportEntriesInput, 'formatId' | 'rows'>;
type ExportPayload = { formatId: string; limit?: number; includeSensitive?: boolean };
const kinds = ['IMPORT', 'EXPORT', 'RECALCULATE', 'CHART', 'FORECAST'] as const;
const leaseMs = 120_000;
const expiryMs = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class BackgroundJobService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(BackgroundJobService.name);
  private readonly workerId = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    @InjectModel(BackgroundJob.name) private readonly jobs: Model<BackgroundJob>,
    private readonly collections: CollectionsService,
    private readonly analysis: AnalysisService,
    private readonly forecast: ForecastService,
    private readonly collaboration: CollaborationService,
    private readonly largeFiles: LargeFileService,
  ) {}

  onApplicationBootstrap() {
    if (isFrozen('backgroundJobs')) return;
    this.timer = setInterval(() => { void this.tick(); }, 1000);
    void this.tick();
  }

  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }

  private async ownedCollection(collectionId: string, userId: string) {
    const collection = await this.collections.one(collectionId, userId);
    if (collection.ownerId !== userId) throw new NotFoundException('Collection not found');
    return collection;
  }

  async start(collectionId: string, userId: string, input: StartBackgroundJobInput): Promise<BackgroundJob> {
    assertNotFrozen('backgroundJobs');
    const collection = await this.ownedCollection(collectionId, userId);
    if (!kinds.includes(input.kind as typeof kinds[number])) throw new BadRequestException('Choose a supported task');
    if (!/^[\w.-]{1,80}$/.test(input.requestKey)) throw new BadRequestException('Invalid task key');
    if (typeof input.payload !== 'string' || Buffer.byteLength(input.payload, 'utf8') > 2_000_000) throw new BadRequestException('Task input exceeds 2 MB');
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(input.payload) as Record<string, unknown>; } catch { throw new BadRequestException('Invalid task input'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.formatId !== 'string' || !collection.formats.some((format) => format.id === payload.formatId)) throw new BadRequestException('Choose a data format in this collection');
    let total = 1;
    if (input.kind === 'IMPORT') {
      const rows = payload.rows;
      if (!Array.isArray(rows) || rows.length < 1 || rows.length > 5000) throw new BadRequestException('Import 1 to 5000 rows per task');
      const ids = new Set<string>();
      for (const row of rows) {
        if (!row || typeof row !== 'object' || typeof row.sourceId !== 'string' || row.sourceId.length > 100 || ids.has(row.sourceId) || !Array.isArray(row.values)) throw new BadRequestException('Rows need distinct source IDs and values');
        ids.add(row.sourceId);
      }
      total = rows.length;
    } else if (input.kind === 'EXPORT') {
      const limit = payload.limit ?? 5000;
      if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 5000) throw new BadRequestException('Export 1 to 5000 entries per task');
      if (payload.includeSensitive !== undefined && typeof payload.includeSensitive !== 'boolean') throw new BadRequestException('Choose whether to include protected fields');
      total = Number(limit);
    } else if (input.kind === 'FORECAST') {
      if (typeof payload.fieldId !== 'string' || typeof payload.dateFieldId !== 'string' || typeof payload.frequency !== 'string' || typeof payload.method !== 'string' || typeof payload.measureKind !== 'string' || !Number.isInteger(payload.horizon) || !Number.isInteger(payload.holdout)) throw new BadRequestException('Choose forecast fields, method and horizon');
    } else if (typeof payload.operation !== 'string' || typeof payload.groupBy !== 'string' || typeof payload.measureKind !== 'string') {
      throw new BadRequestException('Choose an analysis operation and grouping');
    }
    const prior = await this.jobs.findOne({ ownerId: userId, collectionId, requestKey: input.requestKey }).exec();
    if (prior) {
      if (prior.kind !== input.kind || prior.payload !== input.payload) throw new BadRequestException('Task key already used for different input');
      return prior;
    }
    try {
      const job = await this.jobs.create({ ownerId: userId, collectionId, requestKey: input.requestKey, kind: input.kind, state: 'QUEUED', payload: input.payload, total, processed: 0, createdCount: 0, skippedCount: 0, errorCount: 0, logs: [] });
      void this.tick();
      return job;
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      const existing = await this.jobs.findOne({ ownerId: userId, collectionId, requestKey: input.requestKey }).exec();
      if (existing && existing.kind === input.kind && existing.payload === input.payload) return existing;
      throw new BadRequestException('Task key already used for different input');
    }
  }

  async list(collectionId: string, userId: string): Promise<BackgroundJob[]> {
    await this.ownedCollection(collectionId, userId);
    return this.jobs.find({ ownerId: userId, collectionId }).select('-payload -result').sort({ createdAt: -1 }).limit(30).exec();
  }

  private async one(jobId: string, userId: string): Promise<BackgroundJob> {
    if (!Types.ObjectId.isValid(jobId)) throw new NotFoundException('Task not found');
    const job = await this.jobs.findOne({ _id: jobId, ownerId: userId }).exec();
    if (!job) throw new NotFoundException('Task not found');
    await this.ownedCollection(job.collectionId, userId);
    return job;
  }

  async detail(jobId: string, userId: string): Promise<BackgroundJob> { return this.one(jobId, userId); }

  async cancel(jobId: string, userId: string): Promise<BackgroundJob> {
    const job = await this.one(jobId, userId);
    if (job.state === 'QUEUED') return (await this.jobs.findOneAndUpdate({ _id: jobId, ownerId: userId, state: 'QUEUED' }, { $set: { state: 'CANCELLED', expiresAt: new Date(Date.now() + expiryMs) } }, { new: true }).exec()) ?? this.cancel(jobId, userId);
    if (job.state === 'RUNNING') return (await this.jobs.findOneAndUpdate({ _id: jobId, ownerId: userId, state: 'RUNNING' }, { $set: { cancelRequested: true } }, { new: true }).exec()) ?? this.cancel(jobId, userId);
    return job;
  }

  async resume(jobId: string, userId: string): Promise<BackgroundJob> {
    assertNotFrozen('backgroundJobs');
    await this.one(jobId, userId);
    const job = await this.jobs.findOneAndUpdate({ _id: jobId, ownerId: userId, state: { $in: ['CANCELLED', 'FAILED'] } }, { $set: { state: 'QUEUED', cancelRequested: false }, $unset: { failure: '', expiresAt: '', leaseUntil: '', workerId: '' } }, { new: true }).exec();
    if (!job) throw new BadRequestException('Only cancelled or failed tasks can be resumed');
    void this.tick();
    return job;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const job = await this.jobs.findOneAndUpdate(
        { $or: [{ state: 'QUEUED' }, { state: 'RUNNING', leaseUntil: { $lt: now } }] },
        { $set: { state: 'RUNNING', workerId: this.workerId, leaseUntil: new Date(now.getTime() + leaseMs) } },
        { sort: { createdAt: 1 }, new: true },
      ).exec();
      if (job) await this.run(job);
    } catch (error) { this.logger.error(error); }
    finally { this.running = false; }
  }

  private async current(job: BackgroundJob): Promise<BackgroundJob> {
    const fresh = await this.jobs.findOne({ _id: job.id, workerId: this.workerId, state: 'RUNNING' }).exec();
    if (!fresh) throw new Error('Task lease lost');
    return fresh;
  }

  private async finish(job: BackgroundJob, state: 'COMPLETED' | 'CANCELLED' | 'FAILED', result?: string, failure?: string) {
    await this.jobs.updateOne({ _id: job.id, workerId: this.workerId, state: 'RUNNING' }, { $set: { state, result, failure, expiresAt: new Date(Date.now() + expiryMs) }, $unset: { workerId: '', leaseUntil: '' } }).exec();
  }

  private async run(job: BackgroundJob): Promise<void> {
    try {
      const fresh = await this.current(job);
      if (fresh.cancelRequested) { await this.finish(job, 'CANCELLED'); return; }
      const payload = JSON.parse(job.payload) as Record<string, unknown>;
      if (job.kind === 'IMPORT') { await this.importRows(job, payload as ImportPayload); return; }
      let result: unknown;
      if (job.kind === 'EXPORT') result = await this.exportRows(job, payload as ExportPayload);
      else if (job.kind === 'FORECAST') result = await this.forecast.forecast(job.collectionId, job.ownerId, payload as unknown as ForecastInput);
      else if (job.kind === 'RECALCULATE' || job.kind === 'CHART') result = await this.analysis.analyse(job.collectionId, job.ownerId, payload as unknown as AnalysisInput);
      else throw new BadRequestException('Unsupported task type');
      const serialized = JSON.stringify(result);
      if (Buffer.byteLength(serialized, 'utf8') > 4_000_000) throw new BadRequestException('Task result exceeds 4 MB; narrow the request');
      if ((await this.current(job)).cancelRequested) await this.finish(job, 'CANCELLED');
      else {
        await this.jobs.updateOne({ _id: job.id, workerId: this.workerId }, { $set: { processed: job.total } }).exec();
        await this.finish(job, 'COMPLETED', serialized);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Task failed';
      await this.finish(job, 'FAILED', undefined, message.slice(0, 500));
    }
  }

  private async importRows(job: BackgroundJob, payload: ImportPayload) {
    for (let start = job.processed; start < payload.rows.length; start += 50) {
      const fresh = await this.current(job);
      if (fresh.cancelRequested) { await this.finish(job, 'CANCELLED'); return; }
      const rows = payload.rows.slice(start, start + 50);
      const first = await this.collections.importEntriesBatch(job.collectionId, { formatId: payload.formatId, importKey: `job-${job.id}`, dryRun: false, rows }, job.ownerId);
      const rejected = new Set(first.errors.map((error) => error.sourceId));
      const validRows = rows.filter((row) => !rejected.has(row.sourceId));
      const result = first.errors.length && validRows.length
        ? await this.collections.importEntriesBatch(job.collectionId, { formatId: payload.formatId, importKey: `job-${job.id}`, dryRun: false, rows: validRows }, job.ownerId)
        : first;
      const logs: BackgroundJobLog[] = [...first.errors, ...(result === first ? [] : result.errors)].map((error) => ({ row: start + rows.findIndex((row) => row.sourceId === error.sourceId) + 1, message: `${error.sourceId}: ${error.message}`.slice(0, 500) }));
      const updated = await this.jobs.updateOne({ _id: job.id, workerId: this.workerId, state: 'RUNNING', processed: start }, {
        $inc: { processed: rows.length, createdCount: result.createdCount, skippedCount: result.skippedCount, errorCount: logs.length },
        $push: { logs: { $each: logs, $slice: -100 } },
        $set: { leaseUntil: new Date(Date.now() + leaseMs) },
      }).exec();
      if (updated.modifiedCount !== 1) throw new Error('Task lease lost');
    }
    if ((await this.current(job)).cancelRequested) await this.finish(job, 'CANCELLED');
    else await this.finish(job, 'COMPLETED', JSON.stringify({ createdCount: (await this.current(job)).createdCount, skippedCount: (await this.current(job)).skippedCount }));
  }

  private async exportRows(job: BackgroundJob, payload: ExportPayload) {
    const collection = await this.ownedCollection(job.collectionId, job.ownerId);
    const format = collection.formats.find((item) => item.id === payload.formatId);
    if (!format) throw new BadRequestException('Data format not found');
    const rows: { sourceId: string; createdAt: Date; updatedAt: Date; values: EntryValue[] }[] = [];
    let after: string | undefined;
    let hasMore = false;
    do {
      if ((await this.current(job)).cancelRequested) return { cancelled: true };
      const page = await this.collections.entriesPage(job.collectionId, job.ownerId, { first: Math.min(100, job.total - rows.length), after, formatId: payload.formatId });
      rows.push(...page.entries.map((entry) => ({ sourceId: entry.id, createdAt: entry.createdAt, updatedAt: entry.updatedAt, values: entry.values })));
      hasMore = page.hasMore;
      after = page.nextCursor ?? undefined;
      await this.jobs.updateOne({ _id: job.id, workerId: this.workerId }, { $set: { processed: rows.length, leaseUntil: new Date(Date.now() + leaseMs) } }).exec();
      if (Buffer.byteLength(JSON.stringify(rows), 'utf8') > 3_500_000) throw new BadRequestException('Export result exceeds 3.5 MB; narrow the request');
    } while (after && rows.length < job.total);
    const latest = await this.ownedCollection(job.collectionId, job.ownerId);
    const currentFormat = latest.formats.find((item) => item.id === payload.formatId);
    if (!currentFormat) throw new BadRequestException('Data format changed during export');
    const hidden = payload.includeSensitive === true ? new Set<string>() : protectedFields(currentFormat);
    // Values are Mongoose subdocuments: copy them as plain objects before reshaping (spreading a subdocument copies its internals).
    const plain = (value: EntryValue): EntryValue => (typeof (value as { toObject?: () => EntryValue }).toObject === 'function' ? (value as unknown as { toObject: () => EntryValue }).toObject() : value);
    const safeRows = rows.map((row) => ({ ...row, values: row.values.filter((value) => !hidden.has(value.fieldId)).map(plain).map((value) => payload.includeSensitive ? value : { ...value, objectSnapshots: [] }) }));
    if (payload.includeSensitive && protectedFields(currentFormat).size) await this.collaboration.logAction(job.collectionId, job.ownerId, 'EXPORT_PROTECTED_DATA', `Data format ${currentFormat.id}; rows ${rows.length}`);
    // T44: large attachments are listed by reference with how to retrieve them; their content is never exported.
    const referenced = new Set(rows.flatMap((row) => row.values.flatMap((value) => value.largeFileId ? [value.largeFileId] : [])));
    const largeFiles = referenced.size ? (await this.largeFiles.references([job.collectionId])).filter((file) => referenced.has(file.largeFileId)) : [];
    return { formatId: payload.formatId, rows: safeRows, hasMore, protectedFieldsIncluded: payload.includeSensitive === true, ...(largeFiles.length ? { largeFiles, largeFileNotice: 'Large files are listed by reference. Download each one from Brainy (a 5-minute signed link) or ask the storage administrator for the listed bucket/key.' } : {}) };
  }
}
