// T39/1 and T39/3: referential imports and large code lists, against a running API.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

const url = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 3000}/graphql`;
assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI for cleanup');
await mongoose.connect(process.env.MONGODB_URI);
const graphql = async (query, variables = {}, token) => (await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) })).json());
const data = (result) => { assert.equal(result.errors, undefined, JSON.stringify(result.errors)); return result.data; };
const fails = (result, pattern, what) => assert.match(result.errors?.[0]?.message ?? '', pattern, `${what}: ${JSON.stringify(result.errors ?? result.data)}`);
const LISTS = 'codeLists { id name version external codeCount levels codes { code } }';
let userId;

// 6,000 codes on three levels: 10 regions, 100 departments, 5,890 towns, with accents and semicolons.
const rows = ['code;label_fr;label_en;parent_code'];
for (let r = 1; r <= 10; r++) rows.push(`R${r};Région ${r};Region ${r};`);
for (let d = 1; d <= 100; d++) rows.push(`D${d};Département ${d};Department ${d};R${((d - 1) % 10) + 1}`);
for (let t = 1; t <= 5890; t++) rows.push(`T${t};Commune Évry ${t};Town ${t};D${((t - 1) % 100) + 1}`);
const csv = rows.join('\n');

try {
  const account = data(await graphql('mutation($input:RegisterInput!){register(input:$input){token user{id}}}', { input: { name: 'Referentials', email: `referential-${randomUUID()}@example.test`, password: 'test-password-123' } })).register;
  userId = account.user.id;
  const token = account.token;
  const collection = data(await graphql(`mutation($input:CreateCollectionInput!){createCollection(input:$input){id ${LISTS}}}`, { input: { name: 'Territoires', formats: [{ name: 'Notes', color: '#EEF5FF', fields: [{ name: 'Title', kind: 'TITLE' }] }] } }, token)).createCollection;

  // Preview, then import of a large list.
  const preview = data(await graphql('query($f:String!,$c:String!){previewReferential(format:$f,content:$c){codeCount levels large errors{row message} sample{code labelFr parentCode}}}', { f: 'CSV', c: csv }, token)).previewReferential;
  assert.deepEqual([preview.codeCount, preview.levels, preview.large, preview.errors.length], [6000, 3, true, 0]);
  const broken = data(await graphql('query($f:String!,$c:String!){previewReferential(format:$f,content:$c){errors{row message}}}', { f: 'CSV', c: 'code,label\nA,Alpha\nA,Again\nB,Beta,missing' }, token)).previewReferential;
  assert.ok(broken.errors.some((item) => /Repeated code A/.test(item.message) && item.row === 3), JSON.stringify(broken));
  const IMPORT = `mutation($c:String!,$n:String!,$f:String!,$t:String!,$l:String,$v:Int){importReferential(collectionId:$c,name:$n,format:$f,content:$t,listId:$l,expectedVersion:$v){${LISTS}}}`;
  const imported = data(await graphql(IMPORT, { c: collection.id, n: 'Communes', f: 'CSV', t: csv }, token)).importReferential;
  const large = imported.codeLists.find((item) => item.name === 'Communes');
  assert.deepEqual([large.external, large.codeCount, large.levels, large.codes.length], [true, 6000, 3, 0], 'the collection never carries the 6,000 codes');

  // Search: accents ignored, at most 50, with the path of ancestors; then browsing children.
  const SEARCH = 'query($c:String!,$l:String!,$q:String,$p:String,$lang:String){searchClassificationCodes(collectionId:$c,listId:$l,query:$q,parentCode:$p,language:$lang){code label path level active hasChildren}}';
  const found = data(await graphql(SEARCH, { c: collection.id, l: large.id, q: 'evry 589', lang: 'fr' }, token)).searchClassificationCodes;
  assert.ok(found.length > 0 && found.length <= 50 && found.every((item) => /589/.test(item.code)), JSON.stringify(found.slice(0, 3)));
  const town = found.find((item) => item.code === 'T5890');
  assert.deepEqual(town.path, ['Région 10', 'Département 90']);
  assert.equal(town.level, 3);
  const roots = data(await graphql(SEARCH, { c: collection.id, l: large.id }, token)).searchClassificationCodes;
  assert.deepEqual(roots.map((item) => item.code), Array.from({ length: 10 }, (_, index) => `R${index + 1}`), 'natural order: R2 before R10');
  assert.ok(roots.every((item) => item.level === 1 && item.hasChildren));
  const children = data(await graphql(SEARCH, { c: collection.id, l: large.id, p: 'R1', lang: 'en' }, token)).searchClassificationCodes;
  assert.ok(children.length === 10 && children.every((item) => item.path[0] === 'Region 1'), JSON.stringify(children.slice(0, 2)));

  // Entries use the large list like any other.
  const withField = data(await graphql('mutation($c:String!,$input:CollectionFormatInput!){addCollectionFormat(collectionId:$c,input:$input){formats{id name fields{id name}}}}', { c: collection.id, input: { name: 'Visites', color: '#EAF8FA', fields: [{ name: 'Lieu', kind: 'TITLE' }, { name: 'Commune', kind: 'CODE', codeListId: large.id }, { name: 'Montant', kind: 'NUMBER' }] } }, token)).addCollectionFormat;
  const visits = withField.formats.find((item) => item.name === 'Visites');
  const field = Object.fromEntries(visits.fields.map((item) => [item.name, item.id]));
  const ADD = 'mutation($c:String!,$input:SaveEntryInput!){createEntry(collectionId:$c,input:$input){id}}';
  for (const [index, code] of ['T1', 'T11', 'T2'].entries()) data(await graphql(ADD, { c: collection.id, input: { formatId: visits.id, values: [{ fieldId: field.Lieu, value: `Visite ${index}` }, { fieldId: field.Commune, value: code }, { fieldId: field.Montant, value: '10' }] } }, token));
  fails(await graphql(ADD, { c: collection.id, input: { formatId: visits.id, values: [{ fieldId: field.Lieu, value: 'Inconnue' }, { fieldId: field.Commune, value: 'T999999' }] } }, token), /needs an active code/, 'an unknown code is refused');
  const labels = data(await graphql('query($c:String!,$l:String!,$codes:[String!]!){classificationCodesByValue(collectionId:$c,listId:$l,codes:$codes){code labelFr}}', { c: collection.id, l: large.id, codes: ['T1', 'T2'] }, token)).classificationCodesByValue;
  assert.deepEqual(labels.map((item) => item.labelFr).sort(), ['Commune Évry 1', 'Commune Évry 2']);

  // Grouping by the first level reads the ancestors from the stored codes.
  const analysis = data(await graphql('query($c:String!,$input:AnalysisInput!){analyseCollection(collectionId:$c,input:$input){rows{group label value count}}}', { c: collection.id, input: { formatId: visits.id, fieldId: field.Montant, operation: 'SUM', groupBy: 'CATEGORY', groupFieldId: field.Commune, groupDepth: 0, measureKind: 'EVENT', language: 'fr' } }, token)).analyseCollection;
  assert.deepEqual(analysis.rows.map((row) => [row.group, row.count]).sort(), [['R1', 2], ['R2', 1]], JSON.stringify(analysis.rows));

  // Replacing keeps every code, bumps the version and removes the old copy.
  fails(await graphql(IMPORT, { c: collection.id, n: 'Communes', f: 'CSV', t: rows.filter((line) => !line.startsWith('T5890;')).join('\n'), l: large.id, v: large.version }, token), /Keep code T5890/, 'a code cannot disappear');
  const replaced = data(await graphql(IMPORT, { c: collection.id, n: 'Communes', f: 'CSV', t: `${csv}\nT5891;Commune nouvelle;New town;D1`, l: large.id, v: large.version }, token)).importReferential.codeLists.find((item) => item.id === large.id);
  assert.deepEqual([replaced.version, replaced.codeCount], [large.version + 1, 6001]);
  assert.equal(await mongoose.connection.collection('storedcodes').countDocuments({ listId: large.id }), 6001, 'only the current version is kept');
  fails(await graphql(IMPORT, { c: collection.id, n: 'Communes', f: 'CSV', t: csv, l: large.id, v: large.version }, token), /changed/, 'a stale version is refused');

  // Unsupported operations say so.
  fails(await graphql('mutation($c:String!,$n:String!,$codes:[ClassificationCodeInput!]!,$l:String,$v:Int){saveClassification(collectionId:$c,name:$n,codes:$codes,listId:$l,expectedVersion:$v){id}}', { c: collection.id, n: 'Communes', codes: [{ code: 'X', labelEn: 'X', labelFr: 'X' }], l: large.id, v: replaced.version }, token), /importing a referential/, 'code-by-code edit');
  const paths = data(await graphql('query($c:String!,$l:String!){classificationCodePaths(collectionId:$c,listId:$l){code}}', { c: collection.id, l: large.id }, token)).classificationCodePaths;
  assert.equal(paths.length, 0, 'a large list is never sent whole');

  // Small JSON referential, nested, single label: stays inside the collection.
  const json = JSON.stringify([{ code: 'EU', label: 'Europe', children: [{ code: 'FR', label: 'France', children: [{ code: 'IDF', label: 'Île-de-France' }] }] }]);
  const small = data(await graphql(IMPORT, { c: collection.id, n: 'Continents', f: 'JSON', t: json }, token)).importReferential.codeLists.find((item) => item.name === 'Continents');
  assert.deepEqual([small.external ?? false, small.codes.map((item) => item.code)], [false, ['EU', 'FR', 'IDF']]);

  // Backups carry the stored codes; deleting the collection removes them.
  const backup = JSON.parse(data(await graphql('query{workspaceBackup(includeSensitive:true)}', {}, token)).workspaceBackup);
  assert.equal(backup.data.storedCodes.length, 6001);
  data(await graphql('mutation($id:String!){deleteCollection(id:$id)}', { id: collection.id }, token));
  assert.equal(await mongoose.connection.collection('storedcodes').countDocuments({ collectionId: collection.id }), 0);
  console.log('Referentials: preview, 6,000-code import, accent-free search, browsing, entries, labels, level grouping, replacement, refusals, nested JSON, backup and cleanup passed.');
} finally {
  if (userId) {
    const ids = (await mongoose.connection.collection('collections').find({ ownerId: userId }, { projection: { _id: 1 } }).toArray()).map((item) => item._id.toString());
    await mongoose.connection.collection('storedcodes').deleteMany({ collectionId: { $in: ids } });
    await mongoose.connection.collection('entries').deleteMany({ collectionId: { $in: ids } });
    await mongoose.connection.collection('collections').deleteMany({ ownerId: userId });
    await mongoose.connection.collection('users').deleteMany({ _id: new mongoose.Types.ObjectId(userId) });
  }
  await mongoose.disconnect();
}
