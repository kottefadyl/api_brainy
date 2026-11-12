// T52: collaborators by personal link, sharing restricted to collaborators, end of collaboration.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

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
  const auth = data(await call('mutation($i:RegisterInput!){register(input:$i){token user{id}}}', { i: { name, email: `collab-${randomUUID()}@example.test`, password: 'test-password-123' } })).register;
  users.push(auth.user.id);
  return auth;
};
const share = 'mutation($c:String!,$u:String,$r:CollectionRole!){addCollectionMember(collectionId:$c,memberUserId:$u,role:$r){id members{userId role}}}';
const list = 'query{collectionsList{id name sharedBy{userId name} members{userId}}}';
const create = (name, token) => call('mutation($i:CreateCollectionInput!){createCollection(input:$i){id formats{id version fields{id name}}}}', { i: { name, formats: [{ name: 'Notes', color: '#EEF5FF', fields: [{ name: 'Title', kind: 'TITLE' }] }] } }, token);

try {
  const awa = await register('Awa');
  const bruno = await register('Bruno');
  const chloe = await register('Chloé');

  const token = data(await call('query{collaborationInviteToken}', {}, awa.token)).collaborationInviteToken;
  assert.equal(data(await call('query{collaborationInviteToken}', {}, awa.token)).collaborationInviteToken, token, 'the personal link is stable');
  const preview = 'query($t:String!){collaborationInvite(token:$t){inviterName isSelf alreadyCollaborator}}';
  assert.deepEqual(data(await call(preview, { t: token })).collaborationInvite, { inviterName: 'Awa', isSelf: false, alreadyCollaborator: false }, 'readable without an account');
  assert.equal(data(await call(preview, { t: token }, awa.token)).collaborationInvite.isSelf, true);
  denied(await call('mutation($t:String!){acceptCollaboration(token:$t){userId}}', { t: token }, awa.token), /yourself/);
  denied(await call(preview, { t: 'not-a-real-token-123456' }), /no longer valid/);

  const house = data(await create('Maison', awa.token)).createCollection;
  denied(await call(share, { c: house.id, u: bruno.user.id, r: 'READER' }, awa.token), /collaborators/);

  const accepted = data(await call('mutation($t:String!){acceptCollaboration(token:$t){userId name since}}', { t: token }, bruno.token)).acceptCollaboration;
  assert.equal(accepted.userId, awa.user.id);
  data(await call('mutation($t:String!){acceptCollaboration(token:$t){userId}}', { t: token }, bruno.token));
  assert.deepEqual(data(await call('query{collaborators{userId name}}', {}, awa.token)).collaborators, [{ userId: bruno.user.id, name: 'Bruno' }]);
  assert.equal(data(await call(preview, { t: token }, bruno.token)).collaborationInvite.alreadyCollaborator, true);

  // Collaboration alone gives no access.
  assert.ok(!data(await call(list, {}, bruno.token)).collectionsList.some((item) => item.id === house.id));
  denied(await call(share, { c: house.id, u: bruno.user.id, r: 'OWNER' }, awa.token), /read only or read and write/);
  data(await call(share, { c: house.id, u: bruno.user.id, r: 'READER' }, awa.token));
  const seen = data(await call(list, {}, bruno.token)).collectionsList.find((item) => item.id === house.id);
  assert.deepEqual(seen.sharedBy, { userId: awa.user.id, name: 'Awa' });
  const dan = await register('Dan');
  const { collaborationInviteToken: awaLink } = data(await call('query{collaborationInviteToken}', {}, awa.token));
  data(await call('mutation($t:String!){acceptCollaboration(token:$t){userId}}', { t: awaLink }, dan.token));
  data(await call(share, { c: house.id, u: dan.user.id, r: 'READER' }, awa.token));
  assert.deepEqual(data(await call(list, {}, bruno.token)).collectionsList.find((item) => item.id === house.id).members, [{ userId: bruno.user.id }], 'a collaborator never sees the other members');
  assert.equal(data(await call(list, {}, awa.token)).collectionsList.find((item) => item.id === house.id).members.length, 2);
  assert.equal(data(await call(list, {}, awa.token)).collectionsList.find((item) => item.id === house.id).sharedBy, null);
  const format = house.formats[0];
  const entry = 'mutation($c:String!,$i:SaveEntryInput!){createEntry(collectionId:$c,input:$i){id}}';
  const values = { formatId: format.id, values: [{ fieldId: format.fields[0].id, value: 'Facture' }] };
  denied(await call(entry, { c: house.id, i: values }, bruno.token), /Read-only/);

  // Read and write: entries only.
  data(await call(share, { c: house.id, u: bruno.user.id, r: 'EDITOR' }, awa.token));
  const written = data(await call(entry, { c: house.id, i: values }, bruno.token)).createEntry.id;

  // T53: creator and last person who changed the entry.
  const authors = 'query($c:String!,$e:String!){collectionEntry(collectionId:$c,entryId:$e){createdBy{userId name hasPhoto} updatedBy{userId name}}}';
  let seenEntry = data(await call(authors, { c: house.id, e: written }, awa.token)).collectionEntry;
  assert.deepEqual([seenEntry.createdBy.name, seenEntry.updatedBy.name, seenEntry.createdBy.hasPhoto], ['Bruno', 'Bruno', false]);
  data(await call('mutation($id:String!,$i:SaveEntryInput!){updateEntry(id:$id,input:$i){id}}', { id: written, i: { formatId: format.id, values: [{ fieldId: format.fields[0].id, value: 'Facture payée' }] } }, awa.token));
  seenEntry = data(await call(authors, { c: house.id, e: written }, bruno.token)).collectionEntry;
  assert.deepEqual([seenEntry.createdBy.userId, seenEntry.updatedBy.userId], [bruno.user.id, awa.user.id]);
  await mongoose.connection.db.collection('entries').updateOne({ _id: new mongoose.Types.ObjectId(written) }, { $unset: { createdBy: '', updatedBy: '' } });
  seenEntry = data(await call(authors, { c: house.id, e: written }, bruno.token)).collectionEntry;
  assert.deepEqual([seenEntry.createdBy.userId, seenEntry.updatedBy.userId], [awa.user.id, awa.user.id], 'older entries belong to the owner');
  const photo = 'query($u:String!){personPhoto(userId:$u)}';
  data(await call('mutation($p:String){updateProfilePhoto(photo:$p){id}}', { p: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' }, awa.token));
  assert.match(data(await call(photo, { u: awa.user.id }, bruno.token)).personPhoto, /^data:image\/png/, 'a collaborator sees the photo');
  assert.equal(data(await call(photo, { u: awa.user.id }, chloe.token)).personPhoto, null, 'a stranger does not');
  assert.equal(data(await call(authors, { c: house.id, e: written }, bruno.token)).collectionEntry.createdBy.hasPhoto, true);
  data(await call('mutation($id:String!){deleteEntry(id:$id)}', { id: written }, bruno.token));
  // A collaborator in read and write edits and deletes an entry written by the owner (regression: reminders were looked up by the editor).
  const ownersEntry = data(await call(entry, { c: house.id, i: values }, awa.token)).createEntry.id;
  data(await call('mutation($id:String!,$i:SaveEntryInput!){updateEntry(id:$id,input:$i){id}}', { id: ownersEntry, i: { formatId: format.id, values: [{ fieldId: format.fields[0].id, value: 'Facture relue' }] } }, bruno.token));
  assert.equal(data(await call(authors, { c: house.id, e: ownersEntry }, awa.token)).collectionEntry.updatedBy.userId, bruno.user.id);
  data(await call('mutation($id:String!){deleteEntry(id:$id)}', { id: ownersEntry }, bruno.token));
  denied(await call('mutation($id:String!,$n:String!){renameCollection(id:$id,name:$n){id}}', { id: house.id, n: 'Renamed' }, bruno.token), /owner|Only/i);
  denied(await call('mutation($id:String!){deleteCollection(id:$id)}', { id: house.id }, bruno.token), /owner|Only|not found/i);
  denied(await call(share, { c: house.id, u: chloe.user.id, r: 'READER' }, bruno.token), /owner|Only/i);

  // Someone outside the collaboration sees nothing.
  assert.ok(!data(await call(list, {}, chloe.token)).collectionsList.some((item) => item.id === house.id));

  // Regenerating the link stops the old one; existing collaborations stay.
  const fresh = data(await call('mutation{regenerateCollaborationInvite}', {}, awa.token)).regenerateCollaborationInvite;
  assert.notEqual(fresh, token);
  denied(await call('mutation($t:String!){acceptCollaboration(token:$t){userId}}', { t: token }, chloe.token), /no longer valid/);
  assert.equal(data(await call('query{collaborators{userId}}', {}, bruno.token)).collaborators.length, 1);

  // Ending the collaboration removes every share, both ways.
  data(await call('mutation($t:String!){acceptCollaboration(token:$t){userId}}', { t: data(await call('query{collaborationInviteToken}', {}, bruno.token)).collaborationInviteToken }, awa.token));
  const garage = data(await create('Garage', bruno.token)).createCollection;
  data(await call(share, { c: garage.id, u: awa.user.id, r: 'READER' }, bruno.token));
  assert.ok(data(await call(list, {}, awa.token)).collectionsList.some((item) => item.id === garage.id));
  assert.equal(data(await call('mutation($u:String!){endCollaboration(userId:$u)}', { u: awa.user.id }, bruno.token)).endCollaboration, true);
  assert.ok(!data(await call(list, {}, awa.token)).collectionsList.some((item) => item.id === garage.id), 'share from Bruno removed');
  assert.ok(!data(await call(list, {}, bruno.token)).collectionsList.some((item) => item.id === house.id), 'share from Awa removed');
  assert.deepEqual(data(await call('query{collaborators{userId}}', {}, awa.token)).collaborators, [{ userId: dan.user.id }], 'only Bruno left');
  denied(await call(share, { c: house.id, u: bruno.user.id, r: 'READER' }, awa.token), /collaborators/);
  denied(await call('mutation($u:String!){endCollaboration(userId:$u)}', { u: awa.user.id }, bruno.token), /not found/);

  console.log('Collaborators smoke passed: link, preview, acceptance, read only, read and write, revocation, end of collaboration.');
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
