// T47/3: book roles for data formats added by the owner.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

const endpoint = `http://localhost:${process.env.PORT ?? 3000}/graphql`;
assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI for cleanup');
await mongoose.connect(process.env.MONGODB_URI);
const call = async (query, variables = {}, token) => (await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) })).json();
const data = (result) => { assert.equal(result.errors, undefined, JSON.stringify(result.errors)); return result.data; };
const denied = (result, pattern) => { assert.ok(result.errors?.length, JSON.stringify(result)); assert.match(result.errors[0].message, pattern); };
const palette = ['#EEF5FF', '#EDF9F3', '#FFF5EB', '#F4F0FF', '#FFF0F4', '#EAF8FA', '#FBF7E9', '#F1F8ED', '#F8F0FA', '#F1F5FA', '#FFF7F1', '#EFF8FF', '#FDEFF7', '#EDF7FF', '#F7FBEA', '#FFF0E8', '#EFEFFD', '#E9F8F4', '#FBF1E8', '#F0F8F9', '#FFF2EF', '#F4F8E8', '#F1F2FF', '#EFFAF0'];
const users = [];
const setRole = 'mutation($c:String!,$f:String!,$r:String){setBookFormatRole(collectionId:$c,formatId:$f,role:$r){bookView{roles{formatId role}}}}';
try {
  const { token, user } = data(await call('mutation($i:RegisterInput!){register(input:$i){token user{id}}}', { i: { name: 'Lou', email: `book-roles-${randomUUID()}@example.test`, password: 'test-password-123' } })).register;
  users.push(user.id);
  const book = data(await call('mutation{createCollectionFromTemplate(templateId:"book",name:"Roman",language:"fr"){id formats{color}}}', {}, token)).createCollectionFromTemplate;
  const color = palette.find((item) => !book.formats.some((format) => format.color.toUpperCase() === item));
  const added = data(await call('mutation($id:String!,$input:CollectionFormatInput!){addCollectionFormat(collectionId:$id,input:$input){formats{id name}}}', { id: book.id, input: { name: 'Interlude', color, fields: [{ name: 'Titre', kind: 'TITLE' }, { name: 'Texte', kind: 'LONG_TEXT' }] } }, token)).addCollectionFormat;
  const interlude = added.formats.find((format) => format.name === 'Interlude').id;
  const before = data(await call('query{collectionsList{id bookView{roles{formatId}}}}', {}, token)).collectionsList.find((item) => item.id === book.id).bookView.roles.length;
  let roles = data(await call(setRole, { c: book.id, f: interlude, r: 'CHAPTER' }, token)).setBookFormatRole.bookView.roles;
  assert.equal(roles.length, before + 1);
  assert.deepEqual(roles.find((item) => item.formatId === interlude), { formatId: interlude, role: 'CHAPTER' });
  roles = data(await call(setRole, { c: book.id, f: interlude, r: 'SECTION' }, token)).setBookFormatRole.bookView.roles;
  assert.equal(roles.filter((item) => item.formatId === interlude).length, 1, 'one role per data format');
  roles = data(await call(setRole, { c: book.id, f: interlude, r: null }, token)).setBookFormatRole.bookView.roles;
  assert.equal(roles.length, before);
  denied(await call(setRole, { c: book.id, f: interlude, r: 'COVER' }, token), /Choose a part/);
  const notes = data(await call('mutation($i:CreateCollectionInput!){createCollection(input:$i){id formats{id}}}', { i: { name: 'Notes', formats: [{ name: 'Note', color: '#EEF5FF', fields: [{ name: 'Titre', kind: 'TITLE' }] }] } }, token)).createCollection;
  denied(await call(setRole, { c: notes.id, f: notes.formats[0].id, r: 'CHAPTER' }, token), /Book template/);
  console.log('Book roles smoke passed');
} finally {
  const db = mongoose.connection.db;
  const ids = (await db.collection('collections').find({ ownerId: { $in: users } }).project({ _id: 1 }).toArray()).map((item) => String(item._id));
  await db.collection('entries').deleteMany({ collectionId: { $in: ids } });
  await db.collection('auditlogs').deleteMany({ collectionId: { $in: ids } });
  await db.collection('collections').deleteMany({ ownerId: { $in: users } });
  await db.collection('users').deleteMany({ _id: { $in: users.map((id) => new mongoose.Types.ObjectId(id)) } });
  await mongoose.disconnect();
}
