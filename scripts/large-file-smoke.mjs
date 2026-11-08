// T44 smoke: large files by reference. Runs on the host (signed links target the public storage address):
//   MONGODB_URI="mongodb://admin:password@localhost:27017/brainy?authSource=admin" node scripts/large-file-smoke.mjs
// LARGE_FILE_SMOKE_MB=300 attaches a file of several hundred MB (default 20).
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

const endpoint = `http://localhost:${process.env.PORT ?? 3000}/graphql`;
assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI for checks and cleanup');
await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
const users = [];
const MiB = 1024 * 1024;
const size = Number(process.env.LARGE_FILE_SMOKE_MB ?? 20) * MiB + 12345; // last part is short
const sha = (data) => createHash('sha256').update(data).digest('hex');

const call = async (query, variables = {}, token) => {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
  return response.json();
};
const data = (result) => { assert.equal(result.errors, undefined, JSON.stringify(result.errors)); return result.data; };
const fails = (result, pattern) => { assert.ok(result.errors?.length, 'Expected an error'); assert.match(result.errors[0].message, pattern); };
const register = async (name) => {
  const email = `lf-${randomUUID()}@example.test`;
  const auth = data(await call('mutation($i:RegisterInput!){register(input:$i){token user{id}}}', { i: { name, email, password: 'test-password-123' } })).register;
  users.push(auth.user.id);
  return { ...auth, email };
};
// Deterministic content generated part by part: the whole file is never held in memory.
const part = (number, chunk) => {
  const start = (number - 1) * chunk;
  const length = Math.min(chunk, size - start);
  const buffer = Buffer.alloc(Math.ceil(length / 4) * 4);
  for (let offset = 0; offset < buffer.length; offset += 4) buffer.writeUInt32LE(Math.imul(start + offset, 2654435761) >>> 0, offset);
  return buffer.subarray(0, length);
};
const UPLOAD = 'id fileName size chunkSize partCount receivedParts state sha256';
const send = (token, uploadId, number, buffer, hash = sha(buffer)) => call(`mutation($u:String!,$n:Int!,$b:String!,$s:String!){uploadLargeFilePart(uploadId:$u,partNumber:$n,base64:$b,sha256:$s){${UPLOAD}}}`, { u: uploadId, n: number, b: buffer.toString('base64'), s: hash }, token);

