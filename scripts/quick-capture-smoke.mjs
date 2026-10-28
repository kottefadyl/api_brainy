import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

const endpoint = `http://localhost:${process.env.PORT ?? 3000}/graphql`;
assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI for cleanup');
await mongoose.connect(process.env.MONGODB_URI);
let ownerId;
const query = async (source, variables = {}, token) => (await (await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query: source, variables }) })).json());
const data = (result) => { assert.equal(result.errors, undefined, JSON.stringify(result.errors)); return result.data; };
try {
  const auth = data(await query('mutation($input:RegisterInput!) { register(input:$input) { token user { id } } }', { input: { name: 'Capture Smoke', email: `capture-${randomUUID()}@example.test`, password: 'test-password-123' } })).register;
  ownerId = auth.user.id;
  const token = auth.token;
  const capture = data(await query('mutation { createCollectionFromTemplate(templateId:"capture",name:"Capture smoke") { id formats { id fields { id name kind } } } }', {}, token)).createCollectionFromTemplate;
  const format = capture.formats[0];
  const fields = Object.fromEntries(format.fields.map((field) => [field.name, field.id]));
  assert.ok(fields.Link && fields.Note && fields.Source && fields.Attachment);
  const save = 'mutation($id:String!,$input:SaveEntryInput!) { createEntry(collectionId:$id,input:$input) { id createdAt values { fieldId value } } }';
  const url = 'https://example.org/article?ref=brainy';
  const first = data(await query(save, { id: capture.id, input: { formatId: format.id, values: [{ fieldId: fields.Title, value: 'Saved article' }, { fieldId: fields.Link, value: url }, { fieldId: fields.Note, value: 'Read for the garden' }, { fieldId: fields.Source, value: 'Browser share' }] } }, token)).createEntry;
  assert.equal(first.values.find((item) => item.fieldId === fields.Link).value, url);
  assert.ok(first.createdAt);
  const duplicates = data(await query('query($id:String!,$format:String!,$field:String!,$url:String!) { collectionDuplicateLinks(collectionId:$id,formatId:$format,fieldId:$field,url:$url) { id } }', { id: capture.id, format: format.id, field: fields.Link, url }, token)).collectionDuplicateLinks;
  assert.equal(duplicates[0].id, first.id);
  const search = data(await query('query($id:String!,$word:String!) { collectionEntriesPage(collectionId:$id,first:10,search:$word) { entries { id } } }', { id: capture.id, word: 'garden' }, token)).collectionEntriesPage;
  assert.ok(search.entries.some((entry) => entry.id === first.id), 'context note is searchable');
  const sale = data(await query('mutation($input:CreateCollectionInput!) { createCollection(input:$input) { id formats { id fields { id name } } } }', { input: { name: 'Sales smoke', formats: [{ name: 'Sale', color: '#FFF5EB', fields: [{ name: 'Date', kind: 'DATE' }, { name: 'Quantity', kind: 'NUMBER' }, { name: 'Amount', kind: 'NUMBER' }] }] } }, token)).createCollection;
  const saleFormat = sale.formats[0];
  const saleFields = Object.fromEntries(saleFormat.fields.map((field) => [field.name, field.id]));
  const payload = { formatId: saleFormat.id, values: [{ fieldId: saleFields.Date, value: '2026-10-27' }, { fieldId: saleFields.Quantity, value: '2' }, { fieldId: saleFields.Amount, value: '3.50' }] };
  const saleOne = data(await query(save, { id: sale.id, input: payload }, token)).createEntry;
  const saleTwo = data(await query(save, { id: sale.id, input: payload }, token)).createEntry;
  assert.notEqual(saleOne.id, saleTwo.id, 'quick repetition creates another entry');
  assert.equal(saleTwo.values.find((item) => item.fieldId === saleFields.Amount).value, '3.50');
  console.log('T34: capture template, original link, context search, duplicate warning source and repeated sale passed.');
} finally {
  try {
    if (ownerId) {
      const ids = (await mongoose.connection.collection('collections').find({ ownerId }, { projection: { _id: 1 } }).toArray()).map((item) => item._id.toString());
      await mongoose.connection.collection('entries').deleteMany({ collectionId: { $in: ids } });
      await mongoose.connection.collection('collections').deleteMany({ ownerId });
      await mongoose.connection.collection('users').deleteMany({ _id: new mongoose.Types.ObjectId(ownerId) });
    }
  } finally { await mongoose.disconnect(); }
}
