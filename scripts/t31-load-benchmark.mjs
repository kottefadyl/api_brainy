import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import mongoose from 'mongoose';

const endpoint = `http://localhost:${process.env.PORT ?? 3000}/graphql`;
const levels = (process.env.T31_LEVELS ?? '1000,100000,1000000').split(',').map(Number);
const focused = process.env.T31_FOCUS === '1';
const stateFile = new URL('../.t31-benchmark-state.json', import.meta.url);
assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI');
assert.ok(levels.every((value) => Number.isInteger(value) && value >= 1000 && value <= 1_000_000));
await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;

async function cleanup(state) {
  if (!state) return;
  console.log(JSON.stringify({ phase: 'cleanup', collectionId: state.collectionId }));
  if (state.collectionId) {
    await db.collection('entries').deleteMany({ collectionId: state.collectionId });
    await db.collection('background_jobs').deleteMany({ collectionId: state.collectionId });
    await db.collection('collections').deleteMany({ _id: new mongoose.Types.ObjectId(state.collectionId) });
  }
  if (state.userId) await db.collection('users').deleteMany({ _id: new mongoose.Types.ObjectId(state.userId) });
  await rm(stateFile, { force: true });
}

if (process.argv.includes('--cleanup')) {
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  await cleanup(state);
  await mongoose.disconnect();
  process.exit(0);
}

let state;
try { state = JSON.parse(await readFile(stateFile, 'utf8')); } catch { /* no prior benchmark */ }
assert.equal(state, undefined, 'A prior benchmark needs cleanup: run with --cleanup');

async function graphql(source, variables = {}, token) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query: source, variables }) });
  return response.json();
}
function data(result) { assert.equal(result.errors, undefined, JSON.stringify(result.errors)); return result.data; }
function p95(values) { const sorted = [...values].sort((a, b) => a - b); return Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1] * 10) / 10; }
async function timed(run, samples, allowError = false) {
  const values = [];
  let error;
  for (let index = 0; index < samples; index++) {
    const start = performance.now();
    const response = await run(index);
    values.push(performance.now() - start);
    if (response.errors?.length) { error = response.errors[0].message; if (!allowError) assert.fail(error); }
  }
  return { p95Ms: p95(values), minMs: Math.round(Math.min(...values) * 10) / 10, maxMs: Math.round(Math.max(...values) * 10) / 10, samples, ...(error ? { error } : {}) };
}

// The API runs in the same container: its resident memory shows what a large analysis costs.
async function apiHeapHint() {
  const { readdir } = await import('node:fs/promises');
  let biggest = 0;
  for (const pid of (await readdir('/proc')).filter((item) => /^\d+$/.test(item))) {
    const status = await readFile(`/proc/${pid}/status`, 'utf8').catch(() => '');
    biggest = Math.max(biggest, Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0));
  }
  return `${Math.round(biggest / 1024)} MiB`;
}