try {
  const owner = await register('Owner');
  const editor = await register('Editor');
  const reader = await register('Reader');
  const stranger = await register('Stranger');
  const collection = data(await call('mutation($i:CreateCollectionInput!){createCollection(input:$i){id formats{id fields{id name kind}}}}', { i: { name: 'Échantillons R6', formats: [{ name: 'Séquençage', color: '#EEF5FF', fields: [{ name: 'Échantillon', kind: 'TITLE' }, { name: 'Données brutes', kind: 'ATTACHMENT' }] }] } }, owner.token)).createCollection;
  const format = collection.formats[0];
  const [titleId, fileFieldId] = format.fields.map((field) => field.id);
  for (const [user, role] of [[editor, 'EDITOR'], [reader, 'READER']]) data(await call('mutation($c:String!,$e:String!,$r:CollectionRole!){addCollectionMember(collectionId:$c,email:$e,role:$r){id}}', { c: collection.id, e: user.email, r: role }, owner.token));

  const START = `mutation($c:String!,$i:StartLargeFileUploadInput!){startLargeFileUpload(collectionId:$c,input:$i){${UPLOAD}}}`;
  const input = { fileName: 'run-42.fastq.gz', mimeType: 'application/gzip', size };
  fails(await call(START, { c: collection.id, i: { ...input, size: 1000 } }, editor.token), /attached directly/);
  fails(await call(START, { c: collection.id, i: input }, reader.token), /Read-only/);
  fails(await call(START, { c: collection.id, i: input }, stranger.token), /not found|denied/i);
  const upload = data(await call(START, { c: collection.id, i: input }, editor.token)).startLargeFileUpload;
  assert.equal(upload.partCount, Math.ceil(size / upload.chunkSize));

  // 1. Integrity of each part and a cut after two parts.
  const first = part(1, upload.chunkSize);
  fails(await send(editor.token, upload.id, 1, first, sha(Buffer.from('other'))), /fingerprint does not match/);
  fails(await send(editor.token, upload.id, 1, first.subarray(0, 100)), /wrong size/);
  fails(await send(owner.token, upload.id, 1, first), /Upload not found/);
  data(await send(editor.token, upload.id, 1, first));
  data(await send(editor.token, upload.id, 2, part(2, upload.chunkSize)));
  data(await send(editor.token, upload.id, 2, part(2, upload.chunkSize))); // repeated part is idempotent

  // 2. Resume: choosing the same file again returns the same upload with the parts already received.
  const resumed = data(await call(START, { c: collection.id, i: input }, editor.token)).startLargeFileUpload;
  assert.equal(resumed.id, upload.id);
  assert.deepEqual(resumed.receivedParts, [1, 2]);
  const hashes = [];
  const started = Date.now();
  for (let number = 1; number <= upload.partCount; number += 1) {
    const buffer = part(number, upload.chunkSize);
    hashes.push(sha(buffer));
    if (!resumed.receivedParts.includes(number)) data(await send(editor.token, upload.id, number, buffer));
  }
  const uploadSeconds = (Date.now() - started) / 1000;
  const manifest = sha(hashes.join('\n'));
  const COMPLETE = `mutation($u:String!,$s:String!){completeLargeFileUpload(uploadId:$u,sha256:$s){${UPLOAD}}}`;
  fails(await call(COMPLETE, { u: upload.id, s: sha('wrong') }, editor.token), /fingerprint does not match/);
  const done = data(await call(COMPLETE, { u: upload.id, s: manifest }, editor.token)).completeLargeFileUpload;
  assert.equal(done.state, 'COMPLETE');
  assert.equal(done.sha256, manifest);

  // 3. The entry keeps metadata and the reference; an unchanged edit keeps the file.
  const SAVE = 'id values{fieldId value attachmentSize attachmentMimeType largeFileId largeFileSha256}';
  fails(await call(`mutation($c:String!,$i:SaveEntryInput!){createEntry(collectionId:$c,input:$i){${SAVE}}}`, { c: collection.id, i: { formatId: format.id, values: [{ fieldId: titleId, value: 'S-1' }, { fieldId: fileFieldId, value: 'x', largeFileId: new mongoose.Types.ObjectId().toString() }] } }, editor.token), /Finish uploading/);
  const entry = data(await call(`mutation($c:String!,$i:SaveEntryInput!){createEntry(collectionId:$c,input:$i){${SAVE}}}`, { c: collection.id, i: { formatId: format.id, values: [{ fieldId: titleId, value: 'S-1' }, { fieldId: fileFieldId, value: input.fileName, largeFileId: upload.id }] } }, editor.token)).createEntry;
  const stored = entry.values.find((value) => value.fieldId === fileFieldId);
  assert.deepEqual([stored.largeFileId, stored.attachmentSize, stored.attachmentMimeType, stored.largeFileSha256], [upload.id, size, 'application/gzip', manifest]);
  const edited = data(await call(`mutation($id:String!,$i:SaveEntryInput!){updateEntry(id:$id,input:$i){${SAVE}}}`, { id: entry.id, i: { values: [{ fieldId: titleId, value: 'S-1 bis' }, { fieldId: fileFieldId, value: input.fileName }] } }, owner.token)).updateEntry;
  assert.equal(edited.values.find((value) => value.fieldId === fileFieldId).largeFileId, upload.id);

  // 4. Short signed link for readers; streamed download matches the fingerprint; strangers get nothing.
  const LINK = 'query($e:String!,$f:String!){largeFileDownloadLink(entryId:$e,fieldId:$f){url expiresAt fileName size sha256}}';
  fails(await call(LINK, { e: entry.id, f: fileFieldId }, stranger.token), /not found|denied/i);
  const link = data(await call(LINK, { e: entry.id, f: fileFieldId }, reader.token)).largeFileDownloadLink;
  assert.equal(new URL(link.url).searchParams.get('X-Amz-Expires'), '300', 'links live 5 minutes');
  const response = await fetch(link.url);
  assert.equal(response.status, 200, await (response.ok ? '' : response.text()));
  assert.match(response.headers.get('content-disposition') ?? '', /run-42\.fastq\.gz/);
  const reader2 = response.body.getReader();
  const downloaded = [];
  let pending = Buffer.alloc(0); let total = 0;
  for (;;) {
    const { done: finished, value } = await reader2.read();
    if (value) { pending = Buffer.concat([pending, value]); total += value.length; }
    while (pending.length >= upload.chunkSize || (finished && pending.length)) { downloaded.push(sha(pending.subarray(0, upload.chunkSize))); pending = pending.subarray(Math.min(upload.chunkSize, pending.length)); }
    if (finished) break;
  }
  assert.equal(total, size);
  assert.equal(sha(downloaded.join('\n')), manifest, 'downloaded file matches its fingerprint');
  const tampered = new URL(link.url); tampered.searchParams.set('X-Amz-Expires', '86400');
  assert.equal((await fetch(tampered)).status, 403, 'a modified link is refused');

  // 5. Integrity and missing-file detection.
  const VERIFY = 'mutation($e:String!,$f:String!){verifyLargeFile(entryId:$e,fieldId:$f){state size}}';
  assert.equal(data(await call(VERIFY, { e: entry.id, f: fileFieldId }, reader.token)).verifyLargeFile.state, 'AVAILABLE');
  const record = await db.collection('large_files').findOne({ _id: new mongoose.Types.ObjectId(upload.id) });
  await db.collection('large_files').updateOne({ _id: record._id, 'parts.partNumber': 2 }, { $set: { 'parts.$.sha256': sha('tampered') } });
  assert.equal(data(await call(VERIFY, { e: entry.id, f: fileFieldId }, owner.token)).verifyLargeFile.state, 'CORRUPTED');
  await db.collection('large_files').updateOne({ _id: record._id }, { $set: { parts: record.parts, objectKey: `${record.objectKey}-gone` } });
  const checked = data(await call('mutation($c:String!){checkLargeFiles(collectionId:$c){largeFileId state}}', { c: collection.id }, owner.token)).checkLargeFiles;
  assert.deepEqual(checked.map((item) => item.state), ['MISSING']);
  fails(await call(LINK, { e: entry.id, f: fileFieldId }, owner.token), /missing from storage/);
  await db.collection('large_files').updateOne({ _id: record._id }, { $set: { objectKey: record.objectKey, state: 'AVAILABLE' } });

  // 6. Exports list references with retrieval instructions, never the content.
  const backup = JSON.parse(data(await call('query{workspaceBackup}', {}, owner.token)).workspaceBackup);
  assert.equal(backup.data.largeFiles.length, 1);
  assert.match(backup.largeFileNotice, /signed link/);
  assert.ok(!JSON.stringify(backup).includes(first.subarray(0, 64).toString('base64')), 'no file content in the backup');
  const job = data(await call('mutation($c:String!,$i:StartBackgroundJobInput!){startBackgroundJob(collectionId:$c,input:$i){id}}', { c: collection.id, i: { kind: 'EXPORT', requestKey: `lf-${randomUUID()}`, payload: JSON.stringify({ formatId: format.id }) } }, owner.token)).startBackgroundJob;
  let exported;
  for (let attempt = 0; attempt < 60 && !exported; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const state = data(await call('query($j:String!){backgroundJob(jobId:$j){state result}}', { j: job.id }, owner.token)).backgroundJob;
    if (state.state === 'COMPLETED') exported = JSON.parse(state.result);
  }
  assert.equal(exported.largeFiles[0].sha256, manifest);
  assert.equal(exported.rows[0].values.find((value) => value.fieldId === fileFieldId)?.largeFileId, upload.id, JSON.stringify(exported.rows[0].values).slice(0, 300));
  assert.match(exported.largeFileNotice, /bucket\/key/);

  // 7. Abort of an unfinished upload; deleting the entry hands the file to the cleanup.
  const other = data(await call(START, { c: collection.id, i: { ...input, fileName: 'abandoned.bin' } }, editor.token)).startLargeFileUpload;
  assert.equal(data(await call('mutation($u:String!){abortLargeFileUpload(uploadId:$u)}', { u: other.id }, editor.token)).abortLargeFileUpload, true);
  data(await call('mutation($id:String!){deleteEntry(id:$id)}', { id: entry.id }, owner.token));
  assert.ok((await db.collection('large_files').findOne({ _id: record._id })).unreferencedSince, 'unreferenced file is marked for cleanup');

  console.log(JSON.stringify({ sizeMiB: Math.round(size / MiB), parts: upload.partCount, uploadSeconds, mibPerSecond: Math.round((size / MiB / uploadSeconds) * 10) / 10 }));
  console.log('Large file smoke passed');
} finally {
  const collections = await db.collection('collections').find({ ownerId: { $in: users } }).project({ _id: 1 }).toArray();
  const ids = collections.map((item) => String(item._id));
  await db.collection('entries').deleteMany({ collectionId: { $in: ids } });
  await db.collection('auditlogs').deleteMany({ collectionId: { $in: ids } });
  await db.collection('background_jobs').deleteMany({ collectionId: { $in: ids } });
  // Stored objects of this run are removed by the cleanup once unreferenced; mark them now.
  await db.collection('large_files').updateMany({ collectionId: { $in: ids } }, { $set: { unreferencedSince: new Date(0) } });
  await db.collection('collections').deleteMany({ _id: { $in: collections.map((item) => item._id) } });
  await db.collection('users').deleteMany({ _id: { $in: users.map((id) => new mongoose.Types.ObjectId(id)) } });
  await mongoose.disconnect();
}
