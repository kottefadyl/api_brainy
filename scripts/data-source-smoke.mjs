// T32 smoke: data sources (connectors). Run: docker compose exec -T api node scripts/data-source-smoke.mjs
// Volume measurement: add -e DATA_SOURCE_ROWS=100000 (deliveries of 10 000 rows).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import mongoose from 'mongoose';

const endpoint = `http://localhost:${process.env.PORT ?? 3000}/graphql`;
assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI for cleanup');
await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
const users = [];

const call = async (query, variables = {}, token) => {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
  return response.json();
};
const data = (result) => { assert.equal(result.errors, undefined, JSON.stringify(result.errors)); return result.data; };
const fails = (result, pattern) => { assert.ok(result.errors?.length, 'Expected an error'); assert.match(result.errors[0].message, pattern); };
const register = async (name) => {
  const email = `ds-${randomUUID()}@example.test`;
  const auth = { ...data(await call('mutation($input:RegisterInput!){register(input:$input){token user{id}}}', { input: { name, email, password: 'test-password-123' } })).register, email };
  users.push(auth.user.id);
  return auth;
};
const RUN = 'id state total processed createdCount updatedCount unchangedCount olderCount rejectedCount ignoredColumns failure durationMs rowsPerSecond maxLagSeconds receivedAt';
const wait = async (runId, token, done = ['COMPLETED', 'FAILED', 'CANCELLED']) => {
  let run;
  for (let attempt = 0; attempt < 2400; attempt += 1) {
    run = data(await call(`query($id:String!){dataSourceRun(runId:$id){${RUN} rejections{row recordId code message cells}}}`, { id: runId }, token)).dataSourceRun;
    if (done.includes(run.state)) return run;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Delivery did not finish: ${run?.state} ${run?.processed}/${run?.total} in ${run?.durationMs} ms`);
};
const upload = (token, sourceId, deliveryId, content, contentType = 'text/csv') => call(`mutation($s:String!,$d:String!,$c:String!,$t:String!){uploadDataSourceDelivery(sourceId:$s,deliveryId:$d,content:$c,contentType:$t){${RUN}}}`, { s: sourceId, d: deliveryId, c: content, t: contentType }, token);
const push = (key, deliveryId, content, contentType = 'text/csv') => call(`mutation($k:String!,$d:String!,$c:String!,$t:String!){pushDataSourceDelivery(key:$k,deliveryId:$d,content:$c,contentType:$t){${RUN}}}`, { k: key, d: deliveryId, c: content, t: contentType });

try {
  const owner = await register('Source Owner');
  const editor = await register('Source Editor');
  const stranger = await register('Stranger');

  const collection = data(await call(`mutation($input:CreateCollectionInput!){createCollection(input:$input){id formats{id fields{id name kind}}}}`, { input: { name: 'Capteurs T32', formats: [
    { name: 'Relevé', color: '#EEF5FF', fields: [
      { name: 'Capteur', kind: 'TITLE' },
      { name: 'Température', kind: 'MEASURE', unit: '°C' },
      { name: 'Compteur', kind: 'NUMBER' },
      { name: 'Actif', kind: 'BOOLEAN' },
      { name: 'Note', kind: 'TEXT' },
    ] },
    { name: 'Pièce', color: '#EDF9F3', fields: [{ name: 'Pièce jointe', kind: 'ATTACHMENT' }] },
  ] } }, owner.token)).createCollection;
  const format = collection.formats[0];
  const field = Object.fromEntries(format.fields.map((item) => [item.name, item.id]));
  data(await call('mutation($c:String!,$e:String!,$r:CollectionRole!){addCollectionMember(collectionId:$c,email:$e,role:$r){id}}', { c: collection.id, e: editor.email, r: 'EDITOR' }, owner.token));

  const input = {
    name: 'Station nord', formatId: format.id, recordIdColumn: 'id', observedAtColumn: 'at', qualityColumn: 'q', decimalSeparator: 'COMMA', delimiter: ';', updatePolicy: 'UPDATE',
    mappings: [{ column: 'capteur', fieldId: field['Capteur'] }, { column: 'temp', fieldId: field['Température'], unitColumn: 'unite' }, { column: 'n', fieldId: field['Compteur'] }, { column: 'actif', fieldId: field['Actif'] }],
  };
  const SOURCE = 'mutation($c:String!,$i:DataSourceInput!){createDataSource(collectionId:$c,input:$i){id name keyHint mappings{column fieldId unitColumn}}}';

  // Rights and format rules.
  fails(await call(SOURCE, { c: collection.id, i: input }, editor.token), /owner/i);
  fails(await call(SOURCE, { c: collection.id, i: input }, stranger.token), /not found|denied/i);
  fails(await call(SOURCE, { c: collection.id, i: { ...input, formatId: collection.formats[1].id, mappings: [{ column: 'f', fieldId: collection.formats[1].fields[0].id }] } }, owner.token), /cannot be filled/);
  const source = data(await call(SOURCE, { c: collection.id, i: input }, owner.token)).createDataSource;
  assert.equal(source.keyHint, null);

  // 1. First delivery: creations, explained rejections, ignored column, decimal comma, units.
  const first = [
    'id;capteur;temp;unite;n;actif;at;q;extra',
    'S1;Capteur 1;21,5;°C;3;oui;2026-11-01T08:00:00Z;A;x',
    'S2;Capteur 2;19,0;°C;1;non;2026-11-01T08:00:00Z;B;x',
    ';Sans id;20;°C;1;oui;2026-11-01T08:00:00Z;A;x',
    'S3;Capteur 3;70;°F;1;oui;2026-11-01T08:00:00Z;A;x',
    'S4;Capteur 4;abc;°C;1;oui;2026-11-01T08:00:00Z;A;x',
    'S5;Capteur 5;20;°C;1;oui;hier;A;x',
    'S1;Doublon;22;°C;1;oui;2026-11-01T08:00:00Z;A;x',
    'S6;Capteur 6;1.5;°C;1;oui;2026-11-01T08:00:00Z;A;x',
  ].join('\n');
  fails(await upload(stranger.token, source.id, 'd1', first), /not found|denied/i);
  const run1 = await wait(data(await upload(editor.token, source.id, 'd1', first)).uploadDataSourceDelivery.id, editor.token);
  assert.equal(run1.state, 'COMPLETED', run1.failure);
  assert.deepEqual([run1.total, run1.createdCount, run1.rejectedCount], [8, 2, 6]);
  assert.deepEqual(run1.ignoredColumns, ['extra']);
  assert.deepEqual(run1.rejections.map((item) => item.code), ['MISSING_RECORD_ID', 'UNIT_MISMATCH', 'INVALID_VALUE', 'INVALID_OBSERVED_AT', 'DUPLICATE_IN_DELIVERY', 'INVALID_VALUE']);
  assert.equal(run1.rejections[1].recordId, 'S3');
  assert.match(run1.rejections[1].message, /°F/);
  assert.ok(run1.maxLagSeconds >= 0 && run1.rowsPerSecond > 0);
  const stored = await db.collection('entries').findOne({ collectionId: collection.id, sourceId: 'S1' });
  const temp = stored.values.find((value) => value.fieldId === field['Température']);
  assert.equal(temp.value, '21.5');
  assert.equal(temp.measureValue.quality, 'A');
  assert.equal(new Date(temp.measureValue.observedAt).toISOString(), '2026-11-01T08:00:00.000Z');
  assert.equal(stored.values.find((value) => value.fieldId === field['Actif']).value, 'true');
  assert.equal(stored.sourceObservedAt.toISOString(), '2026-11-01T08:00:00.000Z');
  assert.ok(stored.sourceReceivedAt > stored.sourceObservedAt, 'fact date is distinct from reception');
  assert.equal(stored.dataSourceId, source.id);

  // 2. Same delivery ID: idempotent; different content refused; missing column rejects the whole delivery.
  assert.equal(data(await upload(editor.token, source.id, 'd1', first)).uploadDataSourceDelivery.id, run1.id);
  fails(await upload(editor.token, source.id, 'd1', `${first}\nS9;x;1;°C;1;oui;2026-11-01;A;x`), /different content/);
  fails(await upload(editor.token, source.id, 'd-bad', 'id;capteur\nS1;x'), /MISSING_COLUMN/);

  // 3. Push key: rotate, push JSON, frequent update, unchanged and out-of-order versions.
  const { key } = data(await call('mutation($s:String!){rotateDataSourceKey(sourceId:$s){key source{keyHint}}}', { s: source.id }, owner.token)).rotateDataSourceKey;
  fails(await call('mutation($s:String!){rotateDataSourceKey(sourceId:$s){key}}', { s: source.id }, editor.token), /owner/i);
  const update = [
    { id: 'S1', capteur: 'Capteur 1', temp: '23,0', unite: '°C', n: 4, actif: 'oui', at: '2026-11-01T09:00:00Z', q: 'A' },
    { id: 'S2', capteur: 'Capteur 2', temp: '19,0', unite: '°C', n: 1, actif: 'non', at: '2026-11-01T08:00:00Z', q: 'B' },
  ];
  const run2 = await wait(data(await push(key, 'p1', JSON.stringify(update), 'application/json')).pushDataSourceDelivery.id, owner.token);
  assert.deepEqual([run2.createdCount, run2.updatedCount, run2.unchangedCount, run2.rejectedCount], [0, 1, 1, 0], JSON.stringify(run2));
  const late = [{ id: 'S1', capteur: 'Capteur 1', temp: '18,0', unite: '°C', n: 2, actif: 'oui', at: '2026-11-01T07:00:00Z', q: 'A' }];
  const run3 = await wait(data(await push(key, 'p2', JSON.stringify(late), 'application/json')).pushDataSourceDelivery.id, owner.token);
  assert.equal(run3.olderCount, 1);
  const updated = await db.collection('entries').findOne({ collectionId: collection.id, sourceId: 'S1' });
  assert.equal(updated.values.find((value) => value.fieldId === field['Température']).value, '23.0');
  assert.equal(updated.revisions.length, 1, 'previous version kept in history');
  assert.equal(await db.collection('entries').countDocuments({ collectionId: collection.id }), 2, 'no duplicate');

  // 4. Repair: retry rejected rows as stored, download them, fix and re-send.
  const repaired = data(await call('mutation($r:String!){retryDataSourceRejections(runId:$r){id state total}}', { r: run1.id }, editor.token)).retryDataSourceRejections;
  assert.equal(repaired.total, 6);
  const csv = data(await call('query($r:String!){dataSourceRejectionsCsv(runId:$r)}', { r: run1.id }, editor.token)).dataSourceRejectionsCsv;
  assert.match(csv.split('\n')[0], /^row;code;message;id;capteur/);
  await wait(repaired.id, editor.token);
  const fixed = csv.split('\n').slice(1).map((line) => line.split(';').slice(3).join(';')).map((line) => line.replace('°F', '°C').replace(';abc;', ';20;').replace(';hier;', ';2026-11-01;').replace(';1.5;', ';1,5;').replace(/^;Sans id/, 'S7;Sans id').replace(/^S1;Doublon/, 'S8;Doublon'));
  const run4 = await wait(data(await upload(editor.token, source.id, 'd1-fixed', ['id;capteur;temp;unite;n;actif;at;q;extra', ...fixed].join('\n'))).uploadDataSourceDelivery.id, editor.token);
  assert.deepEqual([run4.createdCount, run4.rejectedCount], [6, 0], JSON.stringify(run4.rejections));

  // 5. Evolving data format: removing a mapped field fails the run with MAPPING_STALE, explained.
  await db.collection('collections').updateOne({ _id: new mongoose.Types.ObjectId(collection.id), 'formats.id': format.id }, { $pull: { 'formats.$.fields': { id: field['Compteur'] } } });
  const run5 = await wait(data(await push(key, 'p3', JSON.stringify(update), 'application/json')).pushDataSourceDelivery.id, owner.token);
  assert.equal(run5.state, 'FAILED');
  assert.match(run5.failure, /MAPPING_STALE.*n/);
  data(await call('mutation($s:String!,$i:DataSourceInput!){updateDataSource(sourceId:$s,input:$i){id}}', { s: source.id, i: { ...input, mappings: input.mappings.filter((item) => item.column !== 'n') } }, owner.token));
  data(await call('mutation($r:String!){resumeDataSourceRun(runId:$r){id}}', { r: run5.id }, owner.token));
  const run5b = await wait(run5.id, owner.token);
  assert.equal(run5b.state, 'COMPLETED', run5b.failure);

  // 5b. Interruption: cancel between batches, resume, and no record is duplicated.
  const big = ['id;capteur;temp;unite;actif;at;q', ...Array.from({ length: 3000 }, (_, index) => `C${index};Capteur ${index};20;°C;oui;2026-11-01T10:00:00Z;A`)].join('\n');
  const queued = data(await upload(owner.token, source.id, 'cancel-1', big)).uploadDataSourceDelivery;
  data(await call('mutation($r:String!){cancelDataSourceRun(runId:$r){id}}', { r: queued.id }, owner.token));
  const stopped = await wait(queued.id, owner.token);
  if (stopped.state === 'CANCELLED') {
    assert.ok(stopped.processed < 3000, 'cancelled between batches');
    data(await call('mutation($r:String!){resumeDataSourceRun(runId:$r){id}}', { r: queued.id }, owner.token));
  }
  const resumed = await wait(queued.id, owner.token);
  assert.equal(resumed.state, 'COMPLETED', resumed.failure);
  assert.equal(resumed.processed, 3000);
  assert.equal(await db.collection('entries').countDocuments({ collectionId: collection.id, sourceId: /^C\d+$/ }), 3000, 'resume is duplicate-free');

  // 6. Revoked key no longer works; audit trail records deliveries.
  data(await call('mutation($s:String!){revokeDataSourceKey(sourceId:$s){id keyHint}}', { s: source.id }, owner.token));
  fails(await push(key, 'p4', JSON.stringify(update), 'application/json'), /unavailable/);
  assert.ok(await db.collection('auditlogs').countDocuments({ collectionId: collection.id, action: 'DATA_SOURCE_DELIVERY' }) >= 5, 'deliveries are audited');

  // 7. Optional volume measurement.
  const volume = Number(process.env.DATA_SOURCE_ROWS ?? 0);
  if (volume > 0) {
    const started = Date.now();
    let processing = 0;
    for (let offset = 0; offset < volume; offset += 10_000) {
      const lines = ['id;capteur;temp;unite;n;actif;at;q'];
      for (let index = offset; index < Math.min(volume, offset + 10_000); index += 1) lines.push(`V${index};Capteur ${index};${String((index % 400) / 10).replace(".", ",")};°C;${index};oui;2026-11-01T10:00:00Z;A`);
      const run = await wait(data(await upload(owner.token, source.id, `vol-${offset}`, lines.join('\n'))).uploadDataSourceDelivery.id, owner.token);
      assert.equal(run.state, 'COMPLETED', run.failure);
      assert.equal(run.rejectedCount, 0);
      processing += run.durationMs;
    }
    const elapsed = (Date.now() - started) / 1000;
    console.log(JSON.stringify({ rows: volume, wallSeconds: elapsed, rowsPerSecondWall: Math.round(volume / elapsed), workerSeconds: processing / 1000, cpus: os.cpus().length, cpu: os.cpus()[0]?.model, memoryGiB: Math.round(os.totalmem() / 2 ** 30) }));
    assert.equal(await db.collection('entries').countDocuments({ collectionId: collection.id, dataSourceId: source.id, sourceId: /^V/ }), volume);
  }

  console.log('Data source smoke passed');
} finally {
  const collections = await db.collection('collections').find({ ownerId: { $in: users } }).project({ _id: 1 }).toArray();
  const ids = collections.map((item) => String(item._id));
  await db.collection('entries').deleteMany({ collectionId: { $in: ids } });
  await db.collection('auditlogs').deleteMany({ collectionId: { $in: ids } });
  await db.collection('data_source_runs').deleteMany({ collectionId: { $in: ids } });
  await db.collection('data_sources').deleteMany({ collectionId: { $in: ids } });
  await db.collection('collections').deleteMany({ _id: { $in: collections.map((item) => item._id) } });
  await db.collection('users').deleteMany({ _id: { $in: users.map((id) => new mongoose.Types.ObjectId(id)) } });
  await mongoose.disconnect();
}
