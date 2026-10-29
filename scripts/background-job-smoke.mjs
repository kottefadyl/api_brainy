import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

const endpoint = `http://localhost:${process.env.PORT ?? 3000}/graphql`;
assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI for cleanup');
await mongoose.connect(process.env.MONGODB_URI);
const userIds = [];
const collectionIds = [];

async function query(source, variables = {}, token) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query: source, variables }) });
  return response.json();
}
function data(result) { assert.equal(result.errors, undefined, JSON.stringify(result.errors)); return result.data; }
async function waitFor(jobId, token, states = ['COMPLETED']) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const job = data(await query('query($jobId:String!){backgroundJob(jobId:$jobId){id state total processed createdCount skippedCount errorCount logs{row message} result failure}}', { jobId }, token)).backgroundJob;
    if (states.includes(job.state)) return job;
    if (job.state === 'FAILED') assert.fail(`Task failed: ${job.failure}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail('Task did not finish in 30 seconds');
}

try {
  const register = async (name) => {
    const result = data(await query('mutation($input:RegisterInput!){register(input:$input){token user{id}}}', { input: { name, email: `t30-${randomUUID()}@example.test`, password: 'password-123' } })).register;
    userIds.push(result.user.id);
    return result;
  };
  const owner = await register('T30 Owner');
  const other = await register('T30 Other');
  const collection = data(await query('mutation($input:CreateCollectionInput!){createCollection(input:$input){id formats{id fields{id kind}}}}', { input: { name: 'T30 smoke', formats: [{ name: 'Rows', color: '#EEF5FF', fields: [{ name: 'Title', kind: 'TITLE' }] }] } }, owner.token)).createCollection;
  collectionIds.push(collection.id);
  const formatId = collection.formats[0].id;
  const fieldId = collection.formats[0].fields[0].id;
  const date = new Date().toISOString();
  const makeRows = (prefix, count) => Array.from({ length: count }, (_, index) => ({ sourceId: `${prefix}-${index}`, createdAt: date, updatedAt: date, values: [{ fieldId, value: `${prefix} ${index}` }] }));
  const payload = { formatId, rows: makeRows('first', 120) };
  payload.rows[60].createdAt = 'bad';
  const start = 'mutation($collectionId:String!,$input:StartBackgroundJobInput!){startBackgroundJob(collectionId:$collectionId,input:$input){id state total}}';
  const firstInput = { kind: 'IMPORT', requestKey: `first-${randomUUID()}`, payload: JSON.stringify(payload) };
  const first = data(await query(start, { collectionId: collection.id, input: firstInput }, owner.token)).startBackgroundJob;
  const firstDone = await waitFor(first.id, owner.token);
  assert.equal(firstDone.total, 120);
  assert.equal(firstDone.processed, 120);
  assert.equal(firstDone.createdCount, 119);
  assert.equal(firstDone.errorCount, 1);
  assert.equal(firstDone.logs[0].row, 61);
  const same = data(await query(start, { collectionId: collection.id, input: firstInput }, owner.token)).startBackgroundJob;
  assert.equal(same.id, first.id, 'Repeated request key returns the same task');
  const forbidden = await query('query($collectionId:String!){backgroundJobs(collectionId:$collectionId){id}}', { collectionId: collection.id }, other.token);
  assert.ok(forbidden.errors?.length, 'Another account cannot list tasks');

  const exportJob = data(await query(start, { collectionId: collection.id, input: { kind: 'EXPORT', requestKey: `export-${randomUUID()}`, payload: JSON.stringify({ formatId, limit: 200 }) } }, owner.token)).startBackgroundJob;
  const exported = await waitFor(exportJob.id, owner.token);
  assert.equal(JSON.parse(exported.result).rows.length, 119);

  for (const kind of ['RECALCULATE', 'CHART']) {
    const analysisJob = data(await query(start, { collectionId: collection.id, input: { kind, requestKey: `${kind.toLowerCase()}-${randomUUID()}`, payload: JSON.stringify({ formatId, operation: 'COUNT', groupBy: 'NONE', measureKind: 'EVENT' }) } }, owner.token)).startBackgroundJob;
    const completed = await waitFor(analysisJob.id, owner.token);
    assert.equal(JSON.parse(completed.result).rows[0].count, 119);
  }

  const science = data(await query('mutation($input:CreateCollectionInput!){createCollection(input:$input){id formats{id fields{id name}}}}', { input: { name: 'T30 forecast smoke', formats: [{ name: 'Measurements', color: '#EDF9F3', fields: [{ name: 'Value', kind: 'NUMBER' }, { name: 'Occurred at', kind: 'DATETIME' }] }] } }, owner.token)).createCollection;
  collectionIds.push(science.id);
  const measureFormat = science.formats[0];
  const numericField = measureFormat.fields.find((field) => field.name === 'Value').id;
  const dateField = measureFormat.fields.find((field) => field.name === 'Occurred at').id;
  for (let month = 1; month <= 8; month++) {
    data(await query('mutation($id:String!,$input:SaveEntryInput!){createEntry(collectionId:$id,input:$input){id}}', { id: science.id, input: { formatId: measureFormat.id, values: [{ fieldId: numericField, value: String(month * 2) }, { fieldId: dateField, value: `2026-${String(month).padStart(2, '0')}-15T12:00:00Z` }] } }, owner.token));
  }
  const forecastJob = data(await query(start, { collectionId: science.id, input: { kind: 'FORECAST', requestKey: `forecast-${randomUUID()}`, payload: JSON.stringify({ formatId: measureFormat.id, fieldId: numericField, dateFieldId: dateField, frequency: 'MONTH', method: 'LINEAR', measureKind: 'SNAPSHOT', horizon: 2, holdout: 2 }) } }, owner.token)).startBackgroundJob;
  const forecasted = await waitFor(forecastJob.id, owner.token);
  assert.equal(JSON.parse(forecasted.result).forecast[0].estimate, '18');

  const second = data(await query(start, { collectionId: collection.id, input: { kind: 'IMPORT', requestKey: `second-${randomUUID()}`, payload: JSON.stringify({ formatId, rows: makeRows('second', 1000) }) } }, owner.token)).startBackgroundJob;
  data(await query('mutation($jobId:String!){cancelBackgroundJob(jobId:$jobId){id state}}', { jobId: second.id }, owner.token));
  const cancelled = await waitFor(second.id, owner.token, ['CANCELLED', 'COMPLETED']);
  assert.equal(cancelled.state, 'CANCELLED', 'Large import can be cancelled');
  data(await query('mutation($jobId:String!){resumeBackgroundJob(jobId:$jobId){id state}}', { jobId: second.id }, owner.token));
  const resumed = await waitFor(second.id, owner.token);
  assert.equal(resumed.processed, 1000);
  await mongoose.connection.db.collection('background_jobs').updateOne(
    { _id: new mongoose.Types.ObjectId(second.id) },
    { $set: { state: 'RUNNING', processed: 500, createdCount: 500, skippedCount: 0, workerId: 'expired-worker', leaseUntil: new Date(Date.now() - 1000) }, $unset: { expiresAt: '' } },
  );
  const recovered = await waitFor(second.id, owner.token);
  assert.equal(recovered.skippedCount, 500, 'Expired lease replays the batch without duplicates');
  const entries = await mongoose.connection.db.collection('entries').countDocuments({ collectionId: collection.id });
  assert.equal(entries, 1119, 'Resumed import has no duplicates');
  console.log('T30 background job smoke passed');
} finally {
  const db = mongoose.connection.db;
  if (collectionIds.length) {
    await db.collection('background_jobs').deleteMany({ collectionId: { $in: collectionIds } });
    await db.collection('entries').deleteMany({ collectionId: { $in: collectionIds } });
    await db.collection('collections').deleteMany({ _id: { $in: collectionIds.map((id) => new mongoose.Types.ObjectId(id)) } });
  }
  if (userIds.length) await db.collection('users').deleteMany({ _id: { $in: userIds.map((id) => new mongoose.Types.ObjectId(id)) } });
  await mongoose.disconnect();
}
