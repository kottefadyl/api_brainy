import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

const endpoint = `http://localhost:${process.env.PORT ?? 3000}/graphql`;
assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI for cleanup');
await mongoose.connect(process.env.MONGODB_URI);

const gql = async (source, variables = {}, token) => {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query: source, variables }) });
  return response.json();
};
const data = (result) => { assert.equal(result.errors, undefined, JSON.stringify(result.errors)); return result.data; };
const account = async () => {
  const email = `kt-personal-${randomUUID()}@example.test`;
  const { register } = data(await gql('mutation($input:RegisterInput!){register(input:$input){token user{id}}}', { input: { name: 'KT', email, password: 'test-password-123' } }));
  return { token: register.token, id: register.user.id };
};
const fromTemplate = `mutation($t:String!,$n:String!,$l:String){createCollectionFromTemplate(templateId:$t,name:$n,language:$l){id periodTotals{formatId dateFieldId amountFieldId} formats{id name fields{id name kind unit}}}}`;
const owners = [];

try {
  const owner = await account(); owners.push(owner.id);
  const stranger = await account(); owners.push(stranger.id);

  for (const language of ['fr', 'en']) {
    const { starterTemplates } = data(await gql('query($l:String){starterTemplates(language:$l){id name description}}', { l: language }));
    const template = starterTemplates.find((item) => item.id === 'kt_personal');
    assert.equal(template?.name, 'KT personal');
    assert.ok(template.description.length > 20);
  }

  const shop = data(await gql(fromTemplate, { t: 'kt_personal', n: 'KT', l: 'fr' }, owner.token)).createCollectionFromTemplate;
  assert.equal(shop.formats.length, 1, 'one data format');
  const format = shop.formats[0];
  assert.deepEqual(format.fields.map((field) => field.kind), ['DATE', 'NUMBER'], 'only a date and an amount');
  assert.equal(format.fields[1].unit, 'FCFA', 'amounts are in FCFA');
  const { collectionAvailableUnits } = data(await gql('query($id:String!){collectionAvailableUnits(collectionId:$id){id symbol dimension}}', { id: shop.id }, owner.token));
  assert.deepEqual(collectionAvailableUnits.find((unit) => unit.id === 'FCFA'), { id: 'FCFA', symbol: 'FCFA', dimension: 'CURRENCY' }, 'FCFA is a listed currency');
  assert.deepEqual(shop.periodTotals, { formatId: format.id, dateFieldId: format.fields[0].id, amountFieldId: format.fields[1].id });

  const other = data(await gql(fromTemplate, { t: 'expenses', n: 'Autre', l: 'fr' }, owner.token)).createCollectionFromTemplate;
  assert.equal(other.periodTotals, null, 'the panel belongs to this template only');

  const add = (date, amount) => gql('mutation($id:String!,$input:SaveEntryInput!){createEntry(collectionId:$id,input:$input){id}}', { id: shop.id, input: { formatId: format.id, values: [{ fieldId: format.fields[0].id, value: date }, { fieldId: format.fields[1].id, value: amount }] } }, owner.token);
  // Mon 2 Nov to Sun 8 Nov 2026 is the week under test; the entries sit on each boundary.
  for (const [date, amount] of [['2026-11-01', '100'], ['2026-11-02', '1500.50'], ['2026-11-08', '2000'], ['2026-11-09', '40'], ['2026-11-30', '5'], ['2026-12-01', '7'], ['2026-01-01', '11'], ['2025-12-31', '13']]) data(await add(date, amount));

  const total = async (from, to, token = owner.token) => gql('query($id:String!,$input:AnalysisInput!){analyseCollection(collectionId:$id,input:$input){unit rows{value count}}}', { id: shop.id, input: { formatId: format.id, fieldId: format.fields[1].id, dateFieldId: format.fields[0].id, groupBy: 'NONE', operation: 'SUM', measureKind: 'EVENT', from, to } }, token);
  const sum = async (from, to) => data(await total(from, to)).analyseCollection.rows[0]?.value;
  assert.equal(await sum('2026-11-02', '2026-11-08'), '3500.5', 'week, both bounds included');
  assert.equal(await sum('2026-11-01', '2026-11-30'), '3645.5', 'month, both bounds included');
  assert.equal(await sum('2026-01-01', '2026-12-31'), '3663.5', 'year, both bounds included');
  assert.equal(data(await total('2026-11-01', '2026-11-30')).analyseCollection.unit, 'FCFA', 'the total keeps its currency');
  assert.equal(await sum('2030-01-01', '2030-01-31'), undefined, 'an empty period returns no row');
  assert.ok((await total('2026-11-01', '2026-11-30', stranger.token)).errors, 'another account cannot read the totals');
  console.log('KT personal smoke passed');
} finally {
  const collections = await mongoose.connection.db.collection('collections').find({ ownerId: { $in: owners } }).toArray();
  const ids = collections.map((item) => String(item._id));
  await mongoose.connection.db.collection('entries').deleteMany({ collectionId: { $in: ids } });
  await mongoose.connection.db.collection('collections').deleteMany({ ownerId: { $in: owners } });
  await mongoose.connection.db.collection('users').deleteMany({ _id: { $in: owners.map((id) => new mongoose.Types.ObjectId(id)) } });
  await mongoose.disconnect();
}