const startDate = Date.parse('2024-01-01T00:00:00.000Z');
const runId = randomUUID();
let token;
try {
  const registration = data(await graphql('mutation($input:RegisterInput!){register(input:$input){token user{id}}}', { input: { name: 'T31 Benchmark', email: `t31-${runId}@example.test`, password: 'password-123' } })).register;
  token = registration.token;
  state = { userId: registration.user.id };
  await writeFile(stateFile, JSON.stringify(state));
  const collection = data(await graphql('mutation($input:CreateCollectionInput!){createCollection(input:$input){id formats{id version fields{id name kind}}}}', { input: { name: `T31 benchmark ${runId}`, formats: [{ name: 'Measurements', color: '#EEF5FF', fields: [{ name: 'Title', kind: 'TITLE' }, { name: 'Value', kind: 'NUMBER' }, { name: 'Occurred at', kind: 'DATETIME' }] }] } }, token)).createCollection;
  state.collectionId = collection.id;
  await writeFile(stateFile, JSON.stringify(state));
  const format = collection.formats[0];
  const field = Object.fromEntries(format.fields.map((item) => [item.name, item.id]));
  const insertRows = async (from, to) => {
    const started = performance.now();
    for (let first = from; first < to; first += 5000) {
      const batch = [];
      for (let index = first; index < Math.min(first + 5000, to); index++) {
        const createdAt = new Date(startDate + index * 1000);
        const period = index % (focused ? 120 : 12);
        const month = period % 12 + 1;
        const year = focused ? 2020 + Math.floor(period / 12) : 2026;
        batch.push({ ownerId: state.userId, collectionId: state.collectionId, formatId: format.id, formatVersion: 1, values: [
          { fieldId: field.Title, value: index % 1000 === 0 ? `needle ${index}` : `sample ${index}` },
          { fieldId: field.Value, value: String(month * 2) },
          { fieldId: field['Occurred at'], value: `${year}-${String(month).padStart(2, '0')}-15T12:00:00Z` },
        ], createdAt, updatedAt: createdAt });
      }
      await db.collection('entries').insertMany(batch, { ordered: false });
      if ((first + batch.length) % 100_000 === 0) console.log(JSON.stringify({ phase: 'seed', entries: first + batch.length }));
    }
    return Math.round(performance.now() - started);
  };
  const pageQuery = 'query($id:String!,$after:String,$search:String){collectionEntriesPage(collectionId:$id,first:30,after:$after,search:$search){entries{id} nextCursor hasMore}}';
  const impactQuery = 'query($id:String!,$formatId:String!){collectionFormatImpact(collectionId:$id,formatId:$formatId){entryCount populatedFieldIds}}';
  const analysisQuery = 'query($id:String!,$input:AnalysisInput!){analyseCollection(collectionId:$id,input:$input){rows{group value count}}}';
  const forecastQuery = 'query($id:String!,$input:ForecastInput!){forecastCollection(collectionId:$id,input:$input){forecast{date estimate}}}';
  const writeQuery = 'mutation($id:String!,$input:SaveEntryInput!){createEntry(collectionId:$id,input:$input){id}}';
  const migrationQuery = 'mutation($id:String!,$formatId:String!,$input:UpdateCollectionFormatInput!){updateCollectionFormat(collectionId:$id,formatId:$formatId,input:$input){formats{id version}}}';
  let version = format.version ?? 1;
  for (const target of levels) {
    const before = await db.collection('entries').countDocuments({ ownerId: state.userId, collectionId: state.collectionId });
    const seededMs = await insertRows(before, target);
    const count = await db.collection('entries').countDocuments({ ownerId: state.userId, collectionId: state.collectionId });
    assert.equal(count, target);
    const midpoint = await db.collection('entries').findOne({ ownerId: state.userId, collectionId: state.collectionId, createdAt: new Date(startDate + Math.floor(target / 2) * 1000) });
    assert.ok(midpoint);
    const after = Buffer.from(JSON.stringify({ createdAt: midpoint.createdAt.toISOString(), id: midpoint._id.toString() })).toString('base64url');
    const vars = { id: state.collectionId };
    const result = { entries: target, seededMs, consultation: await timed(() => graphql(pageQuery, vars, token), 20), deepPage: await timed(() => graphql(pageQuery, { ...vars, after }, token), 20), search: await timed(() => graphql(pageQuery, { ...vars, search: 'needle' }, token), 20), migrationPreview: await timed(() => graphql(impactQuery, { ...vars, formatId: format.id }, token), 5) };
    const range = focused ? { from: '2026-01-01', to: '2026-11-30' } : {};
    // T22: stored fields are aggregated by MongoDB, so no volume may be refused any more.
    result.aggregation = await timed(() => graphql(analysisQuery, { ...vars, input: { formatId: format.id, fieldId: field.Value, dateFieldId: field['Occurred at'], operation: 'SUM', groupBy: 'MONTH', measureKind: 'EVENT', ...range } }, token), focused || target <= 100_000 ? 5 : 1);
    result.statistics = {};
    for (const operation of ['COUNT', 'AVERAGE', 'STDDEV', 'MEDIAN', 'PERCENTILE_95', 'MODE']) {
      result.statistics[operation] = await timed(() => graphql(analysisQuery, { ...vars, input: { formatId: format.id, fieldId: field.Value, dateFieldId: field['Occurred at'], operation, groupBy: 'MONTH', measureKind: 'SNAPSHOT', ...range } }, token), focused || target <= 100_000 ? 3 : 1);
    }
    result.sampleDeviation = await timed(() => graphql(analysisQuery, { ...vars, input: { formatId: format.id, fieldId: field.Value, dateFieldId: field['Occurred at'], operation: 'STDDEV_SAMPLE', groupBy: 'MONTH', measureKind: 'SNAPSHOT', ...range } }, token), 1);
    // A formula the database cannot translate, read entry by entry through a cursor.
    const dynamicFormula = data(await graphql('mutation($id:String!,$input:FormulaInput!){saveCollectionFormula(collectionId:$id,input:$input){formulas{id name}}}', { ...vars, input: { name: `Rounded ${target}`, formatId: format.id, expression: JSON.stringify({ kind: 'round', digits: 2, mode: 'HALF_UP', value: { kind: 'field', fieldId: field.Value } }) } }, token)).saveCollectionFormula.formulas.find((item) => item.name === `Rounded ${target}`).id;
    const memoryBefore = await apiHeapHint();
    result.streamedFormula = await timed(() => graphql(analysisQuery, { ...vars, input: { formatId: format.id, formulaId: dynamicFormula, dateFieldId: field['Occurred at'], operation: 'SUM', groupBy: 'MONTH', measureKind: 'EVENT', ...range } }, token), 1);
    result.streamedMedian = await timed(() => graphql(analysisQuery, { ...vars, input: { formatId: format.id, formulaId: dynamicFormula, dateFieldId: field['Occurred at'], operation: 'MEDIAN', groupBy: 'MONTH', measureKind: 'SNAPSHOT', ...range } }, token), 1);
    result.orderedSeries = await timed(() => graphql(analysisQuery, { ...vars, input: { formatId: format.id, fieldId: field.Value, dateFieldId: field['Occurred at'], operation: 'CUMULATIVE', groupBy: 'MONTH', measureKind: 'EVENT', ...range } }, token), 1);
    result.apiMemory = { before: memoryBefore, after: await apiHeapHint() };
    result.forecast = await timed(() => graphql(forecastQuery, { ...vars, input: { formatId: format.id, fieldId: field.Value, dateFieldId: field['Occurred at'], frequency: 'MONTH', method: 'LINEAR', measureKind: 'SNAPSHOT', horizon: 2, holdout: 2, ...range } }, token), focused || target <= 100_000 ? 5 : 1, !focused);
    result.write = await timed((index) => graphql(writeQuery, { ...vars, input: { formatId: format.id, values: [{ fieldId: field.Title, value: `write-${randomUUID()}` }, { fieldId: field.Value, value: String(index + 1) }, { fieldId: field['Occurred at'], value: '2026-12-15T12:00:00Z' }] } }, token), 20);
    const migrationTimes = [];
    for (let index = 0; index < 5; index++) {
      const started = performance.now();
      const updated = data(await graphql(migrationQuery, { ...vars, formatId: format.id, input: { name: `Measurements ${target}-${index}`, expectedVersion: version, fields: format.fields.map((item) => ({ id: item.id, name: item.name, kind: item.kind })) } }, token)).updateCollectionFormat;
      version = updated.formats.find((item) => item.id === format.id).version;
      migrationTimes.push(performance.now() - started);
    }
    result.migration = { p95Ms: p95(migrationTimes), samples: 5 };
    const stats = await db.command({ collStats: 'entries', scale: 1 });
    result.mongo = { dataSizeBytes: stats.size, storageSizeBytes: stats.storageSize, totalIndexBytes: stats.totalIndexSize };
    console.log(JSON.stringify({ phase: 'result', ...result }));
  }
} finally {
  await cleanup(state);
  await mongoose.disconnect();
}
