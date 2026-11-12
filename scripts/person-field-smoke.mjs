// T54: collaborator field. People are chosen among the collection owner and the owner's collaborators.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { collaborate } from './collaborate-helper.mjs';

const endpoint = `http://localhost:${process.env.PORT ?? 3000}/graphql`;
assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI for cleanup');
await mongoose.connect(process.env.MONGODB_URI);

const call = async (query, variables = {}, token) => (await fetch(endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ query, variables }),
})).json();
const data = (result) => { assert.equal(result.errors, undefined, JSON.stringify(result.errors)); return result.data; };
const denied = (result, pattern) => { assert.ok(result.errors?.length, JSON.stringify(result)); assert.match(result.errors[0].message, pattern); };

const users = [];
const register = async (name) => {
  const auth = data(await call('mutation($i:RegisterInput!){register(input:$i){token user{id}}}', { i: { name, email: `people-${randomUUID()}@example.test`, password: 'test-password-123' } })).register;
  users.push(auth.user.id);
  return auth;
};
const people = 'query($c:ID!){collectionPeople(collectionId:$c){userId name hasPhoto}}';
const valueFields = 'id values{fieldId value personIds personNames}';
const create = `mutation($c:String!,$i:SaveEntryInput!){createEntry(collectionId:$c,input:$i){${valueFields}}}`;
const update = `mutation($id:String!,$i:SaveEntryInput!){updateEntry(id:$id,input:$i){${valueFields}}}`;
const share = 'mutation($c:String!,$u:String,$r:CollectionRole!){addCollectionMember(collectionId:$c,memberUserId:$u,role:$r){id}}';

