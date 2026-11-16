// Editing the choices of a filled choice field: adding is free, an unused choice can be renamed or removed,
// a choice used by entries stays (and the refusal names the field and the choice).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

const endpoint = `http://localhost:${process.env.PORT ?? 3000}/graphql`;
assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI for cleanup');
await mongoose.connect(process.env.MONGODB_URI);
const call = async (query, variables = {}, token) => (await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) })).json();
const data = (result) => { assert.equal(result.errors, undefined, JSON.stringify(result.errors)); return result.data; };
let userId;

try {
  const auth = data(await call('mutation($i:RegisterInput!){register(input:$i){token user{id}}}', { i: { name: 'Choices', email: `choices-${randomUUID()}@example.test`, password: 'test-password-123' } })).register;
  userId = auth.user.id;
  const fields = 'id formats{id version fields{id name kind options}}';
  const created = data(await call(`mutation($i:CreateCollectionInput!){createCollection(input:$i){${fields}}}`, { i: { name: 'Money', formats: [{ name: 'Income', color: '#EEF5FF', fields: [{ name: 'Title', kind: 'TITLE' }, { name: 'Category', kind: 'MULTI_SELECT', options: ['Plumbing', 'IT side hustle', 'Gift'] }, { name: 'Kind', kind: 'SELECT', options: ['Cash', 'Bank'] }] }] } }, auth.token)).createCollection;
  const format = created.formats[0];
  const [title, category, kind] = format.fields;
  data(await call('mutation($c:String!,$i:SaveEntryInput!){createEntry(collectionId:$c,input:$i){id}}', { c: created.id, i: { formatId: format.id, values: [{ fieldId: title.id, value: 'Repair' }, { fieldId: category.id, value: JSON.stringify(['Plumbing']) }, { fieldId: kind.id, value: 'Cash' }] } }, auth.token));
  let version = format.version ?? 1;
  const update = (categoryOptions, kindOptions = ['Cash', 'Bank']) => call(`mutation($c:String!,$f:String!,$i:UpdateCollectionFormatInput!){updateCollectionFormat(collectionId:$c,formatId:$f,input:$i){${fields}}}`, { c: created.id, f: format.id, i: { name: 'Income', expectedVersion: version, fields: [{ id: title.id, name: 'Title', kind: 'TITLE' }, { id: category.id, name: 'Category', kind: 'MULTI_SELECT', options: categoryOptions }, { id: kind.id, name: 'Kind', kind: 'SELECT', options: kindOptions }] } }, auth.token);
  const saved = async (result) => { const formats = data(result).updateCollectionFormat.formats; version = formats[0].version; return formats[0].fields.find((field) => field.id === category.id).options; };

  assert.deepEqual(await saved(await update(['Plumbing', 'IT side hustle', 'Gift', 'Water selling'])), ['Plumbing', 'IT side hustle', 'Gift', 'Water selling'], 'adding a choice');
  assert.deepEqual(await saved(await update(['Plumbing', 'IT side hustling', 'Gift', 'Water selling'])), ['Plumbing', 'IT side hustling', 'Gift', 'Water selling'], 'renaming an unused choice');
  assert.deepEqual(await saved(await update(['Plumbing', 'IT side hustling', 'Water selling'])), ['Plumbing', 'IT side hustling', 'Water selling'], 'removing an unused choice');
  const refused = await update(['Plumbery', 'IT side hustling', 'Water selling']);
  assert.match(refused.errors?.[0]?.message ?? '', /^Field Category has saved values using the choice "Plumbing"\. Keep that choice/, 'a used choice stays');
  const single = await update(['Plumbing', 'IT side hustling'], ['Bank', 'Card']);
  assert.match(single.errors?.[0]?.message ?? '', /Field Kind has saved values using the choice "Cash"/, 'single choice fields too');
  console.log('Format choices smoke passed: add, rename and remove unused choices; used choices kept with a precise message.');
} finally {
  const db = mongoose.connection.db;
  if (userId) {
    const ids = (await db.collection('collections').find({ ownerId: userId }).project({ _id: 1 }).toArray()).map((item) => String(item._id));
    await db.collection('entries').deleteMany({ collectionId: { $in: ids } });
    await db.collection('collections').deleteMany({ ownerId: userId });
    await db.collection('users').deleteOne({ _id: new mongoose.Types.ObjectId(userId) });
  }
  await mongoose.disconnect();
}
