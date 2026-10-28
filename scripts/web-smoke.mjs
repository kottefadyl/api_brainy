import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

const webUrl = process.env.WEB_URL ?? 'http://localhost:3001';
const userIds = [];
const collectionIds = [];
let cookie = '';
assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI to run and clean up web smoke data');
await mongoose.connect(process.env.MONGODB_URI);

async function graphql(query, variables = {}) {
  const response = await fetch(`${webUrl}/api/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  const nextCookie = response.headers.get('set-cookie');
  if (nextCookie?.startsWith('brainy_session=')) cookie = nextCookie.split(';')[0];
  return response.json();
}

function data(result) {
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  return result.data;
}

try {
  const registered = await graphql('mutation($input: RegisterInput!) { register(input: $input) { token user { id name email profileCompleted } } }', {
    input: { name: 'Web Tester', email: `web-${randomUUID().slice(0, 8)}@example.test`, password: 'test-password-123' },
  });
  const user = data(registered).register.user;
  userIds.push(user.id);
  assert.equal(registered.data.register.token, undefined, 'session token must not reach browser JavaScript');
  assert.ok(cookie.startsWith('brainy_session='), 'registration must set a session cookie');
  assert.equal(user.profileCompleted, false);
  const profile = data(await graphql(
    'mutation($input: ProfileInput!) { updateProfile(input: $input) { id name profession job fieldOfStudy interests hobbies profileCompleted } }',
    { input: { name: 'Web Tester', profession: 'Designer', job: 'Product designer', fieldOfStudy: 'Art', interests: ['Design', 'Books'], hobbies: ['Drawing'] } },
  )).updateProfile;
  assert.equal(profile.profileCompleted, true);
  assert.deepEqual(profile.interests, ['Design', 'Books']);
  assert.equal(data(await graphql('query { me { profileCompleted profession } }')).me.profession, 'Designer');
  assert.equal(data(await graphql('query { me { id } }')).me.id, user.id);

  const collection = data(await graphql(
    'mutation($input: CreateCollectionInput!) { createCollection(input: $input) { id name formats { id name color fields { id name kind unit } } } }',
    { input: { name: 'Web notes', formats: [{ name: 'Journal', color: '#EEF5FF', fields: [{ name: 'Title', kind: 'TITLE' }, { name: 'Distance', kind: 'NUMBER', unit: 'km' }, { name: 'Details', kind: 'TEXT' }] }] } },
  )).createCollection;
  collectionIds.push(collection.id);
  const journal = collection.formats[0];
  assert.equal(journal.fields[1].unit, 'km');

  const extended = data(await graphql(
    'mutation($id: String!, $input: CollectionFormatInput!) { addCollectionFormat(collectionId: $id, input: $input) { formats { id name color fields { id } } } }',
    { id: collection.id, input: { name: 'Reference', color: '#EDF9F3', fields: [{ name: 'Link', kind: 'LINK' }] } },
  )).addCollectionFormat;
  assert.equal(extended.formats.length, 2);
  assert.notEqual(extended.formats[0].color, extended.formats[1].color);

  const values = [
    { fieldId: journal.fields[0].id, value: 'A note' },
    { fieldId: journal.fields[1].id, value: '12.5' },
    { fieldId: journal.fields[2].id, value: 'Remember this' },
  ];
  const entry = data(await graphql(
    'mutation($id: String!, $input: SaveEntryInput!) { createEntry(collectionId: $id, input: $input) { id formatId createdAt updatedAt values { fieldId value } } }',
    { id: collection.id, input: { formatId: journal.id, values } },
  )).createEntry;
  assert.ok(entry.createdAt && entry.updatedAt, 'entry dates must reach the web client');
  assert.equal(entry.formatId, journal.id);
  assert.equal(entry.values.length, 3);
  const reference = extended.formats[1];
  const secondEntry = data(await graphql(
    'mutation($id: String!, $input: SaveEntryInput!) { createEntry(collectionId: $id, input: $input) { id formatId } }',
    { id: collection.id, input: { formatId: reference.id, values: [{ fieldId: reference.fields[0].id, value: 'https://example.com' }] } },
  )).createEntry;
  assert.equal(secondEntry.formatId, reference.id);
  const recolored = data(await graphql(
    'mutation($collectionId: String!, $formatId: String!, $color: String!) { setCollectionFormatColor(collectionId: $collectionId, formatId: $formatId, color: $color) { formats { id color } } }',
    { collectionId: collection.id, formatId: reference.id, color: '#F4F0FF' },
  )).setCollectionFormatColor;
  assert.equal(recolored.formats[1].color, '#F4F0FF');
  assert.equal(data(await graphql('query($id: String!) { collectionEntries(collectionId: $id) { id } }', { id: collection.id })).collectionEntries.length, 2);

  const impact = data(await graphql(
    'query($collectionId: String!, $formatId: String!) { collectionFormatImpact(collectionId: $collectionId, formatId: $formatId) { entryCount populatedFieldIds } }',
    { collectionId: collection.id, formatId: journal.id },
  )).collectionFormatImpact;
  assert.equal(impact.entryCount, 1);
  assert.ok(impact.populatedFieldIds.includes(journal.fields[0].id));
  const edited = data(await graphql(
    'mutation($collectionId: String!, $formatId: String!, $input: UpdateCollectionFormatInput!) { updateCollectionFormat(collectionId: $collectionId, formatId: $formatId, input: $input) { formats { id name version fields { id name kind } } } }',
    { collectionId: collection.id, formatId: journal.id, input: { name: 'Renamed journal', expectedVersion: 1, fields: [
      { id: journal.fields[0].id, name: 'Heading', kind: 'TITLE' },
      { id: journal.fields[1].id, name: 'Distance', kind: 'NUMBER', unit: 'km' },
      { id: journal.fields[2].id, name: 'Details', kind: 'TEXT' },
      { name: 'Extra notes', kind: 'LONG_TEXT' },
    ] } },
  )).updateCollectionFormat.formats.find((item) => item.id === journal.id);
  assert.equal(edited.version, 2);
  assert.equal(edited.fields[0].id, journal.fields[0].id);
  assert.equal(data(await graphql(
    'query($id: String!) { collectionEntries(collectionId: $id) { id values { fieldId value } } }',
    { id: collection.id },
  )).collectionEntries.find((item) => item.id === entry.id).values[0].value, 'A note');

  const typed = data(await graphql(
    'mutation($id: String!, $input: CollectionFormatInput!) { addCollectionFormat(collectionId: $id, input: $input) { formats { id name fields { id name kind } } } }',
    { id: collection.id, input: { name: 'Checklist', color: '#FFF0F4', fields: [
      { name: 'Done', kind: 'BOOLEAN' }, { name: 'Status', kind: 'SELECT', options: ['Open', 'Closed'] },
      { name: 'File', kind: 'ATTACHMENT' },
    ] } },
  )).addCollectionFormat.formats.find((item) => item.name === 'Checklist');
  const fileContent = Buffer.from('A private note');
  const typedEntry = data(await graphql(
    'mutation($id: String!, $input: SaveEntryInput!) { createEntry(collectionId: $id, input: $input) { id values { fieldId value booleanValue selectedValues } } }',
    { id: collection.id, input: { formatId: typed.id, values: [
      { fieldId: typed.fields[0].id, value: 'true' },
      { fieldId: typed.fields[1].id, value: 'Open' },
      { fieldId: typed.fields[2].id, value: 'note.txt', attachmentMimeType: 'text/plain', attachmentBase64: fileContent.toString('base64') },
    ] } },
  )).createEntry;
  assert.equal(typedEntry.values[0].booleanValue, true);
  const downloaded = data(await graphql(
    'query($entryId: String!, $fieldId: String!) { entryAttachment(entryId: $entryId, fieldId: $fieldId) { fileName mimeType base64 } }',
    { entryId: typedEntry.id, fieldId: typed.fields[2].id },
  )).entryAttachment;
  assert.equal(downloaded.fileName, 'note.txt');
  assert.equal(Buffer.from(downloaded.base64, 'base64').toString(), fileContent.toString());

  data(await graphql('mutation($id: String!) { deleteEntry(id: $id) }', { id: typedEntry.id }));
  data(await graphql('mutation($id: String!) { deleteEntry(id: $id) }', { id: secondEntry.id }));
  data(await graphql('mutation($id: String!) { deleteEntry(id: $id) }', { id: entry.id }));
  data(await graphql('mutation($id: String!) { deleteCollection(id: $id) }', { id: collection.id }));

  const signedOut = await fetch(`${webUrl}/api/session`, { method: 'DELETE', headers: { cookie } });
  assert.equal(signedOut.status, 200);
  cookie = '';
  assert.ok((await graphql('query { me { id } }')).errors?.length, 'signed-out access must fail');
  console.log('Web session, format edits, typed entries, private attachments, and entry CRUD passed.');
} finally {
  try {
    if (collectionIds.length) {
      await mongoose.connection.collection('entries').deleteMany({ collectionId: { $in: collectionIds } });
      await mongoose.connection.collection('collections').deleteMany({ _id: { $in: collectionIds.map((id) => new mongoose.Types.ObjectId(id)) } });
    }
    if (userIds.length) {
      await mongoose.connection.collection('users').deleteMany({ _id: { $in: userIds.map((id) => new mongoose.Types.ObjectId(id)) } });
    }
  } finally {
    await mongoose.disconnect();
  }
}