try {
  const kevin = await register('Kevin');
  const ivan = await register('Ivan');
  const julien = await register('Julien');
  const zoe = await register('Zoé');
  await collaborate(kevin.token, ivan.token, julien.token);

  const project = data(await call('mutation($i:CreateCollectionInput!){createCollection(input:$i){id formats{id fields{id name kind}}}}', { i: { name: 'Projet', formats: [{ name: 'Tâche', color: '#EEF5FF', fields: [
    { name: 'Intitulé', kind: 'TITLE' }, { name: 'Date', kind: 'DATE' }, { name: 'Avancement', kind: 'NUMBER', unit: '%' }, { name: 'Durée', kind: 'DURATION' }, { name: 'Effectuée par', kind: 'COLLABORATOR' },
  ] }] } }, kevin.token)).createCollection;
  const [format] = project.formats;
  const title = format.fields[0].id;
  const doneBy = format.fields.find((field) => field.kind === 'COLLABORATOR').id;

  // The owner first, then the owner's collaborators; never someone else.
  const list = data(await call(people, { c: project.id }, kevin.token)).collectionPeople;
  assert.deepEqual(list.map((person) => person.name), ['Kevin', 'Ivan', 'Julien']);
  denied(await call(people, { c: project.id }, zoe.token), /not found/);

  const task = (ids) => ({ formatId: format.id, values: [{ fieldId: title, value: 'Rapport' }, { fieldId: doneBy, value: JSON.stringify(ids) }] });
  const entry = data(await call(create, { c: project.id, i: task([kevin.user.id, ivan.user.id, julien.user.id]) }, kevin.token)).createEntry;
  const saved = entry.values.find((value) => value.fieldId === doneBy);
  assert.equal(saved.value, 'Kevin, Ivan, Julien', 'the readable value names the people');
  assert.deepEqual(saved.personIds, [kevin.user.id, ivan.user.id, julien.user.id]);
  assert.deepEqual(saved.personNames, ['Kevin', 'Ivan', 'Julien']);

  denied(await call(create, { c: project.id, i: task([zoe.user.id]) }, kevin.token), /owner or their collaborators/);
  denied(await call(create, { c: project.id, i: task([ivan.user.id, ivan.user.id]) }, kevin.token), /needs collaborators/);
  denied(await call(create, { c: project.id, i: task([]) }, kevin.token), /needs collaborators/);
  denied(await call(create, { c: project.id, i: { formatId: format.id, values: [{ fieldId: doneBy, value: 'Ivan' }] } }, kevin.token), /needs collaborators/);

  // A client resending the stored names unchanged keeps the same people (tableur, task boxes…).
  const resent = data(await call(update, { id: entry.id, i: { formatId: format.id, values: [{ fieldId: title, value: 'Rapport final' }, { fieldId: doneBy, value: 'Kevin, Ivan, Julien' }] } }, kevin.token)).updateEntry;
  assert.deepEqual(resent.values.find((value) => value.fieldId === doneBy).personIds, [kevin.user.id, ivan.user.id, julien.user.id]);

  // A collaborator with write access picks among the owner's collaborators too.
  data(await call(share, { c: project.id, u: ivan.user.id, r: 'EDITOR' }, kevin.token));
  assert.deepEqual(data(await call(people, { c: project.id }, ivan.token)).collectionPeople.map((person) => person.name), ['Kevin', 'Ivan', 'Julien']);
  const byIvan = data(await call(create, { c: project.id, i: task([julien.user.id]) }, ivan.token)).createEntry;
  assert.equal(byIvan.values.find((value) => value.fieldId === doneBy).value, 'Julien');

  // Analyses by person: an entry counts for each person it names (Rapport final: Kevin, Ivan, Julien; byIvan: Julien).
  const progress = format.fields.find((field) => field.kind === 'NUMBER').id;
  await call(update, { id: byIvan.id, i: { formatId: format.id, values: [{ fieldId: title, value: 'Relecture' }, { fieldId: progress, value: '40' }, { fieldId: doneBy, value: 'Julien' }] } }, kevin.token);
  const analysis = data(await call('query($id:String!,$input:AnalysisInput!){analyseCollection(collectionId:$id,input:$input){rows{group label value count}}}', { id: project.id, input: { formatId: format.id, operation: 'COUNT', measureKind: 'EVENT', groupBy: 'PERSON', groupFieldId: doneBy, language: 'fr' } }, kevin.token)).analyseCollection.rows;
  assert.deepEqual(Object.fromEntries(analysis.map((row) => [row.label, row.count])), { Kevin: 1, Ivan: 1, Julien: 2 });
  denied(await call('query($id:String!,$input:AnalysisInput!){analyseCollection(collectionId:$id,input:$input){rows{group}}}', { id: project.id, input: { formatId: format.id, operation: 'COUNT', measureKind: 'EVENT', groupBy: 'PERSON', groupFieldId: title } }, kevin.token), /compatible group field/);

  // After the collaboration with Julien ends, saved entries keep him; new choices cannot name him.
  data(await call('mutation($u:String!){endCollaboration(userId:$u)}', { u: julien.user.id }, kevin.token));
  const kept = data(await call(update, { id: entry.id, i: { formatId: format.id, values: [{ fieldId: title, value: 'Rapport final' }, { fieldId: doneBy, value: JSON.stringify([ivan.user.id, julien.user.id]) }] } }, kevin.token)).updateEntry;
  assert.equal(kept.values.find((value) => value.fieldId === doneBy).value, 'Ivan, Julien');
  denied(await call(create, { c: project.id, i: task([julien.user.id]) }, kevin.token), /owner or their collaborators/);
  console.log('Person field smoke passed');
} finally {
  const db = mongoose.connection.db;
  const collections = await db.collection('collections').find({ ownerId: { $in: users } }).project({ _id: 1 }).toArray();
  const ids = collections.map((item) => String(item._id));
  await db.collection('entries').deleteMany({ collectionId: { $in: ids } });
  await db.collection('auditlogs').deleteMany({ collectionId: { $in: ids } });
  await db.collection('collections').deleteMany({ ownerId: { $in: users } });
  await db.collection('collaborations').deleteMany({ userIds: { $in: users } });
  await db.collection('collaboratorinvites').deleteMany({ userId: { $in: users } });
  await db.collection('users').deleteMany({ _id: { $in: users.map((id) => new mongoose.Types.ObjectId(id)) } });
  await mongoose.disconnect();
}
