import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { collaborate } from './collaborate-helper.mjs';

const url = `http://localhost:${process.env.PORT ?? 3000}/graphql`;
assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI for cleanup');
await mongoose.connect(process.env.MONGODB_URI);
const email = (prefix) => `${prefix}-${randomUUID()}@example.test`;
const graphql = async (query, variables = {}, token) => (await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) })).json());
const data = (result) => { assert.equal(result.errors, undefined, JSON.stringify(result.errors)); return result.data; };
const owners = [];
try {
  const register = 'mutation($input:RegisterInput!){register(input:$input){token user{id}}}';
  const owner = data(await graphql(register, { input: { name: 'Privacy owner', email: email('privacy-owner'), password: 'test-password-123' } })).register;
  const memberEmail = email('privacy-member');
  const member = data(await graphql(register, { input: { name: 'Privacy member', email: memberEmail, password: 'test-password-123' } })).register;
  owners.push(owner.user.id, member.user.id);
  await collaborate(owner.token, member.token);
  const create = 'mutation($input:CreateCollectionInput!){createCollection(input:$input){id minAggregateSize formats{id version sensitivity fields{id name sensitivity}}}}';
  const setLevel = 'mutation($collectionId:String!,$formatId:String!,$fieldId:String!,$level:SensitivityLevel!,$expectedVersion:Int!){setFieldSensitivity(collectionId:$collectionId,formatId:$formatId,fieldId:$fieldId,level:$level,expectedVersion:$expectedVersion){formats{id version fields{id sensitivity}}}}';
  const add = 'mutation($id:String!,$input:SaveEntryInput!){createEntry(collectionId:$id,input:$input){id}}';
  const grant = 'mutation($collectionId:String!,$email:String!,$role:CollectionRole!,$sharedFieldIds:[String!],$sensitiveFieldIds:[String!]){addCollectionMember(collectionId:$collectionId,email:$email,role:$role,sharedFieldIds:$sharedFieldIds,sensitiveFieldIds:$sensitiveFieldIds){id members{email sensitiveFieldIds}}}';
  const entryQuery = 'query($collectionId:String!,$entryId:String!){collectionEntry(collectionId:$collectionId,entryId:$entryId){values{fieldId value}}}';
  const pharmacy = data(await graphql(create, { input: { name: 'R7 pharmacy', formats: [{ name: 'Lots', color: '#EEF5FF', fields: [{ name: 'Product', kind: 'TITLE' }, { name: 'Lot', kind: 'TEXT' }, { name: 'Expiry', kind: 'DATE' }, { name: 'Patient note', kind: 'LONG_TEXT' }] }] } }, owner.token)).createCollection;
  const pharmacyFormat = pharmacy.formats[0];
  const patientField = pharmacyFormat.fields.find((field) => field.name === 'Patient note');
  assert.ok(patientField);
  data(await graphql(setLevel, { collectionId: pharmacy.id, formatId: pharmacyFormat.id, fieldId: patientField.id, level: 'SENSITIVE', expectedVersion: pharmacyFormat.version }, owner.token));
  const pharmacyFields = Object.fromEntries(pharmacyFormat.fields.map((field) => [field.name, field.id]));
  const pharmacyEntry = data(await graphql(add, { id: pharmacy.id, input: { formatId: pharmacyFormat.id, values: [{ fieldId: pharmacyFields.Product, value: 'Medicine' }, { fieldId: pharmacyFields.Lot, value: 'A-17' }, { fieldId: pharmacyFields.Expiry, value: '2027-01-31' }, { fieldId: patientField.id, value: 'private patient note' }] } }, owner.token)).createEntry.id;
  const collection = data(await graphql(create, { input: { name: 'R8 fieldwork', formats: [{ name: 'Observations', color: '#EEF5FF', fields: [{ name: 'Title', kind: 'TITLE' }, { name: 'Amount', kind: 'NUMBER' }, { name: 'Diagnosis', kind: 'TEXT' }, { name: 'Position', kind: 'POSITION' }] }] } }, owner.token)).createCollection;
  const format = collection.formats[0];
  const fields = Object.fromEntries(format.fields.map((field) => [field.name, field.id]));
  const marked = data(await graphql(setLevel, { collectionId: collection.id, formatId: format.id, fieldId: fields.Diagnosis, level: 'SENSITIVE', expectedVersion: format.version }, owner.token)).setFieldSensitivity;
  assert.equal(marked.formats[0].fields.find((field) => field.id === fields.Diagnosis).sensitivity, 'SENSITIVE');
  assert.equal(format.fields.find((field) => field.id === fields.Position).sensitivity, 'SENSITIVE', 'positions default to sensitive');
  const entries = [];
  for (let i = 0; i < 3; i++) entries.push(data(await graphql(add, { id: collection.id, input: { formatId: format.id, values: [{ fieldId: fields.Title, value: `Sample ${i}` }, { fieldId: fields.Amount, value: String(10 + i) }, { fieldId: fields.Diagnosis, value: `secret-${i}` }, { fieldId: fields.Position, value: JSON.stringify({ latitude: 6.5244 + i / 100, longitude: 3.3792 }) }] } }, owner.token)).createEntry.id);
  data(await graphql(grant, { collectionId: pharmacy.id, email: memberEmail, role: 'READER' }, owner.token));
  const pharmacyRead = data(await graphql(entryQuery, { collectionId: pharmacy.id, entryId: pharmacyEntry }, member.token)).collectionEntry;
  assert.equal(pharmacyRead.values.some((value) => value.fieldId === patientField.id), false, 'R7 patient data is hidden from members by default');
  data(await graphql(grant, { collectionId: collection.id, email: memberEmail, role: 'READER' }, owner.token));
  const read = (token) => graphql(entryQuery, { collectionId: collection.id, entryId: entries[0] }, token);
  const hidden = data(await read(member.token)).collectionEntry.values;
  assert.equal(hidden.some((value) => [fields.Diagnosis, fields.Position].includes(value.fieldId)), false, 'R8 sensitive fields are hidden from members by default');
  assert.equal(data(await read(owner.token)).collectionEntry.values.some((value) => value.fieldId === fields.Diagnosis), true);
  data(await graphql(grant, { collectionId: collection.id, email: memberEmail, role: 'READER', sensitiveFieldIds: [fields.Diagnosis, fields.Position] }, owner.token));
  const approved = data(await read(member.token)).collectionEntry.values;
  assert.equal(approved.some((value) => value.fieldId === fields.Diagnosis), true, 'explicit grant reveals sensitive values');
  assert.equal(approved.some((value) => value.fieldId === fields.Position), true, 'explicit grant reveals position values');
  const exportGeo = 'query($collectionId:String!,$formatId:String!,$fieldId:String!,$kind:String!,$includeSensitive:Boolean){exportGeoPoints(collectionId:$collectionId,formatId:$formatId,fieldId:$fieldId,kind:$kind,includeSensitive:$includeSensitive)}';
  const geoVariables = { collectionId: collection.id, formatId: format.id, fieldId: fields.Position, kind: 'GEOJSON' };
  assert.ok((await graphql(exportGeo, geoVariables, owner.token)).errors?.length, 'R8 position export requires explicit inclusion');
  assert.ok(data(await graphql(exportGeo, { ...geoVariables, includeSensitive: true }, owner.token)).exportGeoPoints.length > 10);
  const analyse = 'query($collectionId:String!,$input:AnalysisInput!){analyseCollection(collectionId:$collectionId,input:$input){rows{count value sources{entryId}} explanation}}';
  const analysisInput = { formatId: format.id, fieldId: fields.Amount, operation: 'SUM', groupBy: 'NONE', measureKind: 'EVENT' };
  assert.ok((await graphql(analyse, { collectionId: collection.id, input: analysisInput }, owner.token)).errors?.length, 'under-threshold aggregate must be rejected by server');
  const minimum = 'mutation($collectionId:String!,$minimum:Int!){setMinimumAggregateSize(collectionId:$collectionId,minimum:$minimum){minAggregateSize}}';
  assert.equal(data(await graphql(minimum, { collectionId: collection.id, minimum: 3 }, owner.token)).setMinimumAggregateSize.minAggregateSize, 3);
  const safe = data(await graphql(analyse, { collectionId: collection.id, input: analysisInput }, owner.token)).analyseCollection;
  assert.equal(safe.rows[0].count, 3);
  assert.deepEqual(safe.rows[0].sources, []);
  assert.match(safe.explanation, /not anonymization/i);
  assert.ok((await graphql(analyse, { collectionId: collection.id, input: { ...analysisInput, search: 'Sample 0' } }, owner.token)).errors?.length, 'filtered complement/differencing query is refused');
  assert.ok((await graphql(analyse, { collectionId: collection.id, input: { ...analysisInput, comparisonFrom: '2026-01-01' } }, owner.token)).errors?.length, 'comparison is refused');
  // T43/3: repeated targeting patterns are recorded, without values.
  const watched = async (action) => mongoose.connection.collection('auditlogs').find({ collectionId: collection.id, action }).toArray();
  const served = await watched('READ_SENSITIVE_AGGREGATE');
  assert.ok(served.length >= 1 && served.every((item) => /^[0-9a-f]{16}$/.test(item.queryKey) && item.observationCount === 3), 'served aggregates carry a query fingerprint and their size');
  assert.ok((await watched('REFUSED_SENSITIVE_AGGREGATE')).length >= 3, 'refused sensitive queries are recorded');
  data(await graphql(add, { id: collection.id, input: { formatId: format.id, values: [{ fieldId: fields.Title, value: 'Sample 3' }, { fieldId: fields.Amount, value: '99' }, { fieldId: fields.Diagnosis, value: 'secret-3' }] } }, owner.token));
  assert.equal(data(await graphql(analyse, { collectionId: collection.id, input: analysisInput }, owner.token)).analyseCollection.rows[0].count, 4, 'the aggregate is still served');
  const alerts = async () => (await watched('SENSITIVE_AGGREGATE_ALERT')).map((item) => item.details);
  assert.ok((await alerts()).some((detail) => detail.startsWith('DIFFERENCING')), 'a total differing by one entry raises a differencing alert');
  for (let i = 0; i < 3; i++) assert.ok((await graphql(analyse, { collectionId: collection.id, input: { ...analysisInput, search: `probe ${i}` } }, owner.token)).errors?.length);
  assert.ok((await alerts()).some((detail) => detail.startsWith('PROBING')), 'repeated refusals raise a probing alert');
  for (let i = 0; i < 8; i++) data(await graphql(analyse, { collectionId: collection.id, input: analysisInput }, owner.token));
  const finalAlerts = await alerts();
  assert.ok(finalAlerts.some((detail) => detail.startsWith('BURST')), 'the same question asked ten times in an hour raises a burst alert');
  // T43/1: k-anonymity rule. Small groups are widened before anything is refused.
  const clinic = data(await graphql(create, { input: { name: 'R9 clinic', formats: [{ name: 'Visits', color: '#EEF5FF', fields: [{ name: 'Title', kind: 'TITLE' }, { name: 'Amount', kind: 'NUMBER' }, { name: 'Ward', kind: 'SELECT', options: ['North', 'South', 'East', 'West'] }, { name: 'When', kind: 'DATE' }, { name: 'Diagnosis', kind: 'TEXT' }] }] } }, owner.token)).createCollection;
  const visits = clinic.formats[0];
  const visit = Object.fromEntries(visits.fields.map((field) => [field.name, field.id]));
  data(await graphql(setLevel, { collectionId: clinic.id, formatId: visits.id, fieldId: visit.Diagnosis, level: 'SENSITIVE', expectedVersion: visits.version }, owner.token));
  data(await graphql(minimum, { collectionId: clinic.id, minimum: 3 }, owner.token));
  const clinicRows = [['North', '10', '2026-03-01'], ['North', '20', '2026-03-01'], ['North', '30', '2026-03-02'], ['North', '40', '2026-03-02'], ['South', '50', '2026-03-03'], ['South', '60', '2026-03-04'], ['East', '70', '2026-04-10'], ['West', '80', '2026-04-11']];
  for (const [ward, amount, when] of clinicRows) data(await graphql(add, { id: clinic.id, input: { formatId: visits.id, values: [{ fieldId: visit.Title, value: `${ward} ${amount}` }, { fieldId: visit.Amount, value: amount }, { fieldId: visit.Ward, value: ward }, { fieldId: visit.When, value: when }, { fieldId: visit.Diagnosis, value: 'private' }] } }, owner.token));
  const widened = 'query($collectionId:String!,$input:AnalysisInput!){analyseCollection(collectionId:$collectionId,input:$input){groupBy rows{group label value count sources{entryId}} explanation}}';
  const byWard = { formatId: visits.id, fieldId: visit.Amount, operation: 'COUNT', groupBy: 'CATEGORY', groupFieldId: visit.Ward, measureKind: 'EVENT', language: 'en' };
  const merged = data(await graphql(widened, { collectionId: clinic.id, input: byWard }, owner.token)).analyseCollection;
  assert.deepEqual(merged.rows.map((row) => [row.label, row.count, row.value]), [['North', 4, '4'], ['Other (3 groups merged)', 4, '4']], 'three small wards become one group of four');
  assert.ok(merged.rows.every((row) => row.sources.length === 0) && /3 small groups merged/.test(merged.explanation), merged.explanation);
  const average = data(await graphql(widened, { collectionId: clinic.id, input: { ...byWard, operation: 'AVERAGE', language: 'fr' } }, owner.token)).analyseCollection;
  assert.deepEqual(average.rows.map((row) => [row.label, row.value]), [['North', '25'], ['Autres (3 groupes regroupés)', '65']], 'the merged average weighs each group by its count');
  const byDay = { ...byWard, operation: 'SUM', groupBy: 'DAY', dateFieldId: visit.When, groupFieldId: undefined };
  const total = data(await graphql(widened, { collectionId: clinic.id, input: byDay }, owner.token)).analyseCollection;
  assert.equal(total.groupBy, 'NONE', 'days with one visit widen to months, then to one total');
  assert.deepEqual(total.rows.map((row) => [row.count, row.value]), [[8, '360']]);
  assert.match(total.explanation, /days → months; months → one total/);
  data(await graphql(minimum, { collectionId: clinic.id, minimum: 9 }, owner.token));
  assert.ok((await graphql(widened, { collectionId: clinic.id, input: byDay }, owner.token)).errors?.length, 'a total under the threshold is still refused');
  assert.equal(finalAlerts.filter((detail) => detail.startsWith('DIFFERENCING')).length, 1, 'one alert of a kind per hour');
  const backup = 'query($includeSensitive:Boolean){workspaceBackup(includeSensitive:$includeSensitive)}';
  assert.ok((await graphql(backup, {}, owner.token)).errors?.length, 'backup requires explicit inclusion');
  assert.ok(data(await graphql(backup, { includeSensitive: true }, owner.token)).workspaceBackup.length > 100);
  const audit = await mongoose.connection.collection('auditlogs').find({ collectionId: { $in: [pharmacy.id, collection.id] } }).toArray();
  const actions = new Set(audit.map((item) => item.action));
  for (const action of ['READ_PROTECTED_DATA', 'SHARE_PROTECTED_FIELDS', 'READ_SENSITIVE_AGGREGATE', 'EXPORT_PROTECTED_DATA']) {
    assert.ok(actions.has(action), `audit records ${action}`);
  }
  assert.equal(JSON.stringify(audit).includes('private patient note'), false, 'audit does not copy protected values');
  assert.equal(JSON.stringify(audit).includes('secret-0'), false, 'audit does not copy protected values');
  console.log('T43 R7/R8/R9: member masking, explicit position grant, server threshold, k-anonymity widening, source stripping, differencing refusals, repeated-query alerts, geo export and backup choice passed.');
} finally {
  try {
    for (const userId of owners) {
      const ids = (await mongoose.connection.collection('collections').find({ ownerId: userId }, { projection: { _id: 1 } }).toArray()).map((item) => item._id.toString());
      await mongoose.connection.collection('entries').deleteMany({ collectionId: { $in: ids } });
      await mongoose.connection.collection('auditlogs').deleteMany({ collectionId: { $in: ids } });
      await mongoose.connection.collection('collections').deleteMany({ ownerId: userId });
      await mongoose.connection.collection('users').deleteMany({ _id: new mongoose.Types.ObjectId(userId) });
    }
  } finally { await mongoose.disconnect(); }
}
