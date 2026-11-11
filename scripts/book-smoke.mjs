import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// T47: Book template, single-entry rule, allowed parents and book view settings.
const url = process.env.API_URL || `http://localhost:${process.env.PORT || 3000}/graphql`;
let token;
async function gql(query, variables = {}, expectError = false) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
  const body = await response.json();
  if (expectError) { assert.ok(body.errors?.length, 'expected a rejection'); return body.errors[0].message; }
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  return body.data;
}

const registered = await gql('mutation($input:RegisterInput!) { register(input:$input) { token } }', { input: { name: 'Book Tester', email: `book-${randomUUID()}@example.test`, password: 'temporary-test-password' } });
token = registered.register.token;
const created = (await gql('mutation { createCollectionFromTemplate(templateId:"book",name:"My novel",language:"fr") { id templateId formats { id name singleEntry parentFormatIds fields { id kind } } bookView { enabled pageSize fontSize roles { formatId role } } } }')).createCollectionFromTemplate;
const collectionId = created.id;
try {
  assert.equal(created.templateId, 'book');
  assert.equal(created.formats.length, 17);
  assert.equal(created.bookView.enabled, true);
  const byRole = Object.fromEntries(created.bookView.roles.map((item) => [item.role, created.formats.find((format) => format.id === item.formatId)]));
  assert.equal(byRole.PREFACE.singleEntry, true);
  assert.equal(byRole.CHAPTER.singleEntry, false);
  assert.deepEqual(byRole.CHAPTER.parentFormatIds, [byRole.PART.id]);
  assert.deepEqual(byRole.SECTION.parentFormatIds, [byRole.CHAPTER.id]);

  const entry = async (format, title) => (await gql('mutation($id:String!,$input:SaveEntryInput!) { createEntry(collectionId:$id,input:$input) { id } }', { id: collectionId, input: { formatId: format.id, values: [{ fieldId: format.fields.find((field) => ['TITLE', 'LONG_TEXT'].includes(field.kind)).id, value: title }] } })).createEntry.id;
  await entry(byRole.PREFACE, 'Préface');
  const refusal = await gql('mutation($id:String!,$input:SaveEntryInput!) { createEntry(collectionId:$id,input:$input) { id } }', { id: collectionId, input: { formatId: byRole.PREFACE.id, values: [{ fieldId: byRole.PREFACE.fields[0].id, value: 'Seconde préface' }] } }, true);
  assert.match(refusal, /only have one entry/);

  const part = await entry(byRole.PART, 'Première partie');
  const chapter = await entry(byRole.CHAPTER, 'Chapitre 1');
  const section = await entry(byRole.SECTION, 'Section 1.1');
  const relate = (from, to, expectError) => gql('mutation($id:String!,$from:String!,$to:String!) { createCollectionRelation(collectionId:$id,fromEntryId:$from,toEntryId:$to,kind:PARENT) { id } }', { id: collectionId, from, to }, expectError);
  await relate(chapter, part);
  assert.match(await relate(section, part, true), /can only be placed under/);
  await relate(section, chapter);
  const relations = (await gql('query($id:String!) { collectionParentRelations(collectionId:$id) { fromEntryId toEntryId } }', { id: collectionId })).collectionParentRelations;
  assert.equal(relations.length, 2);

  const settings = { enabled: true, bodyFont: 'GARAMOND', headingFont: 'SANS', fontSize: 18, lineHeight: 1.8, paragraphSpacing: 1, firstLineIndent: 2, marginMm: 25, textAlign: 'LEFT', pageSize: 'A4', showRuler: false, chapterOnNewPage: true };
  const saved = (await gql('mutation($id:String!,$input:BookViewSettingsInput!) { setBookView(collectionId:$id,input:$input) { bookView { bodyFont fontSize pageSize roles { role } } } }', { id: collectionId, input: settings })).setBookView.bookView;
  assert.equal(saved.bodyFont, 'GARAMOND');
  assert.equal(saved.roles.length, 17, 'roles survive a settings change');
  assert.match(await gql('mutation($id:String!,$input:BookViewSettingsInput!) { setBookView(collectionId:$id,input:$input) { id } }', { id: collectionId, input: { ...settings, fontSize: 99 } }, true), /Invalid book view/);

  await entry(byRole.PART, 'Deuxième partie');
  assert.match(await gql('mutation($id:String!,$formatId:String!) { setFormatEntryRules(collectionId:$id,formatId:$formatId,singleEntry:true,parentFormatIds:[]) { id } }', { id: collectionId, formatId: byRole.PART.id }, true), /several entries/);
  const rules = (await gql('mutation($id:String!,$formatId:String!,$parents:[String!]!) { setFormatEntryRules(collectionId:$id,formatId:$formatId,singleEntry:false,parentFormatIds:$parents) { formats { id parentFormatIds } } }', { id: collectionId, formatId: byRole.SECTION.id, parents: [byRole.CHAPTER.id, byRole.PART.id] })).setFormatEntryRules;
  assert.equal(rules.formats.find((item) => item.id === byRole.SECTION.id).parentFormatIds.length, 2);
  const plain = (await gql('mutation { createCollectionFromTemplate(templateId:"notes",name:"Notes",language:"en") { id } }')).createCollectionFromTemplate.id;
  assert.match(await gql('mutation($id:String!,$input:BookViewSettingsInput!) { setBookView(collectionId:$id,input:$input) { id } }', { id: plain, input: settings }, true), /Book template/);
  await gql('mutation($id:String!) { deleteCollection(id:$id) }', { id: plain });
  console.log('BOOK_SMOKE_PASSED');
} finally {
  await gql('mutation($id:String!) { deleteCollection(id:$id) }', { id: collectionId });
}
