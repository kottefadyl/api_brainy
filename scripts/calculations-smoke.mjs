// Calculations and statistics: chosen per collection (template default or explicit), owner-only switch.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

const endpoint = `http://localhost:${process.env.PORT ?? 3000}/graphql`;
assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI for cleanup');
await mongoose.connect(process.env.MONGODB_URI);
const call = async (query, variables = {}, token) => (await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) })).json();
const data = (result) => { assert.equal(result.errors, undefined, JSON.stringify(result.errors)); return result.data; };
const users = [];
const register = async (name) => { const auth = data(await call('mutation($i:RegisterInput!){register(input:$i){token user{id}}}', { i: { name, email: `calc-${randomUUID()}@example.test`, password: 'test-password-123' } })).register; users.push(auth.user.id); return auth; };

try {
  const awa = await register('Awa');
  const bruno = await register('Bruno');
  const templates = data(await call('query{starterTemplates(language:"en"){id calculations}}')).starterTemplates;
  assert.deepEqual(templates.filter((item) => item.calculations).map((item) => item.id).sort(), ['expenses', 'fitness', 'kt_personal', 'shop']);
  const fromTemplate = (id, calculations) => call(`mutation($c:Boolean){createCollectionFromTemplate(templateId:"${id}",name:"T",language:"en",calculations:$c){id calculations}}`, { c: calculations }, awa.token).then((result) => data(result).createCollectionFromTemplate);
  assert.equal((await fromTemplate('expenses')).calculations, true, 'money templates start with calculations');
  assert.equal((await fromTemplate('notes')).calculations, false, 'simple templates start without');
  assert.equal((await fromTemplate('tasks', true)).calculations, true, 'the choice made at creation wins');
  assert.equal((await fromTemplate('expenses', false)).calculations, false);
  const manual = data(await call('mutation($i:CreateCollectionInput!){createCollection(input:$i){id calculations}}', { i: { name: 'Manual', formats: [{ name: 'Note', color: '#EEF5FF', fields: [{ name: 'Title', kind: 'TITLE' }] }] } }, awa.token)).createCollection;
  assert.equal(manual.calculations, false, 'a new collection starts simple');
  const toggle = 'mutation($id:String!,$on:Boolean!){setCollectionCalculations(collectionId:$id,enabled:$on){id calculations}}';
  assert.equal(data(await call(toggle, { id: manual.id, on: true }, awa.token)).setCollectionCalculations.calculations, true);
  assert.match((await call(toggle, { id: manual.id, on: false }, bruno.token)).errors[0].message, /not found/i, 'a stranger cannot change it');
  console.log('Calculations smoke passed: template defaults, choice at creation, owner switch.');
} finally {
  const db = mongoose.connection.db;
  await db.collection('collections').deleteMany({ ownerId: { $in: users } });
  await db.collection('users').deleteMany({ _id: { $in: users.map((id) => new mongoose.Types.ObjectId(id)) } });
  await mongoose.disconnect();
}
