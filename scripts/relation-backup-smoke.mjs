import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import mongoose from 'mongoose';

const endpoint = process.env.GRAPHQL_URL ?? 'http://127.0.0.1:3000/graphql';
assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI for isolated cleanup');
await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
let userId;
const collectionIds = [];
const data = (result) => { assert.equal(result.errors, undefined, JSON.stringify(result.errors)); return result.data; };
async function graphql(query, variables = {}, token) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
  return response.json();
}

try {
  const auth = data(await graphql('mutation($input:RegisterInput!){register(input:$input){token user{id}}}', { input: { name: 'Relation Backup Tester', email: `relation-${randomUUID()}@example.test`, password: 'test-password-123' } })).register;
  userId = auth.user.id;
  const token = auth.token;
  const createCollection = 'mutation($input:CreateCollectionInput!){createCollection(input:$input){id formats{id fields{id name}}}}';
  const source = data(await graphql(createCollection, { input: { name: 'Relation source', formats: [{ name: 'Node', color: '#EEF5FF', objectModel: true, fields: [{ name: 'Name', kind: 'TITLE' }, { name: 'Cost', kind: 'NUMBER', unit: 'USD' }, { name: 'Population', kind: 'NUMBER', unit: 'item' }] }] } }, token)).createCollection;
  collectionIds.push(source.id);
  const target = data(await graphql(createCollection, { input: { name: 'Relation target', formats: [{ name: 'Other', color: '#EDF9F3', fields: [{ name: 'Name', kind: 'TITLE' }] }] } }, token)).createCollection;
  collectionIds.push(target.id);
  const format = source.formats[0];
  const fields = Object.fromEntries(format.fields.map((field) => [field.name, field.id]));
  const createEntry = 'mutation($collectionId:String!,$input:SaveEntryInput!){createEntry(collectionId:$collectionId,input:$input){id updatedAt}}';
  const entry = async (name, numeric = {}) => data(await graphql(createEntry, { collectionId: source.id, input: { formatId: format.id, values: [{ fieldId: fields.Name, value: name }, ...Object.entries(numeric).map(([key, value]) => ({ fieldId: fields[key], value: String(value) }))] } }, token)).createEntry;
  const recipe = await entry('Recipe'), dough = await entry('Dough'), flour = await entry('Flour', { Cost: 2 });
  const relation = 'mutation($collectionId:String!,$fromEntryId:String!,$toEntryId:String!,$kind:RelationKind!,$quantity:String,$unit:String,$snapshotFieldId:String){createCollectionRelation(collectionId:$collectionId,fromEntryId:$fromEntryId,toEntryId:$toEntryId,kind:$kind,quantity:$quantity,unit:$unit,snapshotFieldId:$snapshotFieldId){id}}';
  const add = (fromEntryId, toEntryId, kind, extras = {}) => graphql(relation, { collectionId: source.id, fromEntryId, toEntryId, kind, ...extras }, token);
  data(await add(recipe.id, dough.id, 'COMPONENT', { quantity: '3', unit: 'item' }));
  data(await add(dough.id, flour.id, 'COMPONENT', { quantity: '4', unit: 'item', snapshotFieldId: fields.Cost }));
  const total = (rootId, kind, fieldName) => graphql('query($collectionId:String!,$rootId:String!,$kind:RelationKind!,$fieldName:String!){collectionRelationTotal(collectionId:$collectionId,rootId:$rootId,kind:$kind,fieldName:$fieldName){value unit nodes}}', { collectionId: source.id, rootId, kind, fieldName }, token);
  assert.equal(data(await total(recipe.id, 'COMPONENT', 'Cost')).collectionRelationTotal.value, '24');
  assert.ok((await add(flour.id, recipe.id, 'COMPONENT', { quantity: '1', unit: 'item' })).errors?.length, 'cycle refused');
  const update = 'mutation($id:String!,$input:SaveEntryInput!){updateEntry(id:$id,input:$input){id updatedAt}}';
  data(await graphql(update, { id: flour.id, input: { formatId: format.id, expectedUpdatedAt: flour.updatedAt, clientMutationId: `update-${randomUUID()}`, values: [{ fieldId: fields.Name, value: 'Flour' }, { fieldId: fields.Cost, value: '5' }] } }, token));
  assert.equal(data(await total(recipe.id, 'COMPONENT', 'Cost')).collectionRelationTotal.value, '24', 'snapshot stays frozen');

  const country = await entry('Country', { Population: 30 }), region = await entry('Region', { Population: 20 }), city = await entry('City', { Population: 10 });
  data(await add(region.id, country.id, 'PARENT'));
  data(await add(city.id, region.id, 'PARENT'));
  assert.equal(data(await total(country.id, 'PARENT', 'Population')).collectionRelationTotal.value, '60');
  assert.ok((await add(country.id, city.id, 'PARENT')).errors?.length, 'hierarchy cycle refused');

  const copied = data(await graphql('mutation($objectId:String!,$targetCollectionId:String!){copyCollectionObject(objectId:$objectId,targetCollectionId:$targetCollectionId){objectId copiedEntries copiedRelations}}', { objectId: recipe.id, targetCollectionId: target.id }, token)).copyCollectionObject;
  assert.equal(copied.copiedEntries, 3);
  assert.equal(copied.copiedRelations, 2);
  const copiedEdges = data(await graphql('query($collectionId:String!,$entryId:String!){collectionRelations(collectionId:$collectionId,entryId:$entryId){fromEntryId toEntryId}}', { collectionId: target.id, entryId: copied.objectId }, token)).collectionRelations;
  assert.equal(copiedEdges.length, 1);
  assert.notEqual(copiedEdges[0].toEntryId, dough.id, 'copied graph does not point to source');

  const impact = data(await graphql('query($collectionId:String!,$entryId:String!){collectionRelationImpact(collectionId:$collectionId,entryId:$entryId){relations{id} replacementAllowed}}', { collectionId: source.id, entryId: country.id }, token)).collectionRelationImpact;
  assert.equal(impact.relations.length, 1);
  assert.ok((await graphql('mutation($id:String!){deleteEntry(id:$id)}', { id: country.id }, token)).errors?.length, 'deleting related parent refused');
  const replacement = await entry('Replacement country');
  const replacePreview = data(await graphql('query($collectionId:String!,$entryId:String!,$replacementId:String){collectionRelationImpact(collectionId:$collectionId,entryId:$entryId,replacementId:$replacementId){relations{id} replacementAllowed}}', { collectionId: source.id, entryId: country.id, replacementId: replacement.id }, token)).collectionRelationImpact;
  assert.equal(replacePreview.replacementAllowed, true, 'parent can be replaced');
  data(await graphql('mutation($collectionId:String!,$entryId:String!,$replacementId:String){detachCollectionRelations(collectionId:$collectionId,entryId:$entryId,replacementId:$replacementId)}', { collectionId: source.id, entryId: country.id, replacementId: replacement.id }, token));
  data(await graphql('mutation($id:String!){deleteEntry(id:$id)}', { id: country.id }, token));
  assert.equal(data(await total(replacement.id, 'PARENT', 'Population')).collectionRelationTotal.value, '30');

  const createId = `retry-${randomUUID()}`;
  const payload = { collectionId: source.id, input: { formatId: format.id, clientMutationId: createId, values: [{ fieldId: fields.Name, value: 'Offline retry' }] } };
  const first = data(await graphql(createEntry, payload, token)).createEntry;
  const retry = data(await graphql(createEntry, payload, token)).createEntry;
  assert.equal(first.id, retry.id, 'retry does not duplicate');
  assert.ok((await graphql(update, { id: first.id, input: { formatId: format.id, expectedUpdatedAt: '2000-01-01T00:00:00Z', clientMutationId: `stale-${randomUUID()}`, values: [{ fieldId: fields.Name, value: 'Stale edit' }] } }, token)).errors?.length, 'stale edit refused visibly');

  await db.collection('stockmovements').insertOne({ ownerId: userId, collectionId: source.id, productId: flour.id, productName: 'Flour', kind: 'IN', quantity: '1', packageFactor: '1', baseQuantity: '1', fromLocation: '', toLocation: '', lot: '', occurredAt: new Date(), createdAt: new Date(), actorId: userId, idempotencyKey: `backup-${randomUUID()}` });
  const archive = data(await graphql('query{workspaceBackup}', {}, token)).workspaceBackup;
  const parsed = JSON.parse(archive);
  assert.ok(parsed.data.relations.length >= 4 && parsed.data.stockMovements.length === 1);
  const restore = 'mutation($archive:String!,$dryRun:Boolean!){restoreWorkspaceBackup(archive:$archive,dryRun:$dryRun){allowed restored collections entries relations stockMovements conflicts}}';
  const preview = data(await graphql(restore, { archive, dryRun: true }, token)).restoreWorkspaceBackup;
  assert.equal(preview.allowed, true, JSON.stringify(preview.conflicts));
  for (const name of ['entryrelations', 'entrylinks', 'stockmovements', 'entryreminders', 'auditlogs', 'entries', 'collections']) await db.collection(name).deleteMany(name === 'collections' ? { ownerId: userId } : { collectionId: { $in: collectionIds } });
  const restored = data(await graphql(restore, { archive, dryRun: false }, token)).restoreWorkspaceBackup;
  assert.equal(restored.restored, true, JSON.stringify(restored.conflicts));
  assert.equal(data(await total(recipe.id, 'COMPONENT', 'Cost')).collectionRelationTotal.value, '24', 'restored internal relations');
  assert.equal(await db.collection('stockmovements').countDocuments({ collectionId: source.id }), 1, 'stock ledger restored once');
  assert.equal(data(await graphql(restore, { archive, dryRun: false }, token)).restoreWorkspaceBackup.restored, true, 'restore retry is idempotent');

  const { graphNodes, validateNewEdge } = await import('../dist/collections/relation-graph.js');
  const large = Array.from({ length: 10000 }, (_, index) => ({ fromEntryId: 'root', toEntryId: `leaf-${index}`, kind: 'COMPONENT' }));
  const start = performance.now();
  assert.equal(graphNodes(large, 'root', 'COMPONENT').length, 10001);
  validateNewEdge(large, { fromEntryId: 'root', toEntryId: 'new-leaf', kind: 'COMPONENT' });
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 5000, `10,000 node graph took ${elapsed.toFixed(0)} ms`);
  console.log(`T37/T29 smoke passed; 10,000-node graph ${elapsed.toFixed(0)} ms`);
} finally {
  if (collectionIds.length) {
    for (const name of ['entryrelations', 'entrylinks', 'stockmovements', 'entryreminders', 'auditlogs', 'entries', 'collections']) await db.collection(name).deleteMany(name === 'collections' ? { ownerId: userId } : { collectionId: { $in: collectionIds } });
  }
  if (userId) await db.collection('users').deleteOne({ _id: new mongoose.Types.ObjectId(userId) });
  await mongoose.disconnect();
}
