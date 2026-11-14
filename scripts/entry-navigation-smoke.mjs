// Large lists, entry limits and required fields, against a running API (npm run smoke:entry-navigation).
// Creates its own account and data, then removes them.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

const url = `http://localhost:${process.env.PORT ?? 3000}/graphql`;
const suffix = randomUUID().slice(0, 8);
let userId;
let collectionId;
assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI to run and clean up smoke data');
await mongoose.connect(process.env.MONGODB_URI);

async function graphql(query, variables = {}, token) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  return response.json();
}
const data = (result) => { assert.equal(result.errors, undefined, JSON.stringify(result.errors)); return result.data; };
const refused = (result, text) => { assert.ok(result.errors?.some((error) => error.message.includes(text)), `expected "${text}", got ${JSON.stringify(result.errors ?? result.data)}`); };

try {
  const { register } = data(await graphql('mutation($input: RegisterInput!) { register(input: $input) { token user { id } } }', {
    input: { name: 'Navigation Tester', email: `navigation-${suffix}@example.test`, password: 'test-password-123' },
  }));
  userId = register.user.id;
  const token = register.token;
  const formats = 'formats { id maxEntries singleEntry fields { id name required } }';

  // A data format of at most 2 entries, with one required field among two.
  const created = data(await graphql(`mutation($input: CreateCollectionInput!) { createCollection(input: $input) { id ${formats} } }`, {
    input: { name: 'Wells', formats: [
      { name: 'Reading', color: '#EEF5FF', fields: [{ name: 'Place', kind: 'TITLE', required: true }, { name: 'Depth', kind: 'NUMBER' }] },
      { name: 'Limited', color: '#EDF9F3', maxEntries: 2, fields: [{ name: 'Note', kind: 'TEXT' }] },
    ] },
  }, token)).createCollection;
  collectionId = created.id;
  const [reading, limited] = created.formats;
  assert.equal(reading.fields[0].required, true);
  assert.equal(reading.fields[1].required, null);
  assert.equal(reading.maxEntries, null);
  assert.equal(limited.maxEntries, 2);

  const createEntry = 'mutation($id: String!, $input: SaveEntryInput!) { createEntry(collectionId: $id, input: $input) { id createdAt } }';
  // Required field: refused when empty, accepted when filled.
  refused(await graphql(createEntry, { id: collectionId, input: { formatId: reading.id, values: [{ fieldId: reading.fields[1].id, value: '12' }] } }, token), 'Required fields are empty: Place');
  const saved = data(await graphql(createEntry, { id: collectionId, input: { formatId: reading.id, values: [{ fieldId: reading.fields[0].id, value: 'Well' }] } }, token)).createEntry;
  refused(await graphql('mutation($id: String!, $input: SaveEntryInput!) { updateEntry(id: $id, input: $input) { id } }', { id: saved.id, input: { values: [{ fieldId: reading.fields[1].id, value: '3' }] } }, token), 'Required fields are empty');

  // Entry limit: the third entry is refused; the limit cannot go under the entries kept.
  for (const note of ['a', 'b']) data(await graphql(createEntry, { id: collectionId, input: { formatId: limited.id, values: [{ fieldId: limited.fields[0].id, value: note }] } }, token));
  refused(await graphql(createEntry, { id: collectionId, input: { formatId: limited.id, values: [{ fieldId: limited.fields[0].id, value: 'c' }] } }, token), 'can only have 2 entries');
  const rules = `mutation($collectionId: String!, $formatId: String!, $singleEntry: Boolean!, $maxEntries: Int) { setFormatEntryRules(collectionId: $collectionId, formatId: $formatId, singleEntry: $singleEntry, maxEntries: $maxEntries, parentFormatIds: []) { ${formats} } }`;
  refused(await graphql(rules, { collectionId, formatId: limited.id, singleEntry: false, maxEntries: 1 }, token), 'Keep one before allowing a single entry');
  refused(await graphql(rules, { collectionId, formatId: limited.id, singleEntry: false, maxEntries: 0.5 }, token), 'Int');
  const raised = data(await graphql(rules, { collectionId, formatId: limited.id, singleEntry: false, maxEntries: 3 }, token)).setFormatEntryRules.formats.find((format) => format.id === limited.id);
  assert.equal(raised.maxEntries, 3);
  const lifted = data(await graphql(rules, { collectionId, formatId: limited.id, singleEntry: false, maxEntries: null }, token)).setFormatEntryRules.formats.find((format) => format.id === limited.id);
  assert.equal(lifted.maxEntries, null);
  assert.equal(lifted.singleEntry, false);

  // Large lists: 120 readings over 120 days, newest first; positions, totals and date jumps.
  const start = Date.UTC(2026, 0, 1, 12);
  await mongoose.connection.collection('entries').insertMany(Array.from({ length: 120 }, (_, index) => ({
    collectionId, ownerId: userId, createdBy: userId, updatedBy: userId, formatId: reading.id, formatVersion: 1,
    values: [{ fieldId: reading.fields[0].id, value: `Day ${index}` }],
    createdAt: new Date(start + index * 86_400_000), updatedAt: new Date(start + index * 86_400_000),
  })));
  refused(await graphql(rules, { collectionId, formatId: reading.id, singleEntry: false, maxEntries: 5 }, token), 'already has more than 5 entries');
  const page = 'query($id: String!, $first: Int!, $offset: Int, $atDate: String, $formatId: String, $after: String) { collectionEntriesPage(collectionId: $id, first: $first, offset: $offset, atDate: $atDate, formatId: $formatId, after: $after) { entries { values { value } } hasMore nextCursor totalCount offset } }';
  const value = (result) => result.entries[0].values[0].value;
  const firstPage = data(await graphql(page, { id: collectionId, first: 30, formatId: reading.id }, token)).collectionEntriesPage;
  assert.equal(firstPage.totalCount, 121);
  assert.equal(firstPage.offset, 0);
  const third = data(await graphql(page, { id: collectionId, first: 30, formatId: reading.id, offset: 60 }, token)).collectionEntriesPage;
  assert.equal(third.offset, 60);
  assert.equal(third.entries.length, 30);
  assert.equal(third.totalCount, 121);
  const last = data(await graphql(page, { id: collectionId, first: 30, formatId: reading.id, offset: 120 }, token)).collectionEntriesPage;
  assert.equal(last.entries.length, 1);
  assert.equal(last.hasMore, false);
  const beyond = data(await graphql(page, { id: collectionId, first: 30, formatId: reading.id, offset: 9000 }, token)).collectionEntriesPage;
  assert.equal(beyond.offset, 120, 'a position past the end opens the last page');
  // 2026-02-10 is day 40: 80 readings are newer, plus the "Well" entry written today, so it sits on the page at 60–89.
  const dated = data(await graphql(page, { id: collectionId, first: 30, formatId: reading.id, atDate: '2026-02-10' }, token)).collectionEntriesPage;
  assert.equal(dated.offset, 60);
  assert.ok(dated.entries.some((entry) => entry.values[0].value === 'Day 40'));
  const cursorPage = data(await graphql(page, { id: collectionId, first: 30, formatId: reading.id, after: firstPage.nextCursor }, token)).collectionEntriesPage;
  assert.equal(cursorPage.totalCount, null, 'cursor pages keep their former, lighter answer');
  assert.notEqual(value(cursorPage), value(firstPage));
  refused(await graphql(page, { id: collectionId, first: 30, offset: 30, after: firstPage.nextCursor }, token), 'not both');
  refused(await graphql(page, { id: collectionId, first: 30, atDate: '10/02/2026' }, token), 'valid date');

  console.log('entry navigation smoke passed');
} finally {
  try {
    if (collectionId) {
      await mongoose.connection.collection('entries').deleteMany({ collectionId });
      await mongoose.connection.collection('collections').deleteOne({ _id: new mongoose.Types.ObjectId(collectionId) });
    }
    if (userId) await mongoose.connection.collection('users').deleteOne({ _id: new mongoose.Types.ObjectId(userId) });
  } finally {
    await mongoose.disconnect();
  }
}
