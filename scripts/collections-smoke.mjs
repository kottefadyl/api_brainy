import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

const url = `http://localhost:${process.env.PORT ?? 3000}/graphql`;
const suffix = randomUUID().slice(0, 8);
const userIds = [];
const collectionIds = [];
assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI to run and clean up collection smoke data');
await mongoose.connect(process.env.MONGODB_URI);

async function graphql(query, variables = {}, token) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  return response.json();
}

function data(result) {
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  return result.data;
}

try {
  const register = 'mutation($input: RegisterInput!) { register(input: $input) { token user { id } } }';
  const first = data(await graphql(register, {
    input: { name: 'Collection Tester', email: `collection-${suffix}-a@example.test`, password: 'test-password-123' },
  })).register;
  userIds.push(first.user.id);
  const second = data(await graphql(register, {
    input: { name: 'Other Tester', email: `collection-${suffix}-b@example.test`, password: 'test-password-123' },
  })).register;
  userIds.push(second.user.id);

  const legacyId = new mongoose.Types.ObjectId();
  const legacyFieldId = randomUUID();
  collectionIds.push(legacyId.toString());
  await mongoose.connection.collection('collections').insertOne({
    _id: legacyId, ownerId: first.user.id, name: 'Older notes',
    fields: [{ id: legacyFieldId, name: 'Title', kind: 'TITLE' }],
    createdAt: new Date(), updatedAt: new Date(),
  });
  await mongoose.connection.collection('entries').insertOne({
    collectionId: legacyId.toString(), ownerId: first.user.id,
    values: [{ fieldId: legacyFieldId, value: 'Saved before formats' }],
    createdAt: new Date(), updatedAt: new Date(),
  });
  const migrated = data(await graphql('query { collectionsList { id formats { id name color fields { id } } } }', {}, first.token))
    .collectionsList.find((item) => item.id === legacyId.toString());
  assert.equal(migrated.formats.length, 1);
  assert.equal(migrated.formats[0].fields[0].id, legacyFieldId);
  const legacyEntries = data(await graphql(
    'query($id: String!) { collectionEntries(collectionId: $id) { formatId values { value } } }',
    { id: legacyId.toString() }, first.token,
  )).collectionEntries;
  assert.equal(legacyEntries[0].formatId, migrated.formats[0].id);
  assert.equal(legacyEntries[0].values[0].value, 'Saved before formats');

  const createCollection = 'mutation($input: CreateCollectionInput!) { createCollection(input: $input) { id name fields { id name kind unit } } }';
  const collection = data(await graphql(createCollection, {
    input: {
      name: 'Journal',
      formats: [{ name: 'Journal', color: '#FFF5EB', fields: [
        { name: 'Title', kind: 'TITLE' },
        { name: 'When', kind: 'DATE' },
        { name: 'Count', kind: 'NUMBER', unit: 'km' },
        { name: 'At', kind: 'TIME' },
        { name: 'Source', kind: 'LINK' },
        { name: 'Initial', kind: 'CHARACTER' },
        { name: 'Notes', kind: 'TEXT' },
      ] }],
    },
  }, first.token)).createCollection;
  collectionIds.push(collection.id);
  assert.equal(collection.fields.length, 7);
  assert.equal(collection.fields[2].unit, 'km');
  assert.ok((await graphql(createCollection, {
    input: { name: 'Missing color', formats: [{ name: 'Notes', fields: [{ name: 'Title', kind: 'TITLE' }] }] },
  }, first.token)).errors?.length, 'a new format requires a color');
  assert.ok((await graphql(createCollection, {
    input: { name: 'Invalid color', formats: [{ name: 'Notes', color: '#FF0000', fields: [{ name: 'Title', kind: 'TITLE' }] }] },
  }, first.token)).errors?.length, 'strong colors must be rejected');
  const custom = data(await graphql(createCollection, {
    input: { name: 'Speeds', fields: [{ name: 'Speed', kind: 'NUMBER', unit: 'm/s²' }] },
  }, first.token)).createCollection;
  collectionIds.push(custom.id);
  assert.equal(custom.fields[0].unit, 'm/s²');
  assert.equal(data(await graphql('query { collectionsList { id } }', {}, second.token)).collectionsList.length, 0);
  assert.ok((await graphql('query { collectionsList { id } }')).errors?.length, 'anonymous list must fail');
  assert.ok((await graphql(createCollection, { input: { name: 'Bad', fields: [] } }, first.token)).errors?.length);
  assert.ok((await graphql(createCollection, {
    input: { name: 'Bad', fields: [{ name: 'Date', kind: 'DATE' }, { name: 'date', kind: 'TEXT' }] },
  }, first.token)).errors?.length);
  assert.ok((await graphql(createCollection, {
    input: { name: 'Bad', fields: [{ name: 'Title', kind: 'TITLE', unit: 'kg' }] },
  }, first.token)).errors?.length, 'units on non-number fields must fail');

  const values = collection.fields.map((field) => ({
    fieldId: field.id,
    value: ({ TITLE: 'A thought', DATE: '2026-10-20', NUMBER: '42.5', TIME: '09:30',
      LINK: 'https://example.com', CHARACTER: 'A', TEXT: 'Something to remember' })[field.kind],
  }));
  const createEntry = 'mutation($id: String!, $input: SaveEntryInput!) { createEntry(collectionId: $id, input: $input) { id values { fieldId value } } }';
  const entry = data(await graphql(createEntry, { id: collection.id, input: { values } }, first.token)).createEntry;
  assert.equal(entry.values.length, 7);
  assert.ok((await graphql(createEntry, {
    id: collection.id, input: { values: [{ fieldId: collection.fields[1].id, value: '2026-02-30' }] },
  }, first.token)).errors?.length, 'invalid calendar date must fail');
  assert.ok((await graphql(createEntry, {
    id: collection.id, input: { values: [{ fieldId: collection.fields[5].id, value: 'AB' }] },
  }, first.token)).errors?.length, 'two characters must fail');
  assert.ok((await graphql(createEntry, { id: collection.id, input: { values } }, second.token)).errors?.length,
    'another account cannot add entries');
  const list = 'query($id: String!) { collectionEntries(collectionId: $id) { id } }';
  assert.equal(data(await graphql(list, { id: collection.id }, first.token)).collectionEntries.length, 1);
  assert.ok((await graphql(list, { id: collection.id }, second.token)).errors?.length);

  const update = 'mutation($id: String!, $input: SaveEntryInput!) { updateEntry(id: $id, input: $input) { id values { value } } }';
  assert.ok((await graphql(update, { id: entry.id, input: { values: [values[0]] } }, second.token)).errors?.length);
  const edited = data(await graphql(update, {
    id: entry.id, input: { values: [{ fieldId: values[0].fieldId, value: 'Revised' }] },
  }, first.token)).updateEntry;
  assert.equal(edited.values[0].value, 'Revised');

  const extended = data(await graphql(
    'mutation($id: String!, $input: CollectionFormatInput!) { addCollectionFormat(collectionId: $id, input: $input) { id formats { id name color fields { id name kind unit } } } }',
    { id: collection.id, input: { name: 'References', color: '#EDF9F3', fields: [{ name: 'Website', kind: 'LINK' }] } },
    first.token,
  )).addCollectionFormat;
  assert.equal(extended.formats.length, 2);
  assert.notEqual(extended.formats[0].color, extended.formats[1].color);
  assert.equal(extended.formats[0].color, '#FFF5EB');
  assert.ok((await graphql(
    'mutation($id: String!, $input: CollectionFormatInput!) { addCollectionFormat(collectionId: $id, input: $input) { id } }',
    { id: collection.id, input: { name: 'Duplicate shade', color: '#EDF9F3', fields: [{ name: 'Text', kind: 'TEXT' }] } },
    first.token,
  )).errors?.length, 'formats within a collection need distinct colors');
  const reference = extended.formats[1];
  const referenceEntry = data(await graphql(
    'mutation($id: String!, $input: SaveEntryInput!) { createEntry(collectionId: $id, input: $input) { id formatId values { fieldId value } } }',
    { id: collection.id, input: { formatId: reference.id, values: [{ fieldId: reference.fields[0].id, value: 'https://example.com' }] } },
    first.token,
  )).createEntry;
  assert.equal(referenceEntry.formatId, reference.id);
  const recolored = data(await graphql(
    'mutation($collectionId: String!, $formatId: String!, $color: String!) { setCollectionFormatColor(collectionId: $collectionId, formatId: $formatId, color: $color) { formats { id color } } }',
    { collectionId: collection.id, formatId: reference.id, color: '#EFFAF0' }, first.token,
  )).setCollectionFormatColor;
  assert.equal(recolored.formats[1].color, '#EFFAF0');
  assert.ok((await graphql(
    'mutation($collectionId: String!, $formatId: String!, $color: String!) { setCollectionFormatColor(collectionId: $collectionId, formatId: $formatId, color: $color) { id } }',
    { collectionId: collection.id, formatId: reference.id, color: '#FFF5EB' }, first.token,
  )).errors?.length, 'recoloring cannot reuse another format color');
  assert.ok((await graphql(
    'mutation($collectionId: String!, $formatId: String!, $color: String!) { setCollectionFormatColor(collectionId: $collectionId, formatId: $formatId, color: $color) { id } }',
    { collectionId: collection.id, formatId: reference.id, color: '#EDF9F3' }, second.token,
  )).errors?.length, 'another account cannot recolor this format');
  assert.ok((await graphql(createEntry, {
    id: collection.id, input: { formatId: reference.id, values: [values[0]] },
  }, first.token)).errors?.length, 'a field from another format must be rejected');
  assert.ok((await graphql(update, {
    id: referenceEntry.id, input: { formatId: extended.formats[0].id, values: [values[0]] },
  }, first.token)).errors?.length, 'an entry format cannot be changed during edit');

  const currentFormat = extended.formats[0];
  const numberEntry = data(await graphql(createEntry, { id: collection.id, input: { formatId: currentFormat.id, values: [values[2]] } }, first.token)).createEntry;
  const impactQuery = 'query($collectionId: String!, $formatId: String!) { collectionFormatImpact(collectionId: $collectionId, formatId: $formatId) { entryCount populatedFieldIds } }';
  const impact = data(await graphql(impactQuery, { collectionId: collection.id, formatId: currentFormat.id }, first.token)).collectionFormatImpact;
  assert.equal(impact.entryCount, 2);
  assert.ok(impact.populatedFieldIds.includes(values[2].fieldId));
  assert.ok((await graphql(impactQuery, { collectionId: collection.id, formatId: currentFormat.id }, second.token)).errors?.length);
  const editFormat = 'mutation($collectionId: String!, $formatId: String!, $input: UpdateCollectionFormatInput!) { updateCollectionFormat(collectionId: $collectionId, formatId: $formatId, input: $input) { id formats { id name version fields { id name kind unit } } } }';
  const renamedFields = currentFormat.fields.map((field) => ({ id: field.id, name: field.name === 'Title' ? 'Heading' : field.name, kind: field.kind, ...(field.unit ? { unit: field.unit } : {}) }));
  const revisedFormat = data(await graphql(editFormat, { collectionId: collection.id, formatId: currentFormat.id, input: { name: 'Journal revised', expectedVersion: 1, fields: [{ name: 'New detail', kind: 'TEXT' }, ...renamedFields] } }, first.token)).updateCollectionFormat.formats[0];
  assert.equal(revisedFormat.version, 2);
  assert.equal(revisedFormat.fields[1].id, currentFormat.fields[0].id);
  assert.equal(revisedFormat.fields[1].name, 'Heading');
  assert.equal(data(await graphql('query($id: String!) { collectionEntries(collectionId: $id) { id values { fieldId value } } }', { id: collection.id }, first.token)).collectionEntries.find((item) => item.id === numberEntry.id).values[0].value, '42.5');
  assert.ok((await graphql(editFormat, { collectionId: collection.id, formatId: currentFormat.id, input: { name: 'Stale', expectedVersion: 1, fields: renamedFields } }, first.token)).errors?.length, 'stale edits must fail');
  assert.ok((await graphql(editFormat, { collectionId: collection.id, formatId: currentFormat.id, input: { name: 'Unsafe', expectedVersion: 2, fields: revisedFormat.fields.filter((field) => field.id !== values[2].fieldId) } }, first.token)).errors?.length, 'populated fields cannot be removed');
  assert.ok((await graphql(editFormat, { collectionId: collection.id, formatId: currentFormat.id, input: { name: 'Foreign', expectedVersion: 2, fields: revisedFormat.fields } }, second.token)).errors?.length);

  const typed = data(await graphql('mutation($input: CreateCollectionInput!) { createCollection(input: $input) { id formats { id version fields { id name kind options } } } }', { input: { name: 'Typed test', formats: [{ name: 'Record', color: '#EAF8FA', fields: [
    { name: 'Done', kind: 'BOOLEAN' }, { name: 'Status', kind: 'SELECT', options: ['Open', 'Closed'] },
    { name: 'Tags', kind: 'MULTI_SELECT', options: ['Work', 'Home'] }, { name: 'When', kind: 'DATETIME' },
    { name: 'Length', kind: 'DURATION' }, { name: 'Details', kind: 'LONG_TEXT' },
    { name: 'Document', kind: 'ATTACHMENT' },
  ] }] } }, first.token)).createCollection;
  collectionIds.push(typed.id);
  const typedFields = Object.fromEntries(typed.formats[0].fields.map((field) => [field.name, field.id]));
  const typedEntry = data(await graphql('mutation($id: String!, $input: SaveEntryInput!) { createEntry(collectionId: $id, input: $input) { id values { fieldId value booleanValue selectedValues durationSeconds dateTimeValue } } }', { id: typed.id, input: { formatId: typed.formats[0].id, values: [
    { fieldId: typedFields.Done, value: 'false' }, { fieldId: typedFields.Status, value: 'Open' },
    { fieldId: typedFields.Tags, value: '["Work","Home"]' }, { fieldId: typedFields.When, value: '2026-10-21T12:30:00+01:00' },
    { fieldId: typedFields.Length, value: '1:30' }, { fieldId: typedFields.Details, value: 'A longer note' },
    { fieldId: typedFields.Document, value: 'note.txt', attachmentBase64: Buffer.from('A saved file').toString('base64'), attachmentMimeType: 'text/plain' },
  ] } }, first.token)).createEntry;
  assert.equal(typedEntry.values.find((value) => value.fieldId === typedFields.Done).booleanValue, false);
  assert.deepEqual(typedEntry.values.find((value) => value.fieldId === typedFields.Tags).selectedValues, ['Work', 'Home']);
  assert.equal(typedEntry.values.find((value) => value.fieldId === typedFields.Length).durationSeconds, 5400);
  assert.equal(typedEntry.values.find((value) => value.fieldId === typedFields.When).dateTimeValue, '2026-10-21T11:30:00.000Z');
  const attachmentQuery = 'query($entryId: String!, $fieldId: String!) { entryAttachment(entryId: $entryId, fieldId: $fieldId) { fileName mimeType size base64 } }';
  const savedFile = data(await graphql(attachmentQuery, { entryId: typedEntry.id, fieldId: typedFields.Document }, first.token)).entryAttachment;
  assert.equal(Buffer.from(savedFile.base64, 'base64').toString(), 'A saved file');
  assert.equal(savedFile.fileName, 'note.txt');
  assert.ok((await graphql(attachmentQuery, { entryId: typedEntry.id, fieldId: typedFields.Document }, second.token)).errors?.length, 'another account cannot read an attachment');
  data(await graphql(update, { id: typedEntry.id, input: { formatId: typed.formats[0].id, values: [{ fieldId: typedFields.Document, value: 'note.txt' }] } }, first.token));
  assert.equal(Buffer.from(data(await graphql(attachmentQuery, { entryId: typedEntry.id, fieldId: typedFields.Document }, first.token)).entryAttachment.base64, 'base64').toString(), 'A saved file');
  assert.ok((await graphql(createEntry, { id: typed.id, input: { formatId: typed.formats[0].id, values: [{ fieldId: typedFields.Status, value: 'Unknown' }] } }, first.token)).errors?.length);
  assert.ok((await graphql(createEntry, { id: typed.id, input: { formatId: typed.formats[0].id, values: [{ fieldId: typedFields.Length, value: '1:99' }] } }, first.token)).errors?.length);
  const larger = data(await graphql(createEntry, { id: typed.id, input: { formatId: typed.formats[0].id, values: [{ fieldId: typedFields.Document, value: 'large.bin', attachmentBase64: Buffer.alloc(150_000, 65).toString('base64') }] } }, first.token)).createEntry;
  assert.equal(data(await graphql(attachmentQuery, { entryId: larger.id, fieldId: typedFields.Document }, first.token)).entryAttachment.size, 150_000);

  data(await graphql('mutation($id: String!) { deleteCollection(id: $id) }', { id: collection.id }, first.token));
  assert.ok((await graphql(list, { id: collection.id }, first.token)).errors?.length);
  const searchable = data(await graphql('mutation($input: CreateCollectionInput!) { createCollection(input: $input) { id formats { id fields { id name } } } }', { input: { name: 'Search tests', formats: [{ name: 'Records', color: '#EAF8FA', fields: [
    { name: 'Title', kind: 'TITLE' }, { name: 'Notes', kind: 'LONG_TEXT' }, { name: 'Count', kind: 'NUMBER' },
    { name: 'Day', kind: 'DATE' }, { name: 'Done', kind: 'BOOLEAN' }, { name: 'Status', kind: 'SELECT', options: ['Open', 'Closed'] },
  ] }] } }, first.token)).createCollection;
  collectionIds.push(searchable.id);
  const searchFormat = searchable.formats[0];
  const fieldsByName = Object.fromEntries(searchFormat.fields.map((field) => [field.name, field.id]));
  const sameTime = new Date('2026-10-21T12:00:00Z');
  await mongoose.connection.collection('entries').insertMany(Array.from({ length: 65 }, (_, index) => ({
    ownerId: first.user.id, collectionId: searchable.id, formatId: searchFormat.id, formatVersion: 1,
    values: [
      { fieldId: fieldsByName.Title, value: `Plan ${String(index).padStart(3, '0')}` },
      { fieldId: fieldsByName.Notes, value: index % 3 === 0 ? 'river research notes' : 'mountain research notes' },
      { fieldId: fieldsByName.Count, value: String(index), numberValue: String(index) },
      { fieldId: fieldsByName.Day, value: `2026-10-${index % 2 ? '21' : '22'}`, dateValue: `2026-10-${index % 2 ? '21' : '22'}` },
      { fieldId: fieldsByName.Done, value: index % 2 ? 'true' : 'false', booleanValue: !!(index % 2) },
      { fieldId: fieldsByName.Status, value: index % 2 ? 'Open' : 'Closed', selectedValues: [index % 2 ? 'Open' : 'Closed'] },
    ], createdAt: sameTime, updatedAt: sameTime,
  })));
  const pageQuery = 'query($id: String!, $first: Int!, $after: String, $search: String, $filters: [EntryFieldFilterInput!]) { collectionEntriesPage(collectionId: $id, first: $first, after: $after, search: $search, filters: $filters) { entries { id values { fieldId value } } nextCursor hasMore } }';
  data(await graphql(createEntry, { id: typed.id, input: { formatId: typed.formats[0].id, values: [{ fieldId: typedFields.When, value: '2026-10-21T11:30:00Z' }] } }, first.token));
  assert.equal(data(await graphql(pageQuery, { id: typed.id, first: 20, filters: [{ fieldId: typedFields.When, operator: 'EQ', value: '2026-10-21T12:30:00+01:00' }] }, first.token)).collectionEntriesPage.entries.length, 1, 'date-time filters compare instants across time zones');
  assert.ok((await graphql(pageQuery, { id: searchable.id, first: 20, filters: [{ fieldId: fieldsByName.Day, operator: 'EQ', value: '2026-02-31' }] }, first.token)).errors?.length, 'impossible calendar dates cannot be filters');
  const seenPages = [];
  let after;
  for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
    const page = data(await graphql(pageQuery, { id: searchable.id, first: 25, after }, first.token)).collectionEntriesPage;
    seenPages.push(...page.entries.map((item) => item.id));
    after = page.nextCursor;
    assert.equal(page.hasMore, pageNumber < 2);
  }
  assert.equal(seenPages.length, 65);
  assert.equal(new Set(seenPages).size, 65, 'cursor pages must not repeat tied timestamps');
  const searched = data(await graphql(pageQuery, { id: searchable.id, first: 100, search: 'river' }, first.token)).collectionEntriesPage;
  assert.equal(searched.entries.length, 22);
  const numberFilter = [{ fieldId: fieldsByName.Count, operator: 'GT', value: '50' }];
  assert.equal(data(await graphql(pageQuery, { id: searchable.id, first: 100, filters: numberFilter }, first.token)).collectionEntriesPage.entries.length, 14);
  assert.equal(data(await graphql(pageQuery, { id: searchable.id, first: 100, filters: [{ fieldId: fieldsByName.Status, operator: 'EQ', value: 'Open' }] }, first.token)).collectionEntriesPage.entries.length, 32);
  assert.equal(data(await graphql(pageQuery, { id: searchable.id, first: 100, filters: [{ fieldId: fieldsByName.Notes, operator: 'CONTAINS', value: 'river' }] }, first.token)).collectionEntriesPage.entries.length, 22);
  assert.ok((await graphql(pageQuery, { id: searchable.id, first: 20 }, second.token)).errors?.length, 'another account cannot page through entries');
  assert.ok((await graphql(pageQuery, { id: searchable.id, first: 20, after: 'invalid' }, first.token)).errors?.length, 'invalid cursors must fail');
  await mongoose.connection.collection('entries').insertMany(Array.from({ length: 2048 }, (_, index) => ({
    ownerId: first.user.id, collectionId: searchable.id, formatId: searchable.formats[0].id,
    values: [{ fieldId: fieldsByName.Notes, value: `archive-${index}` }],
    createdAt: new Date('2026-02-01T00:00:00Z'), updatedAt: new Date('2026-02-01T00:00:00Z'),
  })));
  let largeCursor;
  const largeIds = new Set();
  do {
    const page = data(await graphql(pageQuery, { id: searchable.id, first: 100, after: largeCursor }, first.token)).collectionEntriesPage;
    for (const item of page.entries) largeIds.add(item.id);
    largeCursor = page.nextCursor;
  } while (largeCursor);
  assert.equal(largeIds.size, 2113, 'thousands of tied timestamps remain reachable exactly once');
  const importMutation = 'mutation($collectionId: String!, $input: ImportEntriesInput!) { importEntriesBatch(collectionId: $collectionId, input: $input) { validCount createdCount skippedCount errors { sourceId message } } }';
  const importInput = { formatId: typed.formats[0].id, importKey: `roundtrip-${suffix}`, dryRun: true, rows: [{
    sourceId: 'entry-1', createdAt: '2025-01-02T03:04:05Z', updatedAt: '2025-01-02T03:04:05Z',
    values: [{ fieldId: typedFields.Document, value: 'saved.txt', attachmentBase64: Buffer.from('round trip').toString('base64'), attachmentMimeType: 'text/plain' }],
  }] };
  const preview = data(await graphql(importMutation, { collectionId: typed.id, input: importInput }, first.token)).importEntriesBatch;
  assert.equal(preview.validCount, 1);
  assert.equal(preview.createdCount, 0);
  const rejected = data(await graphql(importMutation, { collectionId: typed.id, input: { ...importInput, dryRun: false, rows: [...importInput.rows, { sourceId: 'invalid', createdAt: '2025-01-02T03:04:05Z', updatedAt: '2025-01-02T03:04:05Z', values: [{ fieldId: typedFields.Status, value: 'Missing' }] }] } }, first.token)).importEntriesBatch;
  assert.equal(rejected.createdCount, 0);
  assert.equal(rejected.errors.length, 1);
  const imported = data(await graphql(importMutation, { collectionId: typed.id, input: { ...importInput, dryRun: false } }, first.token)).importEntriesBatch;
  assert.equal(imported.createdCount, 1);
  assert.equal(data(await graphql(importMutation, { collectionId: typed.id, input: { ...importInput, dryRun: false } }, first.token)).importEntriesBatch.skippedCount, 1);
  const importedEntry = await mongoose.connection.collection('entries').findOne({ ownerId: first.user.id, collectionId: typed.id, importKey: importInput.importKey, sourceId: 'entry-1' });
  assert.equal(importedEntry.createdAt.toISOString(), '2025-01-02T03:04:05.000Z');
  assert.equal(Buffer.from(data(await graphql(attachmentQuery, { entryId: importedEntry._id.toString(), fieldId: typedFields.Document }, first.token)).entryAttachment.base64, 'base64').toString(), 'round trip');
  assert.ok((await graphql(importMutation, { collectionId: typed.id, input: importInput }, second.token)).errors?.length, 'another account cannot import into a private collection');
  const saveUnit = 'mutation($collectionId: String!, $unitId: String, $input: CollectionUnitInput!) { saveCollectionUnit(collectionId: $collectionId, unitId: $unitId, input: $input) { units { id name factor version } } }';
  const bottle = data(await graphql(saveUnit, { collectionId: typed.id, input: { name: 'Bottle', symbol: 'btl', dimension: 'COUNT', baseUnitId: 'item', factor: '1', objectFormatId: typed.formats[0].id } }, first.token)).saveCollectionUnit.units[0];
  const carton = data(await graphql(saveUnit, { collectionId: typed.id, input: { name: 'Carton', symbol: 'ctn', dimension: 'COUNT', baseUnitId: bottle.id, factor: '12', objectFormatId: typed.formats[0].id } }, first.token)).saveCollectionUnit.units[1];
  const convert = 'query($collectionId: String!, $amount: String!, $from: String!, $to: String!, $asOf: String) { collectionQuantityConversion(collectionId: $collectionId, amount: $amount, from: $from, to: $to, asOf: $asOf) { value rateDate } }';
  assert.equal(data(await graphql(convert, { collectionId: typed.id, amount: '20', from: carton.id, to: bottle.id }, first.token)).collectionQuantityConversion.value, '240');
  assert.ok((await graphql(convert, { collectionId: typed.id, amount: '20', from: carton.id, to: 'kg' }, first.token)).errors?.length, 'count and mass cannot mix');
  assert.ok((await graphql(convert, { collectionId: typed.id, amount: '20', from: carton.id, to: bottle.id }, second.token)).errors?.length, 'unit conversion requires collection access');
  const addFormat = 'mutation($collectionId: String!, $input: CollectionFormatInput!) { addCollectionFormat(collectionId: $collectionId, input: $input) { formats { id name fields { id } } } }';
  const cartonFormat = data(await graphql(addFormat, { collectionId: typed.id, input: { name: 'Shipments', color: '#EEF5FF', fields: [{ name: 'Quantity', kind: 'NUMBER', unit: `local:${carton.id}` }] } }, first.token)).addCollectionFormat.formats.find((item) => item.name === 'Shipments');
  const shipment = data(await graphql(createEntry, { id: typed.id, input: { formatId: cartonFormat.id, values: [{ fieldId: cartonFormat.fields[0].id, value: '20' }] } }, first.token)).createEntry;
  const storedShipment = await mongoose.connection.collection('entries').findOne({ _id: new mongoose.Types.ObjectId(shipment.id) });
  assert.equal(storedShipment.values[0].unitSnapshot.factor, '12');
  data(await graphql(saveUnit, { collectionId: typed.id, unitId: carton.id, input: { name: 'Carton', symbol: 'ctn', dimension: 'COUNT', baseUnitId: bottle.id, factor: '10', objectFormatId: typed.formats[0].id, expectedVersion: 1 } }, first.token));
  assert.equal(data(await graphql(convert, { collectionId: typed.id, amount: '20', from: carton.id, to: bottle.id }, first.token)).collectionQuantityConversion.value, '200');
  const oldShipment = await mongoose.connection.collection('entries').findOne({ _id: new mongoose.Types.ObjectId(shipment.id) });
  assert.equal(oldShipment.values[0].unitSnapshot.factor, '12', 'historical number keeps its unit version and factor');
  const rate = 'mutation($collectionId: String!, $input: CollectionExchangeRateInput!) { recordCollectionExchangeRate(collectionId: $collectionId, input: $input) { id exchangeRates { id } } }';
  data(await graphql(rate, { collectionId: typed.id, input: { from: 'EUR', to: 'USD', rate: '1.2', effectiveAt: '2026-01-01T00:00:00Z' } }, first.token));
  assert.equal(data(await graphql(convert, { collectionId: typed.id, amount: '10', from: 'EUR', to: 'USD', asOf: '2026-02-01T00:00:00Z' }, first.token)).collectionQuantityConversion.value, '12');
  assert.ok((await graphql(convert, { collectionId: typed.id, amount: '10', from: 'EUR', to: 'USD', asOf: '2025-01-01T00:00:00Z' }, first.token)).errors?.length);
  const objectCollection = data(await graphql('mutation($input: CreateCollectionInput!) { createCollection(input: $input) { id formats { id fields { id } } } }', { input: { name: 'Objects', formats: [{ name: 'Notes', color: '#EEF5FF', fields: [{ name: 'Text', kind: 'LONG_TEXT' }] }] } }, first.token)).createCollection;
  collectionIds.push(objectCollection.id);
  const templates = data(await graphql('query { objectModelTemplates { id fields { name kind } } }', {}, first.token)).objectModelTemplates;
  assert.ok(templates.some((item) => item.id === 'product' && item.fields.some((field) => field.name === 'Weight')));
  const frenchTemplates = data(await graphql('query { objectModelTemplates(language: "fr") { id name fields { name } } }', {}, first.token)).objectModelTemplates;
  assert.equal(frenchTemplates.find((item) => item.id === 'product').fields[1].name, 'Poids');
  const objectModel = data(await graphql('mutation($collectionId: String!, $templateId: String!, $name: String!, $color: String!) { addObjectModelFromTemplate(collectionId: $collectionId, templateId: $templateId, name: $name, color: $color) { formats { id name objectModel version fields { id name } } } }', { collectionId: objectCollection.id, templateId: 'product', name: 'Product', color: '#EDF9F3' }, first.token)).addObjectModelFromTemplate.formats.find((item) => item.name === 'Product');
  assert.equal(objectModel.objectModel, true);
  const nameField = objectModel.fields.find((field) => field.name === 'Name').id;
  const weightField = objectModel.fields.find((field) => field.name === 'Weight').id;
  const firstObject = data(await graphql(createEntry, { id: objectCollection.id, input: { formatId: objectModel.id, values: [{ fieldId: nameField, value: 'Bottle' }, { fieldId: weightField, value: '0.55' }] } }, first.token)).createEntry;
  const secondObject = data(await graphql(createEntry, { id: objectCollection.id, input: { formatId: objectModel.id, values: [{ fieldId: nameField, value: 'Box' }, { fieldId: weightField, value: '2' }] } }, first.token)).createEntry;
  assert.ok((await graphql(createEntry, { id: objectCollection.id, input: { formatId: objectModel.id, values: [{ fieldId: weightField, value: '1' }] } }, first.token)).errors?.length, 'objects need a title');
  const objectPage = 'query($collectionId: String!, $formatId: String!, $search: String) { collectionObjectsPage(collectionId: $collectionId, formatId: $formatId, search: $search) { entries { id } hasMore } }';
  assert.equal(data(await graphql(objectPage, { collectionId: objectCollection.id, formatId: objectModel.id }, first.token)).collectionObjectsPage.entries.length, 2);
  assert.equal(data(await graphql(objectPage, { collectionId: objectCollection.id, formatId: objectModel.id, search: 'Bottle' }, first.token)).collectionObjectsPage.entries.length, 1);
  assert.ok((await graphql(objectPage, { collectionId: objectCollection.id, formatId: objectModel.id }, second.token)).errors?.length);
  const editObject = data(await graphql('mutation($id: String!, $input: SaveEntryInput!) { updateEntry(id: $id, input: $input) { id values { fieldId value } revisions { at } } }', { id: firstObject.id, input: { formatId: objectModel.id, values: [{ fieldId: nameField, value: 'Bottle 50 cl' }, { fieldId: weightField, value: '0.55' }] } }, first.token)).updateEntry;
  assert.equal(editObject.id, firstObject.id, 'renaming keeps object identity');
  assert.equal(editObject.revisions.length, 1);
  assert.ok((await graphql('query($id: String!) { collectionObject(id: $id) { id } }', { id: firstObject.id }, second.token)).errors?.length);
  const duplicated = data(await graphql('mutation($id: String!) { duplicateCollectionObject(id: $id) { id values { value } } }', { id: secondObject.id }, first.token)).duplicateCollectionObject;
  assert.notEqual(duplicated.id, secondObject.id, 'duplicate receives a separate identity');
  assert.equal(duplicated.values[0].value, 'Box', 'duplication preserves the name supplied by the user');
  const useObject = 'mutation($objectId: String!, $targetFormatId: String!, $targetFieldId: String!) { useCollectionObject(objectId: $objectId, targetFormatId: $targetFormatId, targetFieldId: $targetFieldId) { id sourceObjectId values { value } } }';
  const used = data(await graphql(useObject, { objectId: firstObject.id, targetFormatId: objectCollection.formats[0].id, targetFieldId: objectCollection.formats[0].fields[0].id }, first.token)).useCollectionObject;
  assert.equal(used.sourceObjectId, firstObject.id);
  assert.match(used.values[0].value, /Bottle 50 cl/);
  assert.match(used.values[0].value, /Weight: 0\.55 kg/, 'snapshot includes a readable unit');
  assert.ok((await graphql(useObject, { objectId: firstObject.id, targetFormatId: objectModel.id, targetFieldId: nameField }, first.token)).errors?.length, 'a text snapshot must not silently create another object');
  assert.ok((await graphql(useObject, { objectId: firstObject.id, targetFormatId: objectCollection.formats[0].id, targetFieldId: objectCollection.formats[0].fields[0].id }, second.token)).errors?.length);
  assert.ok((await graphql('mutation($id: String!) { deleteEntry(id: $id) }', { id: firstObject.id }, first.token)).errors?.length, 'linked object deletion must fail');
  const salesFormat = data(await graphql('mutation($collectionId: String!, $input: CollectionFormatInput!) { addCollectionFormat(collectionId: $collectionId, input: $input) { formats { id name fields { id name variableName referenceMode } } } }', { collectionId: objectCollection.id, input: { name: 'Sales', color: '#EAF8FA', fields: [
    { name: 'Title', kind: 'TITLE' },
    { name: 'Product at sale', kind: 'OBJECT_REF', targetObjectFormatId: objectModel.id, variableName: 'product', referenceMode: 'SNAPSHOT' },
    { name: 'Product now', kind: 'OBJECT_REF', targetObjectFormatId: objectModel.id, variableName: 'liveProduct', referenceMode: 'CURRENT' },
    { name: 'Products', kind: 'OBJECT_REF', targetObjectFormatId: objectModel.id, variableName: 'products', multiple: true },
  ] } }, first.token)).addCollectionFormat.formats.find((item) => item.name === 'Sales');
  const saleFields = Object.fromEntries(salesFormat.fields.map((field) => [field.name, field.id]));
  const sale = data(await graphql(createEntry, { id: objectCollection.id, input: { formatId: salesFormat.id, values: [
    { fieldId: saleFields.Title, value: 'Sale of one bottle' },
    { fieldId: saleFields['Product at sale'], value: JSON.stringify([firstObject.id]) },
    { fieldId: saleFields['Product now'], value: JSON.stringify([firstObject.id]) },
    { fieldId: saleFields.Products, value: JSON.stringify([firstObject.id, secondObject.id]) },
  ] } }, first.token)).createEntry;
  assert.ok((await graphql(createEntry, { id: objectCollection.id, input: { formatId: salesFormat.id, values: [{ fieldId: saleFields.Title, value: 'Bad sale' }, { fieldId: saleFields['Product at sale'], value: JSON.stringify([firstObject.id, secondObject.id]) }] } }, first.token)).errors?.length, 'single object field rejects multiple objects');
  assert.ok((await graphql(createEntry, { id: objectCollection.id, input: { formatId: salesFormat.id, values: [{ fieldId: saleFields.Title, value: 'Foreign sale' }, { fieldId: saleFields['Product at sale'], value: JSON.stringify([used.id]) }] } }, first.token)).errors?.length, 'ordinary entries cannot satisfy object references');
  data(await graphql('mutation($id: String!, $input: SaveEntryInput!) { updateEntry(id: $id, input: $input) { id } }', { id: firstObject.id, input: { formatId: objectModel.id, values: [{ fieldId: nameField, value: 'Bottle 50 cl' }, { fieldId: weightField, value: '0.70' }] } }, first.token));
  const references = data(await graphql('query($entryId: String!) { entryObjectReferences(entryId: $entryId) { objectId fieldId mode name properties { fieldId value unitSnapshot { symbol } } } }', { entryId: sale.id }, first.token)).entryObjectReferences;
  assert.equal(references.find((item) => item.fieldId === saleFields['Product at sale']).properties.find((item) => item.fieldId === weightField).value, '0.55', 'snapshot keeps sale-time weight');
  assert.equal(references.find((item) => item.fieldId === saleFields['Product now']).properties.find((item) => item.fieldId === weightField).value, '0.70', 'current reference follows object edits');
  const variableQuery = 'query($entryId: String!, $variableName: String!, $propertyFieldId: String!, $objectId: String) { objectVariableProperty(entryId: $entryId, variableName: $variableName, propertyFieldId: $propertyFieldId, objectId: $objectId) { objectId mode property { value } } }';
  assert.equal(data(await graphql(variableQuery, { entryId: sale.id, variableName: 'product', propertyFieldId: weightField }, first.token)).objectVariableProperty.property.value, '0.55');
  assert.ok((await graphql(variableQuery, { entryId: sale.id, variableName: 'products', propertyFieldId: weightField }, first.token)).errors?.length, 'multiple object variable needs explicit selection');
  assert.equal(data(await graphql(variableQuery, { entryId: sale.id, variableName: 'products', propertyFieldId: weightField, objectId: secondObject.id }, first.token)).objectVariableProperty.property.value, '2');
  assert.ok((await graphql(variableQuery, { entryId: sale.id, variableName: 'product', propertyFieldId: 'missing' }, first.token)).errors?.length, 'missing property is explicit');
  assert.ok((await graphql(variableQuery, { entryId: sale.id, variableName: 'product', propertyFieldId: weightField }, second.token)).errors?.length, 'another account cannot inspect variable properties');
  assert.ok((await graphql('mutation($id: String!) { deleteEntry(id: $id) }', { id: secondObject.id }, first.token)).errors?.length, 'typed references protect object deletion');
  const transferTarget = data(await graphql('mutation($input: CreateCollectionInput!) { createCollection(input: $input) { id formats { id } } }', { input: { name: 'Object copy target', formats: [{ name: 'General', color: '#EEF5FF', fields: [{ name: 'Text', kind: 'TEXT' }] }] } }, first.token)).createCollection;
  collectionIds.push(transferTarget.id);
  const objectCopyPreview = 'query($objectId: String!, $targetCollectionId: String!) { objectCopyPreview(objectId: $objectId, targetCollectionId: $targetCollectionId) { allowed dataFormats units objects entries conflicts } }';
  assert.equal(data(await graphql(objectCopyPreview, { objectId: secondObject.id, targetCollectionId: transferTarget.id }, first.token)).objectCopyPreview.allowed, true);
  const copiedObject = data(await graphql('mutation($objectId: String!, $targetCollectionId: String!) { copyCollectionObject(objectId: $objectId, targetCollectionId: $targetCollectionId) { objectId copiedObjects copiedEntries } }', { objectId: secondObject.id, targetCollectionId: transferTarget.id }, first.token)).copyCollectionObject;
  assert.equal(copiedObject.copiedObjects, 1);
  assert.notEqual(copiedObject.objectId, secondObject.id);
  assert.equal(data(await graphql('query($id: String!) { collectionObject(id: $id) { id copiedFromEntryId values { value } } }', { id: copiedObject.objectId }, first.token)).collectionObject.copiedFromEntryId, secondObject.id);
  assert.equal(data(await graphql(objectCopyPreview, { objectId: secondObject.id, targetCollectionId: transferTarget.id }, first.token)).objectCopyPreview.allowed, false, 'format name conflict is reported before another copy');
  const formatTarget = data(await graphql('mutation($input: CreateCollectionInput!) { createCollection(input: $input) { id } }', { input: { name: 'Format copy target', formats: [{ name: 'General', color: '#EEF5FF', fields: [{ name: 'Text', kind: 'TEXT' }] }] } }, first.token)).createCollection;
  collectionIds.push(formatTarget.id);
  const formatCopyPreview = 'query($formatId: String!, $targetCollectionId: String!, $withEntries: Boolean!) { dataFormatCopyPreview(formatId: $formatId, targetCollectionId: $targetCollectionId, withEntries: $withEntries) { allowed dataFormats objects entries conflicts } }';
  const formatPlan = data(await graphql(formatCopyPreview, { formatId: salesFormat.id, targetCollectionId: formatTarget.id, withEntries: true }, first.token)).dataFormatCopyPreview;
  assert.equal(formatPlan.allowed, true);
  assert.equal(formatPlan.entries, 3, 'sale copy includes two referenced objects');
  const copiedFormat = data(await graphql('mutation($formatId: String!, $targetCollectionId: String!, $withEntries: Boolean!) { copyCollectionDataFormat(formatId: $formatId, targetCollectionId: $targetCollectionId, withEntries: $withEntries) { dataFormatId copiedObjects copiedEntries } }', { formatId: salesFormat.id, targetCollectionId: formatTarget.id, withEntries: true }, first.token)).copyCollectionDataFormat;
  assert.equal(copiedFormat.copiedObjects, 2);
  assert.equal(copiedFormat.copiedEntries, 3);
  const copiedSale = data(await graphql(pageQuery, { id: formatTarget.id, first: 30 }, first.token)).collectionEntriesPage.entries.find((item) => item.values.some((value) => value.value === 'Sale of one bottle'));
  const copiedRefs = data(await graphql('query($entryId: String!) { entryObjectReferences(entryId: $entryId) { fieldId objectId name mode properties { name value } } }', { entryId: copiedSale.id }, first.token)).entryObjectReferences;
  assert.equal(copiedRefs.length, 4);
  assert.ok(copiedRefs.every((item) => item.objectId !== firstObject.id && item.objectId !== secondObject.id), 'copied references point to new objects');
  assert.ok((await graphql(objectCopyPreview, { objectId: secondObject.id, targetCollectionId: formatTarget.id }, second.token)).errors?.length, 'another account cannot preview another owner’s object');
  const shareTarget = data(await graphql('mutation($input: CreateCollectionInput!) { createCollection(input: $input) { id } }', { input: { name: 'Linked objects target', formats: [{ name: 'General', color: '#EEF5FF', fields: [{ name: 'Text', kind: 'TEXT' }] }] } }, first.token)).createCollection;
  collectionIds.push(shareTarget.id);
  const shareMutation = 'mutation($objectId: String!, $targetCollectionId: String!, $propertyFieldIds: [String!]!, $mode: String!) { shareCollectionObject(objectId: $objectId, targetCollectionId: $targetCollectionId, propertyFieldIds: $propertyFieldIds, mode: $mode) { id objectId propertyFieldIds mode revokedAt } }';
  assert.ok((await graphql(shareMutation, { objectId: firstObject.id, targetCollectionId: shareTarget.id, propertyFieldIds: [nameField], mode: 'CURRENT' }, second.token)).errors?.length, 'another account cannot share an object');
  assert.ok((await graphql('mutation($collectionId: String!, $input: CollectionFormatInput!) { addCollectionFormat(collectionId: $collectionId, input: $input) { id } }', { collectionId: shareTarget.id, input: { name: 'Premature link', color: '#EDF9F3', fields: [{ name: 'Object', kind: 'OBJECT_REF', targetObjectFormatId: objectModel.id }] } }, first.token)).errors?.length, 'a cross-collection reference requires a grant');
  const grant = data(await graphql(shareMutation, { objectId: firstObject.id, targetCollectionId: shareTarget.id, propertyFieldIds: [nameField], mode: 'CURRENT' }, first.token)).shareCollectionObject;
  const linkedFormat = data(await graphql('mutation($collectionId: String!, $input: CollectionFormatInput!) { addCollectionFormat(collectionId: $collectionId, input: $input) { formats { id name fields { id name } } } }', { collectionId: shareTarget.id, input: { name: 'Linked sale', color: '#EDF9F3', fields: [{ name: 'Product', kind: 'OBJECT_REF', targetObjectFormatId: objectModel.id, variableName: 'product', referenceMode: 'CURRENT' }] } }, first.token)).addCollectionFormat.formats.find((item) => item.name === 'Linked sale');
  const linkedEntry = data(await graphql(createEntry, { id: shareTarget.id, input: { formatId: linkedFormat.id, values: [{ fieldId: linkedFormat.fields[0].id, value: JSON.stringify([firstObject.id]) }] } }, first.token)).createEntry;
  const linkedRefsQuery = 'query($entryId: String!) { entryObjectReferences(entryId: $entryId) { missing mode name properties { fieldId value } } }';
  const linkedRefs = data(await graphql(linkedRefsQuery, { entryId: linkedEntry.id }, first.token)).entryObjectReferences;
  assert.equal(linkedRefs[0].missing, false);
  assert.deepEqual(linkedRefs[0].properties.map((item) => item.fieldId), [nameField], 'only granted properties are readable');
  assert.ok((await graphql(variableQuery, { entryId: linkedEntry.id, variableName: 'product', propertyFieldId: weightField }, first.token)).errors?.length, 'linked variable cannot read an ungranted property');
  assert.ok((await graphql(linkedRefsQuery, { entryId: linkedEntry.id }, second.token)).errors?.length, 'another account cannot read the link');
  data(await graphql('mutation($id: String!, $input: SaveEntryInput!) { updateEntry(id: $id, input: $input) { id } }', { id: firstObject.id, input: { formatId: objectModel.id, values: [{ fieldId: nameField, value: 'Bottle renamed again' }, { fieldId: weightField, value: '0.70' }] } }, first.token));
  assert.equal(data(await graphql(linkedRefsQuery, { entryId: linkedEntry.id }, first.token)).entryObjectReferences[0].name, 'Bottle renamed again', 'current linked value follows source edits');
  const revokeMutation = 'mutation($targetCollectionId: String!, $grantId: String!) { revokeCollectionObjectShare(targetCollectionId: $targetCollectionId, grantId: $grantId) }';
  assert.equal(data(await graphql(revokeMutation, { targetCollectionId: shareTarget.id, grantId: grant.id }, first.token)).revokeCollectionObjectShare, true);
  assert.equal(data(await graphql(linkedRefsQuery, { entryId: linkedEntry.id }, first.token)).entryObjectReferences[0].missing, true, 'revocation cuts current reads');
  const snapshotGrant = data(await graphql(shareMutation, { objectId: firstObject.id, targetCollectionId: shareTarget.id, propertyFieldIds: [nameField], mode: 'SNAPSHOT' }, first.token)).shareCollectionObject;
  const frozenFormat = data(await graphql('mutation($collectionId: String!, $input: CollectionFormatInput!) { addCollectionFormat(collectionId: $collectionId, input: $input) { formats { id name fields { id } } } }', { collectionId: shareTarget.id, input: { name: 'Frozen link', color: '#FFF5EB', fields: [{ name: 'Product', kind: 'OBJECT_REF', targetObjectFormatId: objectModel.id, referenceMode: 'SNAPSHOT' }] } }, first.token)).addCollectionFormat.formats.find((item) => item.name === 'Frozen link');
  const frozenEntry = data(await graphql(createEntry, { id: shareTarget.id, input: { formatId: frozenFormat.id, values: [{ fieldId: frozenFormat.fields[0].id, value: JSON.stringify([firstObject.id]) }] } }, first.token)).createEntry;
  data(await graphql(revokeMutation, { targetCollectionId: shareTarget.id, grantId: snapshotGrant.id }, first.token));
  assert.equal(data(await graphql(linkedRefsQuery, { entryId: frozenEntry.id }, first.token)).entryObjectReferences[0].name, 'Bottle renamed again', 'revocation preserves a historical snapshot');
  const moveTarget = data(await graphql('mutation($input: CreateCollectionInput!) { createCollection(input: $input) { id } }', { input: { name: 'Move target', formats: [{ name: 'General', color: '#EEF5FF', fields: [{ name: 'Text', kind: 'TEXT' }] }] } }, first.token)).createCollection;
  collectionIds.push(moveTarget.id);
  const movePreviewQuery = 'query($objectId: String!, $targetCollectionId: String!) { objectMovePreview(objectId: $objectId, targetCollectionId: $targetCollectionId) { allowed inboundReferences activeShares conflicts entries } }';
  const blockedMove = data(await graphql(movePreviewQuery, { objectId: firstObject.id, targetCollectionId: moveTarget.id }, first.token)).objectMovePreview;
  assert.equal(blockedMove.allowed, false);
  assert.ok(blockedMove.inboundReferences > 0, 'move preview finds entries referencing the object');
  const movable = data(await graphql(createEntry, { id: objectCollection.id, input: { formatId: objectModel.id, values: [{ fieldId: nameField, value: 'Move me' }, { fieldId: weightField, value: '3' }] } }, first.token)).createEntry;
  assert.equal(data(await graphql(movePreviewQuery, { objectId: movable.id, targetCollectionId: moveTarget.id }, first.token)).objectMovePreview.allowed, true);
  const moved = data(await graphql('mutation($objectId: String!, $targetCollectionId: String!) { moveCollectionObject(objectId: $objectId, targetCollectionId: $targetCollectionId) { objectId operationId copiedEntries } }', { objectId: movable.id, targetCollectionId: moveTarget.id }, first.token)).moveCollectionObject;
  assert.notEqual(moved.objectId, movable.id);
  assert.ok((await graphql('query($id: String!) { collectionObject(id: $id) { id } }', { id: movable.id }, first.token)).errors?.length, 'source is removed only after target copy succeeds');
  assert.equal(data(await graphql('query($id: String!) { collectionObject(id: $id) { id } }', { id: moved.objectId }, first.token)).collectionObject.id, moved.objectId);
  assert.equal(data(await graphql('query($operationId: String!) { collectionMoveStatus(operationId: $operationId) { state } }', { operationId: moved.operationId }, first.token)).collectionMoveStatus.state, 'COMPLETE');
  assert.ok((await graphql('query($operationId: String!) { collectionMoveStatus(operationId: $operationId) { state } }', { operationId: moved.operationId }, second.token)).errors?.length, 'move journal belongs to owner');
  const recoverySource = data(await graphql(createEntry, { id: objectCollection.id, input: { formatId: objectModel.id, values: [{ fieldId: nameField, value: 'Recover me' }] } }, first.token)).createEntry;
  const recoveryKey = randomUUID();
  const recoveryId = new mongoose.Types.ObjectId();
  const recoveryTargetId = new mongoose.Types.ObjectId();
  const recoveryFormatId = randomUUID();
  await mongoose.connection.collection('entries').updateOne({ _id: new mongoose.Types.ObjectId(recoverySource.id) }, { $set: { movingOperationId: recoveryKey } });
  await mongoose.connection.collection('collections').updateOne({ _id: new mongoose.Types.ObjectId(moveTarget.id) }, { $push: { formats: { id: recoveryFormatId, name: 'Interrupted copy', color: '#FFF5EB', version: 1, objectModel: true, fields: [{ id: randomUUID(), name: 'Name', kind: 'TITLE' }] } } });
  await mongoose.connection.collection('entries').insertOne({ _id: recoveryTargetId, ownerId: first.user.id, collectionId: moveTarget.id, formatId: recoveryFormatId, transferKey: recoveryKey, values: [{ fieldId: randomUUID(), value: 'Temporary copy' }], createdAt: new Date(), updatedAt: new Date() });
  await mongoose.connection.collection('moveoperations').insertOne({ _id: recoveryId, ownerId: first.user.id, sourceCollectionId: objectCollection.id, targetCollectionId: moveTarget.id, sourceObjectId: recoverySource.id, transferKey: recoveryKey, state: 'COPIED', targetObjectId: recoveryTargetId.toString(), targetFormatIds: [recoveryFormatId], targetUnitIds: [], createdAt: new Date(Date.now() - 120000), updatedAt: new Date(Date.now() - 120000) });
  assert.equal(data(await graphql('mutation($operationId: String!) { recoverCollectionMove(operationId: $operationId) { state } }', { operationId: recoveryId.toString() }, first.token)).recoverCollectionMove.state, 'ROLLED_BACK');
  assert.equal((await mongoose.connection.collection('entries').findOne({ _id: new mongoose.Types.ObjectId(recoverySource.id) })).movingOperationId, undefined, 'recovery unlocks the source');
  assert.equal(await mongoose.connection.collection('entries').countDocuments({ _id: recoveryTargetId }), 0, 'recovery removes partial copy');
  assert.equal((await mongoose.connection.collection('collections').findOne({ _id: new mongoose.Types.ObjectId(moveTarget.id) })).formats.some((item) => item.id === recoveryFormatId), false, 'recovery removes copied format');
  const formatLinkSource = data(await graphql('mutation($input: CreateCollectionInput!) { createCollection(input: $input) { id formats { id version fields { id name kind } } } }', { input: { name: 'Linked format source', formats: [{ name: 'Tasks', color: '#EDF9F3', fields: [{ name: 'Task', kind: 'TITLE' }, { name: 'Notes', kind: 'TEXT' }] }] } }, first.token)).createCollection;
  const formatLinkTarget = data(await graphql('mutation($input: CreateCollectionInput!) { createCollection(input: $input) { id } }', { input: { name: 'Linked format target', formats: [{ name: 'General', color: '#EEF5FF', fields: [{ name: 'Text', kind: 'TEXT' }] }] } }, first.token)).createCollection;
  collectionIds.push(formatLinkSource.id, formatLinkTarget.id);
  const sourceTaskFormat = formatLinkSource.formats[0];
  const linkedFormatId = data(await graphql('mutation($formatId: String!, $targetCollectionId: String!) { linkCollectionDataFormat(formatId: $formatId, targetCollectionId: $targetCollectionId) { dataFormatId } }', { formatId: sourceTaskFormat.id, targetCollectionId: formatLinkTarget.id }, first.token)).linkCollectionDataFormat.dataFormatId;
  const targetLinkedFormat = data(await graphql('query { collectionsList { id formats { id version linkedSource { sourceFormatId acceptedVersion } fields { id name sourceFieldId } } } }', {}, first.token)).collectionsList.find((item) => item.id === formatLinkTarget.id).formats.find((item) => item.id === linkedFormatId);
  assert.notEqual(targetLinkedFormat.fields[0].id, sourceTaskFormat.fields[0].id, 'linked format has independent field IDs');
  assert.equal(targetLinkedFormat.linkedSource.acceptedVersion, 1);
  const targetTask = data(await graphql(createEntry, { id: formatLinkTarget.id, input: { formatId: linkedFormatId, values: [{ fieldId: targetLinkedFormat.fields[0].id, value: 'Read' }, { fieldId: targetLinkedFormat.fields[1].id, value: 'Before lunch' }] } }, first.token)).createEntry;
  const laterTargetTask = data(await graphql(createEntry, { id: formatLinkTarget.id, input: { formatId: linkedFormatId, values: [{ fieldId: targetLinkedFormat.fields[0].id, value: 'Read more' }] } }, first.token)).createEntry;
  const updateSourceFormat = 'mutation($collectionId: String!, $formatId: String!, $input: UpdateCollectionFormatInput!) { updateCollectionFormat(collectionId: $collectionId, formatId: $formatId, input: $input) { formats { id version fields { id name kind } } } }';
  const updatedSourceTask = data(await graphql(updateSourceFormat, { collectionId: formatLinkSource.id, formatId: sourceTaskFormat.id, input: { name: 'Tasks', expectedVersion: 1, fields: [{ id: sourceTaskFormat.fields[0].id, name: 'Task', kind: 'TITLE' }, { id: sourceTaskFormat.fields[1].id, name: 'Description', kind: 'TEXT' }, { name: 'Priority', kind: 'NUMBER' }] } }, first.token)).updateCollectionFormat.formats.find((item) => item.id === sourceTaskFormat.id);
  const linkPreviewQuery = 'query($targetCollectionId: String!, $targetFormatId: String!) { linkedDataFormatUpdatePreview(targetCollectionId: $targetCollectionId, targetFormatId: $targetFormatId) { allowed sourceVersion acceptedVersion addedFields changedFields conflicts } }';
  const linkPreview = data(await graphql(linkPreviewQuery, { targetCollectionId: formatLinkTarget.id, targetFormatId: linkedFormatId }, first.token)).linkedDataFormatUpdatePreview;
  assert.equal(linkPreview.allowed, true);
  assert.deepEqual(linkPreview.addedFields, ['Priority']);
  const acceptedLink = data(await graphql('mutation($targetCollectionId: String!, $targetFormatId: String!, $expectedSourceVersion: Int!) { acceptLinkedDataFormatVersion(targetCollectionId: $targetCollectionId, targetFormatId: $targetFormatId, expectedSourceVersion: $expectedSourceVersion) { formats { id version linkedSource { acceptedVersion targetVersion } fields { id name sourceFieldId } } } }', { targetCollectionId: formatLinkTarget.id, targetFormatId: linkedFormatId, expectedSourceVersion: updatedSourceTask.version }, first.token)).acceptLinkedDataFormatVersion.formats.find((item) => item.id === linkedFormatId);
  assert.equal(acceptedLink.linkedSource.acceptedVersion, 2);
  assert.equal(acceptedLink.fields.find((item) => item.name === 'Description').id, targetLinkedFormat.fields[1].id, 'existing field identity stays stable');
  assert.equal(data(await graphql('query($collectionId: String!) { collectionEntries(collectionId: $collectionId) { id values { value } } }', { collectionId: formatLinkTarget.id }, first.token)).collectionEntries.find((item) => item.id === targetTask.id).values[1].value, 'Before lunch', 'target entry remains readable');
  data(await graphql(updateSourceFormat, { collectionId: formatLinkSource.id, formatId: sourceTaskFormat.id, input: { name: 'Tasks', expectedVersion: 2, fields: [{ id: sourceTaskFormat.fields[0].id, name: 'Task', kind: 'TITLE' }, { id: sourceTaskFormat.fields[1].id, name: 'Description', kind: 'NUMBER' }, { id: updatedSourceTask.fields[2].id, name: 'Priority', kind: 'NUMBER' }] } }, first.token));
  assert.equal(data(await graphql(linkPreviewQuery, { targetCollectionId: formatLinkTarget.id, targetFormatId: linkedFormatId }, first.token)).linkedDataFormatUpdatePreview.allowed, false, 'source change cannot alter populated target field type');
  assert.ok((await graphql('mutation($targetCollectionId: String!, $targetFormatId: String!, $expectedSourceVersion: Int!) { acceptLinkedDataFormatVersion(targetCollectionId: $targetCollectionId, targetFormatId: $targetFormatId, expectedSourceVersion: $expectedSourceVersion) { id } }', { targetCollectionId: formatLinkTarget.id, targetFormatId: linkedFormatId, expectedSourceVersion: 3 }, first.token)).errors?.length);
  assert.ok((await graphql('mutation($targetCollectionId: String!, $targetFormatId: String!) { detachLinkedDataFormat(targetCollectionId: $targetCollectionId, targetFormatId: $targetFormatId) { id } }', { targetCollectionId: formatLinkTarget.id, targetFormatId: linkedFormatId }, second.token)).errors?.length, 'another account cannot detach a linked format');
  data(await graphql('mutation($targetCollectionId: String!, $targetFormatId: String!) { detachLinkedDataFormat(targetCollectionId: $targetCollectionId, targetFormatId: $targetFormatId) { id formats { id linkedSource { sourceFormatId } } } }', { targetCollectionId: formatLinkTarget.id, targetFormatId: linkedFormatId }, first.token));
  const saveView = 'mutation($collectionId: String!, $input: SavedCollectionViewInput!, $viewId: String) { saveCollectionView(collectionId: $collectionId, input: $input, viewId: $viewId) { savedViews { id name layout formatIds columnFieldIds sort } } }';
  const viewInput = { name: 'Tasks table', layout: 'TABLE', formatIds: [linkedFormatId], columnFieldIds: [targetLinkedFormat.fields[0].id], search: 'Read', sort: 'OLDEST', groupByFormat: false };
  const savedView = data(await graphql(saveView, { collectionId: formatLinkTarget.id, input: viewInput }, first.token)).saveCollectionView.savedViews[0];
  assert.equal(savedView.layout, 'TABLE');
  const viewPage = 'query($collectionId: String!, $viewId: String) { collectionEntriesPage(collectionId: $collectionId, viewId: $viewId, first: 1) { entries { id } nextCursor } }';
  const oldestPage = data(await graphql(viewPage, { collectionId: formatLinkTarget.id, viewId: savedView.id }, first.token)).collectionEntriesPage;
  assert.equal(oldestPage.entries[0].id, targetTask.id);
  assert.ok(oldestPage.nextCursor);
  assert.equal(data(await graphql('query($collectionId: String!, $viewId: String, $after: String) { collectionEntriesPage(collectionId: $collectionId, viewId: $viewId, after: $after, first: 1) { entries { id } } }', { collectionId: formatLinkTarget.id, viewId: savedView.id, after: oldestPage.nextCursor }, first.token)).collectionEntriesPage.entries[0].id, laterTargetTask.id, 'oldest-first paging uses the saved view order');
  assert.ok((await graphql(viewPage, { collectionId: formatLinkTarget.id, viewId: savedView.id }, second.token)).errors?.length, 'view stays private to its owner');
  assert.ok((await graphql(saveView, { collectionId: formatLinkTarget.id, input: { ...viewInput, columnFieldIds: ['foreign'] } }, first.token)).errors?.length, 'view cannot point to a foreign field');
  assert.equal(data(await graphql('mutation($collectionId: String!, $viewId: String!) { deleteCollectionView(collectionId: $collectionId, viewId: $viewId) { savedViews { id } } }', { collectionId: formatLinkTarget.id, viewId: savedView.id }, first.token)).deleteCollectionView.savedViews.length, 0);
  const timeCollection = data(await graphql('mutation($input: CreateCollectionInput!) { createCollection(input: $input) { id formats { id fields { id name } } } }', { input: { name: 'Time views', formats: [
    { name: 'Tasks', color: '#EEF5FF', fields: [{ name: 'Title', kind: 'TITLE' }, { name: 'Done', kind: 'BOOLEAN' }, { name: 'Due', kind: 'DATE' }, { name: 'Completed', kind: 'DATETIME' }, { name: 'Priority', kind: 'SELECT', options: ['Low', 'High'] }] },
    { name: 'Events', color: '#EDF9F3', fields: [{ name: 'Title', kind: 'TITLE' }, { name: 'Start', kind: 'DATETIME' }, { name: 'End', kind: 'DATETIME' }] },
  ] } }, first.token)).createCollection;
  collectionIds.push(timeCollection.id);
  const taskFormat = timeCollection.formats[0], eventFormat = timeCollection.formats[1];
  const taskField = (name) => taskFormat.fields.find((item) => item.name === name).id;
  const eventField = (name) => eventFormat.fields.find((item) => item.name === name).id;
  const taskView = data(await graphql(saveView, { collectionId: timeCollection.id, input: { name: 'My tasks', layout: 'TASKS', formatIds: [taskFormat.id], columnFieldIds: [], search: '', sort: 'NEWEST', groupByFormat: false, taskDoneFieldId: taskField('Done'), taskCompletedFieldId: taskField('Completed'), taskDueFieldId: taskField('Due'), taskPriorityFieldId: taskField('Priority') } }, first.token)).saveCollectionView.savedViews[0];
  const task = data(await graphql(createEntry, { id: timeCollection.id, input: { formatId: taskFormat.id, values: [{ fieldId: taskField('Title'), value: 'Undated task' }] } }, first.token)).createEntry;
  const reminderCapabilities = data(await graphql('query { reminderCapabilities { email push } }', {}, first.token)).reminderCapabilities;
  assert.equal(typeof reminderCapabilities.email, 'boolean');
  assert.equal(typeof reminderCapabilities.push, 'boolean');
  assert.ok((await graphql('query($entryId: String!) { entryReminders(entryId: $entryId) { id } }', { entryId: task.id }, second.token)).errors?.length, 'other account cannot read reminders');
  const pendingTaskReminder = new mongoose.Types.ObjectId();
  await mongoose.connection.collection('entryreminders').insertOne({ _id: pendingTaskReminder, ownerId: first.user.id, collectionId: timeCollection.id, entryId: task.id, fieldId: taskField('Due'), timeZone: 'UTC', minutesBefore: 0, channels: ['EMAIL'], state: 'ACTIVE', nextAt: new Date('2099-01-01T09:00:00Z'), occurrenceAt: new Date('2099-01-01T09:00:00Z') });
  const doneTask = data(await graphql('mutation($collectionId: String!, $viewId: String!, $entryId: String!, $done: Boolean!) { setCollectionTaskCompleted(collectionId: $collectionId, viewId: $viewId, entryId: $entryId, done: $done) { id values { fieldId value } createdAt } }', { collectionId: timeCollection.id, viewId: taskView.id, entryId: task.id, done: true }, first.token)).setCollectionTaskCompleted;
  assert.equal((await mongoose.connection.collection('entryreminders').findOne({ _id: pendingTaskReminder })).state, 'CANCELLED', 'completing a task cancels its reminders');
  assert.equal(doneTask.values.find((item) => item.fieldId === taskField('Done')).value, 'true');
  assert.ok(doneTask.values.find((item) => item.fieldId === taskField('Completed')).value.includes('T'));
  assert.ok((await graphql('mutation($collectionId: String!, $viewId: String!, $entryId: String!, $done: Boolean!) { setCollectionTaskCompleted(collectionId: $collectionId, viewId: $viewId, entryId: $entryId, done: $done) { id } }', { collectionId: timeCollection.id, viewId: taskView.id, entryId: task.id, done: false }, second.token)).errors?.length);
  const calendarView = data(await graphql(saveView, { collectionId: timeCollection.id, input: { name: 'My calendar', layout: 'CALENDAR', formatIds: [eventFormat.id], columnFieldIds: [], search: '', sort: 'NEWEST', groupByFormat: false, calendarStartFieldId: eventField('Start'), calendarEndFieldId: eventField('End'), calendarTimeZone: 'America/New_York' } }, first.token)).saveCollectionView.savedViews[1];
  const event = data(await graphql(createEntry, { id: timeCollection.id, input: { formatId: eventFormat.id, values: [{ fieldId: eventField('Title'), value: 'Weekly meeting' }, { fieldId: eventField('Start'), value: '2026-03-01T14:00:00Z' }, { fieldId: eventField('End'), value: '2026-03-01T15:00:00Z' }] } }, first.token)).createEntry;
  const setRecurrence = 'mutation($collectionId: String!, $viewId: String!, $entryId: String!, $input: EntryRecurrenceInput) { setCollectionEntryRecurrence(collectionId: $collectionId, viewId: $viewId, entryId: $entryId, input: $input) { id recurrence { excludedDates } } }';
  data(await graphql(setRecurrence, { collectionId: timeCollection.id, viewId: calendarView.id, entryId: event.id, input: { timeZone: 'America/New_York', frequency: 'WEEKLY', interval: 1, excludedDates: ['2026-03-15'] } }, first.token));
  const occurrenceQuery = 'query($collectionId: String!, $viewId: String!, $from: String!, $to: String!) { collectionCalendarOccurrences(collectionId: $collectionId, viewId: $viewId, from: $from, to: $to) { startAt localDate localStartClock timeZone } }';
  const occurrences = data(await graphql(occurrenceQuery, { collectionId: timeCollection.id, viewId: calendarView.id, from: '2026-03-08T00:00:00Z', to: '2026-03-20T00:00:00Z' }, first.token)).collectionCalendarOccurrences;
  assert.deepEqual(occurrences.map((item) => item.localDate), ['2026-03-08'], 'exception skips March 15');
  assert.equal(occurrences[0].startAt, '2026-03-08T13:00:00.000Z', 'weekly time follows daylight saving');
  assert.equal(occurrences[0].localStartClock, '09:00');
  assert.ok((await graphql(occurrenceQuery, { collectionId: timeCollection.id, viewId: calendarView.id, from: '2026-03-08T00:00:00Z', to: '2026-03-20T00:00:00Z' }, second.token)).errors?.length);
  const eventCopyTarget = data(await graphql('mutation($input: CreateCollectionInput!) { createCollection(input: $input) { id } }', { input: { name: 'Copied events', formats: [{ name: 'General', color: '#EEF5FF', fields: [{ name: 'Text', kind: 'TEXT' }] }] } }, first.token)).createCollection;
  collectionIds.push(eventCopyTarget.id);
  data(await graphql('mutation($formatId: String!, $targetCollectionId: String!, $withEntries: Boolean!) { copyCollectionDataFormat(formatId: $formatId, targetCollectionId: $targetCollectionId, withEntries: $withEntries) { copiedEntries } }', { formatId: eventFormat.id, targetCollectionId: eventCopyTarget.id, withEntries: true }, first.token));
  const copiedEventCollection = data(await graphql('query { collectionsList { id formats { id fields { id name } } } }', {}, first.token)).collectionsList.find((item) => item.id === eventCopyTarget.id);
  const copiedEvent = data(await graphql('query($collectionId: String!) { collectionEntries(collectionId: $collectionId) { id recurrence { startFieldId endFieldId frequency excludedDates } } }', { collectionId: eventCopyTarget.id }, first.token)).collectionEntries[0];
  assert.equal(copiedEvent.recurrence.startFieldId, copiedEventCollection.formats.find((item) => item.id !== copiedEventCollection.formats[0].id).fields.find((item) => item.name === 'Start').id, 'copy remaps recurrence fields');
  const catalog = data(await graphql('mutation($collectionId: String!, $input: CollectionFormatInput!) { addCollectionFormat(collectionId: $collectionId, input: $input) { formats { id name version objectModel fields { id name } } } }', { collectionId: objectCollection.id, input: { name: 'Catalog', color: '#FFF5EB', fields: [{ name: 'Name', kind: 'TITLE' }, { name: 'Description', kind: 'TEXT' }] } }, first.token)).addCollectionFormat.formats.find((item) => item.name === 'Catalog');
  data(await graphql(createEntry, { id: objectCollection.id, input: { formatId: catalog.id, values: [{ fieldId: catalog.fields[0].id, value: 'Existing item' }] } }, first.token));
  const markObjectModel = 'mutation($collectionId: String!, $formatId: String!, $expectedVersion: Int!, $expectedEntryCount: Int) { setCollectionFormatObjectModel(collectionId: $collectionId, formatId: $formatId, enabled: true, expectedVersion: $expectedVersion, expectedEntryCount: $expectedEntryCount) { formats { id objectModel version } } }';
  const conversion = { collectionId: objectCollection.id, formatId: catalog.id, expectedVersion: catalog.version };
  assert.ok((await graphql(markObjectModel, conversion, first.token)).errors?.length, 'existing entries cannot silently become objects');
  assert.ok((await graphql(markObjectModel, { ...conversion, expectedEntryCount: 2 }, first.token)).errors?.length, 'confirmation must use the current entry count');
  const converted = data(await graphql(markObjectModel, { ...conversion, expectedEntryCount: 1 }, first.token)).setCollectionFormatObjectModel;
  assert.equal(converted.formats.find((item) => item.id === catalog.id).objectModel, true);
  assert.equal(data(await graphql(objectPage, { collectionId: objectCollection.id, formatId: catalog.id }, first.token)).collectionObjectsPage.entries.length, 1);
  const mixed = data(await graphql('mutation($collectionId: String!, $input: CollectionFormatInput!) { addCollectionFormat(collectionId: $collectionId, input: $input) { formats { id name version fields { id name } } } }', { collectionId: objectCollection.id, input: { name: 'Mixed', color: '#F4F0FF', fields: [{ name: 'Name', kind: 'TITLE' }, { name: 'Note', kind: 'TEXT' }] } }, first.token)).addCollectionFormat.formats.find((item) => item.name === 'Mixed');
  data(await graphql(createEntry, { id: objectCollection.id, input: { formatId: mixed.id, values: [{ fieldId: mixed.fields[1].id, value: 'Unnamed note' }] } }, first.token));
  assert.ok((await graphql(markObjectModel, { collectionId: objectCollection.id, formatId: mixed.id, expectedVersion: mixed.version, expectedEntryCount: 1 }, first.token)).errors?.length, 'notes without a title cannot be converted to objects');
  const legacyTitled = data(await graphql('mutation($collectionId: String!, $input: CollectionFormatInput!) { addCollectionFormat(collectionId: $collectionId, input: $input) { formats { id name version fields { id } } } }', { collectionId: objectCollection.id, input: { name: 'Legacy titles', color: '#FFF0F4', fields: [{ name: 'Name', kind: 'TITLE' }] } }, first.token)).addCollectionFormat.formats.find((item) => item.name === 'Legacy titles');
  await mongoose.connection.collection('entries').insertOne({ ownerId: first.user.id, collectionId: objectCollection.id, formatId: legacyTitled.id, values: [{ fieldId: legacyTitled.fields[0].id, value: '   ' }], createdAt: new Date(), updatedAt: new Date() });
  assert.ok((await graphql(markObjectModel, { collectionId: objectCollection.id, formatId: legacyTitled.id, expectedVersion: legacyTitled.version, expectedEntryCount: 1 }, first.token)).errors?.length, 'legacy whitespace-only titles cannot become object names');
  const copiedCollection = data(await graphql('mutation($input: CreateCollectionInput!) { createCollection(input: $input) { id exchangeRates { from to rate } formats { id name fields { id } } } }', { input: { name: 'Imported objects', exchangeRates: [{ from: 'EUR', to: 'USD', rate: '1.2', effectiveAt: '2026-01-01T00:00:00Z' }], formats: [
    { name: 'Product', color: '#EDF9F3', objectModel: true, fields: [{ name: 'Name', kind: 'TITLE' }] },
    { name: 'Notes', color: '#EEF5FF', fields: [{ name: 'Text', kind: 'LONG_TEXT' }] },
  ] } }, first.token)).createCollection;
  collectionIds.push(copiedCollection.id);
  assert.equal(copiedCollection.exchangeRates[0].rate, '1.2', 'structured import keeps dated exchange rates');
  const importedProduct = copiedCollection.formats.find((item) => item.name === 'Product');
  const importedNote = copiedCollection.formats.find((item) => item.name === 'Notes');
  const importKey = `object-links-${suffix}`;
  data(await graphql(importMutation, { collectionId: copiedCollection.id, input: { formatId: importedProduct.id, importKey, dryRun: false, rows: [{ sourceId: 'source-product', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z', values: [{ fieldId: importedProduct.fields[0].id, value: 'Bottle' }] }] } }, first.token));
  data(await graphql(importMutation, { collectionId: copiedCollection.id, input: { formatId: importedNote.id, importKey, dryRun: false, rows: [{ sourceId: 'source-note', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z', values: [{ fieldId: importedNote.fields[0].id, value: 'Name: Bottle' }] }] } }, first.token));
  const linkMutation = 'mutation($collectionId: String!, $importKey: String!, $links: [ImportObjectLinkInput!]!) { linkImportedObjects(collectionId: $collectionId, importKey: $importKey, links: $links) }';
  const links = [{ sourceId: 'source-note', sourceObjectId: 'source-product' }];
  assert.equal(data(await graphql(linkMutation, { collectionId: copiedCollection.id, importKey, links }, first.token)).linkImportedObjects, true);
  assert.ok((await graphql(linkMutation, { collectionId: copiedCollection.id, importKey, links }, second.token)).errors?.length, 'other account cannot restore object links');
  const restoredProduct = await mongoose.connection.collection('entries').findOne({ ownerId: first.user.id, collectionId: copiedCollection.id, importKey, sourceId: 'source-product' });
  const restoredNote = await mongoose.connection.collection('entries').findOne({ ownerId: first.user.id, collectionId: copiedCollection.id, importKey, sourceId: 'source-note' });
  assert.equal(restoredNote.sourceObjectId, restoredProduct._id.toString(), 'import remaps source ID to new object ID');
  assert.equal(data(await graphql(linkMutation, { collectionId: copiedCollection.id, importKey, links }, first.token)).linkImportedObjects, true, 'link restoration can resume');
  console.log('Legacy migration, formats, typed values, pagination, import safety, units, objects, snapshots, transfers, saved views, calendar, task reminder cancellation, and account isolation passed.');
} finally {
  try {
    if (collectionIds.length) {
      await mongoose.connection.collection('entries').deleteMany({ collectionId: { $in: collectionIds } });
      await mongoose.connection.collection('collections').deleteMany({
        _id: { $in: collectionIds.map((id) => new mongoose.Types.ObjectId(id)) },
      });
      await mongoose.connection.collection('moveoperations').deleteMany({ ownerId: { $in: userIds } });
      await mongoose.connection.collection('entryreminders').deleteMany({ ownerId: { $in: userIds } });
      await mongoose.connection.collection('reminderdeliveries').deleteMany({ ownerId: { $in: userIds } });
    }
    if (userIds.length) {
      await mongoose.connection.collection('users').deleteMany({
        _id: { $in: userIds.map((id) => new mongoose.Types.ObjectId(id)) },
      });
    }
  } finally {
    await mongoose.disconnect();
  }
}
