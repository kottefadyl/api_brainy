// T44 — large files by reference: resumable chunked upload to S3-compatible storage,
// entry binding, short signed download links, presence and integrity checks, cleanup.
import { BadRequestException, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnApplicationShutdown, ServiceUnavailableException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { createHash } from 'node:crypto';
import { Model, Types } from 'mongoose';
import { CollectionRole } from './collaboration.schema.js';
import { CollaborationService } from './collaboration.service.js';
import { Collection, FieldKind } from './collection.schema.js';
import { Entry, EntryValue } from './entry.schema.js';
import { LARGE_FILE_CHUNK, LARGE_FILE_MAX, LARGE_FILE_THRESHOLD, LargeFile, LargeFileLink, LargeFileStatus, LargeFileUpload, StartLargeFileUploadInput } from './large-file.schema.js';
import { S3Error, S3Storage } from './large-file.s3.js';
import { assertNotFrozen, isFrozen } from '../platform.js';

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
/** File fingerprint: SHA-256 of the part SHA-256 list (hex, one per line, in order). Same rule on every client. */
export const manifestDigest = (partHashes: string[]) => sha256(partHashes.join('\n'));
const linkSeconds = 300;
const staleUploadMs = 48 * 3600_000;
const unreferencedMs = 24 * 3600_000;

type CollectionAccess = { one(id: string, userId: string): Promise<Collection> };

@Injectable()
export class LargeFileService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(LargeFileService.name);
  private timer?: ReturnType<typeof setInterval>;
  private collections?: CollectionAccess;

  constructor(
    @InjectModel(LargeFile.name) private readonly files: Model<LargeFile>,
    @InjectModel(Entry.name) private readonly entries: Model<Entry>,
    private readonly storage: S3Storage,
    private readonly collaboration: CollaborationService,
  ) {}

  /** CollectionsService registers itself here (it depends on this service, not the other way round). */
  useCollections(collections: CollectionAccess) { this.collections = collections; }

  onApplicationBootstrap() { if (isFrozen('largeFiles')) return; this.timer = setInterval(() => { void this.cleanup().catch((error) => this.logger.error(error)); }, 10 * 60_000); }
  onApplicationShutdown() { if (this.timer) clearInterval(this.timer); }

  private ready() { if (!this.storage.configured) throw new ServiceUnavailableException('Large file storage is not configured'); }

  private async collection(collectionId: string, userId: string, role: CollectionRole) {
    if (!this.collections) throw new ServiceUnavailableException('Large file storage is starting');
    const collection = await this.collections.one(collectionId, userId);
    const access = this.collaboration.checkAccess(collection, userId, role);
    return { collection, member: access.member };
  }

  private view(file: LargeFile): LargeFileUpload {
    return { id: file.id, fileName: file.fileName, size: file.size, chunkSize: file.chunkSize, partCount: file.partCount, receivedParts: file.parts.map((part) => part.partNumber).sort((a, b) => a - b), state: file.state, sha256: file.sha256 };
  }

  private async own(uploadId: string, userId: string): Promise<LargeFile> {
    if (!Types.ObjectId.isValid(uploadId)) throw new NotFoundException('Upload not found');
    const file = await this.files.findOne({ _id: uploadId, uploaderId: userId }).exec();
    if (!file) throw new NotFoundException('Upload not found');
    return file;
  }

  // ---- upload ----

  async start(collectionId: string, input: StartLargeFileUploadInput, userId: string): Promise<LargeFileUpload> {
    assertNotFrozen('largeFiles');
    this.ready();
    const { collection } = await this.collection(collectionId, userId, CollectionRole.EDITOR);
    const name = input.fileName?.trim() ?? '';
    if (!name || name.length > 255 || /[\\/\x00-\x1f\x7f]/.test(name) || name === '.' || name === '..') throw new BadRequestException('Choose a file with a valid name');
    const mimeType = input.mimeType?.trim() || 'application/octet-stream';
    if (mimeType.length > 100 || !/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)) throw new BadRequestException('The file type is not valid');
    if (!Number.isSafeInteger(input.size) || input.size <= LARGE_FILE_THRESHOLD) throw new BadRequestException('Files up to 2 MiB are attached directly to the entry');
    if (input.size > LARGE_FILE_MAX) throw new BadRequestException(`Large files are limited to ${Math.floor(LARGE_FILE_MAX / 1048576)} MiB`);
    // Choosing the same file again resumes the unfinished upload instead of starting over.
    const resumable = await this.files.findOne({ uploaderId: userId, collectionId, fileName: name, size: input.size, state: 'UPLOADING' }).sort({ createdAt: -1 }).exec();
    if (resumable) return this.view(resumable);
    const objectKey = `${collection.ownerId}/${collectionId}/${new Types.ObjectId().toString()}`;
    const uploadId = await this.storage.createMultipart(objectKey, mimeType);
    const file = await this.files.create({ collectionId, ownerId: collection.ownerId, uploaderId: userId, fileName: name, mimeType, size: input.size, chunkSize: LARGE_FILE_CHUNK, partCount: Math.ceil(input.size / LARGE_FILE_CHUNK), objectKey, uploadId, parts: [], state: 'UPLOADING' });
    return this.view(file);
  }

  async status(uploadId: string, userId: string): Promise<LargeFileUpload> { return this.view(await this.own(uploadId, userId)); }

  async uploadPart(uploadId: string, partNumber: number, base64: string, hash: string, userId: string): Promise<LargeFileUpload> {
    assertNotFrozen('largeFiles');
    this.ready();
    const file = await this.own(uploadId, userId);
    if (file.state !== 'UPLOADING') throw new BadRequestException('This upload is already finished');
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > file.partCount) throw new BadRequestException('Invalid part number');
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new BadRequestException('Each part needs its SHA-256 fingerprint');
    const expected = partNumber < file.partCount ? file.chunkSize : file.size - file.chunkSize * (file.partCount - 1);
    if (typeof base64 !== 'string' || base64.length > Math.ceil(expected / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new BadRequestException('Part has the wrong size');
    const data = Buffer.from(base64, 'base64');
    if (data.length !== expected) throw new BadRequestException('Part has the wrong size');
    if (sha256(data) !== hash) throw new BadRequestException('Part fingerprint does not match: the part was altered in transit; send it again');
    const known = file.parts.find((part) => part.partNumber === partNumber);
    if (known?.sha256 === hash) return this.view(file);
    const etag = await this.storage.uploadPart(file.objectKey, file.uploadId!, partNumber, data, hash);
    await this.files.updateOne({ _id: file.id, state: 'UPLOADING' }, { $pull: { parts: { partNumber } } }).exec();
    const saved = await this.files.findOneAndUpdate({ _id: file.id, state: 'UPLOADING' }, { $push: { parts: { partNumber, size: data.length, sha256: hash, etag } } }, { returnDocument: 'after' }).exec();
    if (!saved) throw new BadRequestException('This upload is already finished');
    return this.view(saved);
  }

  async complete(uploadId: string, hash: string, userId: string): Promise<LargeFileUpload> {
    assertNotFrozen('largeFiles');
    this.ready();
    const file = await this.own(uploadId, userId);
    if (file.state !== 'UPLOADING') return this.view(file);
    const parts = [...file.parts].sort((a, b) => a.partNumber - b.partNumber);
    if (parts.length !== file.partCount || parts.some((part, index) => part.partNumber !== index + 1)) throw new BadRequestException('Some parts are missing; resume the upload');
    const digest = manifestDigest(parts.map((part) => part.sha256));
    if (digest !== hash) throw new BadRequestException('File fingerprint does not match the parts received');
    await this.storage.completeMultipart(file.objectKey, file.uploadId!, parts.map((part) => ({ partNumber: part.partNumber, etag: part.etag })));
    const stored = await this.storage.head(file.objectKey);
    if (stored !== file.size) throw new BadRequestException('Stored file size differs from the upload');
    const now = new Date();
    const saved = await this.files.findOneAndUpdate({ _id: file.id, state: 'UPLOADING' }, { $set: { state: 'COMPLETE', sha256: digest, completedAt: now, checkedAt: now, unreferencedSince: now }, $unset: { uploadId: '' } }, { returnDocument: 'after' }).exec();
    return this.view(saved ?? (await this.own(uploadId, userId)));
  }

  async abort(uploadId: string, userId: string): Promise<boolean> {
    const file = await this.own(uploadId, userId);
    if (file.state !== 'UPLOADING') throw new BadRequestException('Only an unfinished upload can be cancelled');
    if (file.uploadId) await this.storage.abortMultipart(file.objectKey, file.uploadId);
    await this.files.updateOne({ _id: file.id }, { $set: { state: 'ABORTED' }, $unset: { uploadId: '' } }).exec();
    return true;
  }

  // ---- entries ----

  /** Called after value validation: checks new references and copies their metadata into the values. */
  async bind(collection: Collection, values: EntryValue[], existing: EntryValue[] = []): Promise<void> {
    const kept = new Map(existing.filter((value) => value.largeFileId).map((value) => [value.largeFileId!, value]));
    for (const value of values) {
      if (!value.largeFileId) continue;
      const previous = kept.get(value.largeFileId);
      if (previous) {
        Object.assign(value, { attachmentSize: previous.attachmentSize, attachmentMimeType: previous.attachmentMimeType, largeFileSha256: previous.largeFileSha256 });
        continue;
      }
      if (!Types.ObjectId.isValid(value.largeFileId)) throw new BadRequestException('Large file not found');
      const file = await this.files.findById(value.largeFileId).exec();
      if (!file || file.collectionId !== collection.id || !['COMPLETE', 'AVAILABLE'].includes(file.state)) throw new BadRequestException('Finish uploading the large file before saving the entry');
      Object.assign(value, { value: value.value || file.fileName, attachmentSize: file.size, attachmentMimeType: file.mimeType, largeFileSha256: file.sha256 });
    }
    const bound = values.filter((value) => value.largeFileId).map((value) => value.largeFileId!);
    if (bound.length) await this.files.updateMany({ _id: { $in: bound } }, { $unset: { unreferencedSince: '' } }).exec();
    const dropped = [...kept.keys()].filter((id) => !bound.includes(id));
    if (dropped.length) await this.markIfUnreferenced(dropped);
  }

  /** Files no entry references any more are deleted by the cleanup after a grace period. */
  async markIfUnreferenced(ids: string[]): Promise<void> {
    await this.files.updateMany({ _id: { $in: ids.filter((id) => Types.ObjectId.isValid(id)) }, unreferencedSince: null }, { $set: { unreferencedSince: new Date() } }).exec();
  }

  private async readable(entryId: string, fieldId: string, userId: string) {
    if (!Types.ObjectId.isValid(entryId)) throw new NotFoundException('Entry not found');
    const entry = await this.entries.findById(entryId).exec();
    if (!entry) throw new NotFoundException('Entry not found');
    const { collection, member } = await this.collection(entry.collectionId, userId, CollectionRole.READER);
    const format = collection.formats.find((item) => item.id === (entry.formatId ?? collection.formats[0]?.id));
    if (!format?.fields.some((field) => field.id === fieldId && field.kind === FieldKind.ATTACHMENT)) throw new NotFoundException('Attachment not found');
    const visible = this.collaboration.filterEntryFields(entry, member, collection);
    const value = visible.values.find((item) => item.fieldId === fieldId);
    if (!value?.largeFileId || !Types.ObjectId.isValid(value.largeFileId)) throw new NotFoundException('Attachment not found');
    const file = await this.files.findById(value.largeFileId).exec();
    // A reference copied from another account (restore, import) never opens that account's file.
    if (!file || file.ownerId !== collection.ownerId || !['COMPLETE', 'AVAILABLE', 'MISSING', 'CORRUPTED'].includes(file.state)) throw new NotFoundException('The large file is missing from storage');
    return { collection, visible, file };
  }

  async link(entryId: string, fieldId: string, userId: string): Promise<LargeFileLink> {
    this.ready();
    const { collection, visible, file } = await this.readable(entryId, fieldId, userId);
    const size = await this.storage.head(file.objectKey);
    if (size === null) {
      await this.files.updateOne({ _id: file.id }, { $set: { state: 'MISSING', checkedAt: new Date() } }).exec();
      throw new NotFoundException('The large file is missing from storage');
    }
    await this.collaboration.auditProtectedRead(collection, userId, [visible]);
    return { url: this.storage.presignGet(file.objectKey, linkSeconds, file.fileName, file.mimeType), expiresAt: new Date(Date.now() + linkSeconds * 1000), fileName: file.fileName, size: file.size, sha256: file.sha256 };
  }

  /** Full check: presence, size, then every part re-read by range and re-hashed. */
  async verify(entryId: string, fieldId: string, userId: string): Promise<LargeFileStatus> {
    this.ready();
    const { file } = await this.readable(entryId, fieldId, userId);
    let state = 'AVAILABLE';
    const size = await this.storage.head(file.objectKey);
    if (size === null) state = 'MISSING';
    else if (size !== file.size) state = 'CORRUPTED';
    else {
      const parts = [...file.parts].sort((a, b) => a.partNumber - b.partNumber);
      for (const part of parts) {
        const start = (part.partNumber - 1) * file.chunkSize;
        const data = await this.storage.getRange(file.objectKey, start, start + part.size - 1);
        if (sha256(data) !== part.sha256) { state = 'CORRUPTED'; break; }
      }
      if (state === 'AVAILABLE' && manifestDigest(parts.map((part) => part.sha256)) !== file.sha256) state = 'CORRUPTED';
    }
    const checkedAt = new Date();
    await this.files.updateOne({ _id: file.id }, { $set: { state, checkedAt } }).exec();
    return { largeFileId: file.id, fileName: file.fileName, size: file.size, state, checkedAt };
  }

  /** Quick check of every reference in a collection: presence and size only. */
  async check(collectionId: string, userId: string): Promise<LargeFileStatus[]> {
    this.ready();
    const { collection } = await this.collection(collectionId, userId, CollectionRole.READER);
    const ids = (await this.entries.distinct('values.largeFileId', { collectionId, 'values.largeFileId': { $type: 'string' } }).exec()).map(String).filter((id) => Types.ObjectId.isValid(id)).slice(0, 500);
    const files = await this.files.find({ _id: { $in: ids } }).exec();
    const found = new Set(files.map((file) => file.id));
    const result: LargeFileStatus[] = ids.filter((id) => !found.has(id)).map((id) => ({ largeFileId: id, fileName: '', size: 0, state: 'MISSING' }));
    for (const file of files) {
      if (file.ownerId !== collection.ownerId) { result.push({ largeFileId: file.id, fileName: file.fileName, size: file.size, state: 'MISSING' }); continue; }
      const size = await this.storage.head(file.objectKey);
      const state = size === null ? 'MISSING' : size !== file.size ? 'CORRUPTED' : file.state === 'CORRUPTED' ? 'CORRUPTED' : 'AVAILABLE';
      const checkedAt = new Date();
      await this.files.updateOne({ _id: file.id }, { $set: { state, checkedAt } }).exec();
      result.push({ largeFileId: file.id, fileName: file.fileName, size: file.size, state, checkedAt });
    }
    return result;
  }

  /** Metadata listed by exports so files can be retrieved later; never the content. */
  async references(collectionIds: string[]) {
    const files = await this.files.find({ collectionId: { $in: collectionIds }, state: { $in: ['COMPLETE', 'AVAILABLE', 'MISSING', 'CORRUPTED'] } }).select('-parts -uploadId').lean().exec();
    return files.map((file) => ({ largeFileId: String(file._id), collectionId: file.collectionId, fileName: file.fileName, size: file.size, mimeType: file.mimeType, sha256: file.sha256, completedAt: file.completedAt, objectKey: `${this.storage.bucket}/${file.objectKey}` }));
  }

  // ---- cleanup ----

  async cleanup(): Promise<{ aborted: number; deleted: number }> {
    if (!this.storage.configured) return { aborted: 0, deleted: 0 };
    let aborted = 0; let deleted = 0;
    for (const file of await this.files.find({ state: 'UPLOADING', updatedAt: { $lt: new Date(Date.now() - staleUploadMs) } }).limit(100).exec()) {
      try { if (file.uploadId) await this.storage.abortMultipart(file.objectKey, file.uploadId); await this.files.updateOne({ _id: file.id }, { $set: { state: 'ABORTED' }, $unset: { uploadId: '' } }).exec(); aborted += 1; }
      catch (error) { if (!(error instanceof S3Error)) throw error; this.logger.warn(`Abort failed for ${file.id}: ${error.code}`); }
    }
    for (const file of await this.files.find({ state: { $in: ['COMPLETE', 'AVAILABLE', 'MISSING', 'CORRUPTED'] }, unreferencedSince: { $lt: new Date(Date.now() - unreferencedMs) } }).limit(100).exec()) {
      if (await this.entries.exists({ 'values.largeFileId': file.id })) { await this.files.updateOne({ _id: file.id }, { $unset: { unreferencedSince: '' } }).exec(); continue; }
      await this.storage.remove(file.objectKey);
      await this.files.deleteOne({ _id: file.id }).exec();
      deleted += 1;
    }
    return { aborted, deleted };
  }

  /** A deleted collection hands its files to the cleanup, which still keeps those referenced elsewhere. */
  async forgetCollection(collectionId: string): Promise<void> {
    await this.files.updateMany({ collectionId, unreferencedSince: null }, { $set: { unreferencedSince: new Date() } }).exec();
  }
}
