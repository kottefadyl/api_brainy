// Vercel Hobby freeze: run against an API started with VERCEL=1 (for example
// PORT=3100 VERCEL=1 node --env-file=.env dist/main.js), then:
// API_URL=http://localhost:3100/graphql node --env-file=.env scripts/platform-freeze-smoke.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

const url = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 3000}/graphql`;
assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI for cleanup');
await mongoose.connect(process.env.MONGODB_URI);
const graphql = async (query, variables = {}, token) => (await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) })).json());
const data = (result) => { assert.equal(result.errors, undefined, JSON.stringify(result.errors)); return result.data; };
const paused = (result, what) => assert.match(result.errors?.[0]?.message ?? '', /paused on this hosting plan/, `${what} is frozen: ${JSON.stringify(result.errors ?? result.data)}`);
let userId;
try {
  const capabilities = data(await graphql('{platformCapabilities{frozenModules maxEntryAttachmentBytes}}')).platformCapabilities;
  assert.deepEqual([...capabilities.frozenModules].sort(), ['backgroundJobs', 'dataSources', 'largeFiles', 'reminders']);
  assert.equal(capabilities.maxEntryAttachmentBytes, 3 * 1024 * 1024);

  const account = data(await graphql('mutation($input:RegisterInput!){register(input:$input){token user{id}}}', { input: { name: 'Freeze', email: `freeze-${randomUUID()}@example.test`, password: 'test-password-123' } })).register;
  userId = account.user.id;
  const token = account.token;
  const collection = data(await graphql('mutation($input:CreateCollectionInput!){createCollection(input:$input){id formats{id fields{id name}}}}', { input: { name: 'Freeze', formats: [{ name: 'Notes', color: '#EEF5FF', fields: [{ name: 'Title', kind: 'TITLE' }, { name: 'When', kind: 'DATETIME' }, { name: 'A', kind: 'ATTACHMENT' }, { name: 'B', kind: 'ATTACHMENT' }] }] } }, token)).createCollection;
  const format = collection.formats[0];
  const field = Object.fromEntries(format.fields.map((item) => [item.name, item.id]));
  const add = 'mutation($id:String!,$input:SaveEntryInput!){createEntry(collectionId:$id,input:$input){id}}';
  const file = (size) => Buffer.alloc(size, 7).toString('base64');
  const tooMuch = await graphql(add, { id: collection.id, input: { formatId: format.id, values: [{ fieldId: field.Title, value: 'Two files' }, { fieldId: field.A, value: 'a.bin', attachmentBase64: file(2 * 1024 * 1024), attachmentMimeType: 'application/octet-stream' }, { fieldId: field.B, value: 'b.bin', attachmentBase64: file(1.5 * 1024 * 1024), attachmentMimeType: 'application/octet-stream' }] } }, token);
  assert.match(tooMuch.errors?.[0]?.message ?? '', /cannot exceed 3 MB/, 'attachments are limited to 3 MiB per entry');
  const entry = data(await graphql(add, { id: collection.id, input: { formatId: format.id, values: [{ fieldId: field.Title, value: 'One file' }, { fieldId: field.When, value: '2030-01-01T09:00:00.000Z' }, { fieldId: field.A, value: 'a.bin', attachmentBase64: file(2 * 1024 * 1024), attachmentMimeType: 'application/octet-stream' }] } }, token)).createEntry;

  paused(await graphql('mutation($e:String!,$i:EntryReminderInput!){saveEntryReminder(entryId:$e,input:$i){id}}', { e: entry.id, i: { fieldId: field.When, minutesBefore: 0, channels: ['EMAIL'], timeZone: 'UTC' } }, token), 'reminders');
  paused(await graphql('mutation{registerPushDevice(token:"x",platform:"WEB",label:"x"){id}}', {}, token), 'push devices');
  paused(await graphql('mutation($c:String!,$i:StartBackgroundJobInput!){startBackgroundJob(collectionId:$c,input:$i){id}}', { c: collection.id, i: { kind: 'RECALCULATE', requestKey: randomUUID(), payload: '{}' } }, token), 'background jobs');
  paused(await graphql('mutation($c:String!,$i:DataSourceInput!){createDataSource(collectionId:$c,input:$i){id}}', { c: collection.id, i: { name: 'Sensor', formatId: format.id, recordIdColumn: 'id', mappings: [] } }, token), 'data sources');
  paused(await graphql('mutation($c:String!,$i:StartLargeFileUploadInput!){startLargeFileUpload(collectionId:$c,input:$i){id}}', { c: collection.id, i: { fileName: 'big.bin', mimeType: 'application/octet-stream', size: 50 * 1024 * 1024 } }, token), 'large files');
  const reminders = data(await graphql('{reminderCapabilities{email push}}', {}, token)).reminderCapabilities;
  assert.deepEqual(reminders, { email: false, push: false }, 'no reminder channel is offered');
  console.log('Vercel freeze: capabilities, 3 MiB attachments, and refused reminders, push devices, background jobs, data sources and large files passed.');
} finally {
  if (userId) {
    const ids = (await mongoose.connection.collection('collections').find({ ownerId: userId }, { projection: { _id: 1 } }).toArray()).map((item) => item._id.toString());
    await mongoose.connection.collection('entries').deleteMany({ collectionId: { $in: ids } });
    await mongoose.connection.collection('collections').deleteMany({ ownerId: userId });
    await mongoose.connection.collection('users').deleteMany({ _id: new mongoose.Types.ObjectId(userId) });
  }
  await mongoose.disconnect();
}
