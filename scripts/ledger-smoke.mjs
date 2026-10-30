import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

const url = `http://localhost:${process.env.PORT ?? 3000}/graphql`;
assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI for cleanup');
await mongoose.connect(process.env.MONGODB_URI);
const email = `ledger-${randomUUID()}@example.test`;
let ownerId;
const graphql = async (query, variables = {}, token) => (await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) })).json());
const data = (result) => { assert.equal(result.errors, undefined, JSON.stringify(result.errors)); return result.data; };

try {
  const auth = data(await graphql('mutation($input:RegisterInput!){register(input:$input){token user{id}}}', { input: { name: 'Ledger Smoke', email, password: 'test-password-123' } })).register;
  ownerId = auth.user.id;
  const token = auth.token;
  const cash = data(await graphql('mutation($input:CreateCollectionInput!){createCollection(input:$input){id formats{id appendOnly fields{id name kind}}}}', { input: { name: 'R4 cash', formats: [{ name: 'Cash writings', color: '#EEF5FF', fields: [{ name: 'Label', kind: 'TITLE' }, { name: 'Amount', kind: 'NUMBER' }, { name: 'Customer', kind: 'TEXT' }] }] } }, token)).createCollection;
  const format = cash.formats[0];
  const ids = Object.fromEntries(format.fields.map((field) => [field.name, field.id]));
  data(await graphql('mutation($collectionId:String!,$formatId:String!){enableLedger(collectionId:$collectionId,formatId:$formatId){id formats{id appendOnly}}}', { collectionId: cash.id, formatId: format.id }, token));
  const append = (label, amount, customer) => graphql('mutation($collectionId:String!,$input:SaveEntryInput!){createEntry(collectionId:$collectionId,input:$input){id ledgerSequence ledgerHash correctionOf values{fieldId value}}}', { collectionId: cash.id, input: { formatId: format.id, values: [{ fieldId: ids.Label, value: label }, { fieldId: ids.Amount, value: amount }, { fieldId: ids.Customer, value: customer }] } }, token);
  const first = data(await append('Sale', '100', 'Ada')).createEntry;
  const second = data(await append('Refund', '-20', 'Ada')).createEntry;
  assert.deepEqual([first.ledgerSequence, second.ledgerSequence], [1, 2]);
  const balance = () => graphql('query($collectionId:String!,$formatId:String!,$fieldId:String!){ledgerBalance(collectionId:$collectionId,formatId:$formatId,fieldId:$fieldId)}', { collectionId: cash.id, formatId: format.id, fieldId: ids.Amount }, token);
  assert.equal(data(await balance()).ledgerBalance, '80');
  const correction = data(await graphql('mutation($originalId:String!,$input:SaveEntryInput!){correctLedgerEntry(originalId:$originalId,input:$input){id correctionOf ledgerSequence}}', { originalId: second.id, input: { values: [{ fieldId: ids.Label, value: 'Reverse refund' }, { fieldId: ids.Amount, value: '20' }, { fieldId: ids.Customer, value: 'Ada' }] } }, token)).correctLedgerEntry;
  assert.equal(correction.correctionOf, second.id);
  assert.equal(data(await balance()).ledgerBalance, '100');
  const note = data(await graphql('mutation($collectionId:String!,$input:SaveEntryInput!){createEntry(collectionId:$collectionId,input:$input){id}}', { collectionId: cash.id, input: { formatId: format.id, values: [{ fieldId: ids.Label, value: 'Note without amount' }] } }, token)).createEntry;
  assert.ok((await graphql('mutation($originalId:String!,$input:SaveEntryInput!){correctLedgerEntry(originalId:$originalId,input:$input){id}}', { originalId: note.id, input: { values: [{ fieldId: ids.Label, value: 'Invalid amount' }, { fieldId: ids.Amount, value: '1' }] } }, token)).errors?.length, 'counter-writing cannot introduce a new amount');
  assert.ok((await graphql('mutation($id:String!,$input:SaveEntryInput!){updateEntry(id:$id,input:$input){id}}', { id: first.id, input: { formatId: format.id, values: [{ fieldId: ids.Amount, value: '200' }] } }, token)).errors?.length, 'direct edit is refused');
  assert.ok((await graphql('mutation($id:String!){deleteEntry(id:$id)}', { id: first.id }, token)).errors?.length, 'direct delete is refused');
  const before = data(await graphql('query($collectionId:String!,$formatId:String!){verifyLedger(collectionId:$collectionId,formatId:$formatId){valid checked headHash redactionHash problem}}', { collectionId: cash.id, formatId: format.id }, token)).verifyLedger;
  assert.equal(before.valid, true);
  const masked = data(await graphql('mutation($collectionId:String!,$formatId:String!,$entryId:String!,$fieldIds:[String!]!,$reason:String!){redactLedgerFields(collectionId:$collectionId,formatId:$formatId,entryId:$entryId,fieldIds:$fieldIds,reason:$reason){valid redactionHash}}', { collectionId: cash.id, formatId: format.id, entryId: first.id, fieldIds: [ids.Customer], reason: 'Erase personal name' }, token)).redactLedgerFields;
  assert.equal(masked.valid, true);
  assert.ok(masked.redactionHash);
  const stored = await mongoose.connection.collection('entries').findOne({ _id: new mongoose.Types.ObjectId(first.id) });
  assert.equal(stored.values.find((value) => value.fieldId === ids.Customer).value, '[redacted]');
  assert.equal(stored.values.find((value) => value.fieldId === ids.Amount).value, '100');
  const proof = JSON.parse(data(await graphql('query($collectionId:String!,$formatId:String!){ledgerProof(collectionId:$collectionId,formatId:$formatId)}', { collectionId: cash.id, formatId: format.id }, token)).ledgerProof);
  assert.equal(proof.redactions.length, 1);
  assert.equal(proof.valid, true);

  const shop = data(await graphql('mutation($templateId:String!,$name:String!){createCollectionFromTemplate(templateId:$templateId,name:$name){id formats{id name fields{id name kind}}}}', { templateId: 'shop', name: 'R7 lot stock' }, token)).createCollectionFromTemplate;
  const productFormat = shop.formats.find((item) => item.name === 'Product');
  const product = data(await graphql('mutation($collectionId:String!,$input:SaveEntryInput!){createEntry(collectionId:$collectionId,input:$input){id}}', { collectionId: shop.id, input: { formatId: productFormat.id, values: [{ fieldId: productFormat.fields[0].id, value: 'Medicine box' }] } }, token)).createEntry;
  const stock = (kind, quantity, key) => graphql('mutation($collectionId:String!,$input:StockMovementInput!){commitStockMovement(collectionId:$collectionId,input:$input){id ledgerHash ledgerSequence}}', { collectionId: shop.id, input: { kind, productId: product.id, quantity, toLocation: kind === 'IN' ? 'Shelf' : '', fromLocation: kind === 'OUT' ? 'Shelf' : '', lot: 'A-17', occurredAt: '2026-10-20T12:00:00Z', idempotencyKey: key } }, token);
  const legacy = await mongoose.connection.collection('stockmovements').insertOne({ ownerId, collectionId: shop.id, productId: product.id, productName: 'Medicine box', kind: 'IN', quantity: '10', packageFactor: '1', baseQuantity: '10', fromLocation: '', toLocation: 'Shelf', lot: 'A-17', occurredAt: new Date('2026-10-20T12:00:00Z'), createdAt: new Date('2026-10-20T12:01:00Z'), actorId: ownerId, idempotencyKey: `legacy-${randomUUID()}` });
  const stockStatus = () => graphql('query($collectionId:String!,$productId:String!){verifyStockLedger(collectionId:$collectionId,productId:$productId){valid checked problem}}', { collectionId: shop.id, productId: product.id }, token);
  assert.equal(data(await stockStatus()).verifyStockLedger.valid, false, 'legacy stock has no head before migration');
  assert.equal(data(await graphql('mutation($collectionId:String!,$productId:String!){sealStockHistory(collectionId:$collectionId,productId:$productId){valid checked}}', { collectionId: shop.id, productId: product.id }, token)).sealStockHistory.valid, true);
  const received = await mongoose.connection.collection('stockmovements').findOne({ _id: legacy.insertedId });
  const outgoing = data(await stock('OUT', '3', `r7-out-${randomUUID()}`)).commitStockMovement;
  assert.deepEqual([received.ledgerSequence, outgoing.ledgerSequence], [1, 2]);
  assert.equal(data(await stockStatus()).verifyStockLedger.valid, true);
  const positions = data(await graphql('query($collectionId:String!){stockPositions(collectionId:$collectionId){lot quantity}}', { collectionId: shop.id }, token)).stockPositions;
  assert.equal(positions.find((item) => item.lot === 'A-17').quantity, '7');
  const archive = JSON.parse(data(await graphql('query{workspaceBackup}', {}, token)).workspaceBackup);
  assert.equal(archive.data.ledgerHeads.length, 1);
  assert.equal(archive.data.ledgerRedactions.length, 1);
  assert.equal(archive.data.stockLedgerHeads.length, 1);
  const previewBackup = (value) => graphql('mutation($archive:String!,$dryRun:Boolean!){restoreWorkspaceBackup(archive:$archive,dryRun:$dryRun){allowed conflicts restored}}', { archive: value, dryRun: true }, token);
  assert.equal(data(await previewBackup(JSON.stringify(archive))).restoreWorkspaceBackup.allowed, true, 'intact archive previews successfully');
  const forged = structuredClone(archive);
  const forgedIndex = forged.data.entries.findIndex((row) => JSON.parse(row)._id.$oid === first.id);
  assert.ok(forgedIndex >= 0);
  const forgedEntry = JSON.parse(forged.data.entries[forgedIndex]);
  forgedEntry.values.find((value) => value.fieldId === ids.Amount).value = '999';
  forged.data.entries[forgedIndex] = JSON.stringify(forgedEntry);
  forged.checksum = createHash('sha256').update(JSON.stringify(forged.data)).digest('hex');
  const forgedPreview = data(await previewBackup(JSON.stringify(forged))).restoreWorkspaceBackup;
  assert.equal(forgedPreview.allowed, false, 'archive with recomputed checksum but broken register chain is refused');

  await mongoose.connection.collection('entries').updateOne({ _id: new mongoose.Types.ObjectId(first.id), 'values.fieldId': ids.Amount }, { $set: { 'values.$.value': '999' } });
  assert.equal(data(await graphql('query($collectionId:String!,$formatId:String!){verifyLedger(collectionId:$collectionId,formatId:$formatId){valid problem}}', { collectionId: cash.id, formatId: format.id }, token)).verifyLedger.valid, false, 'entry tampering is detected');
  await mongoose.connection.collection('stockmovements').updateOne({ _id: legacy.insertedId }, { $set: { baseQuantity: '99' } });
  assert.equal(data(await stockStatus()).verifyStockLedger.valid, false, 'stock tampering is detected');
  console.log('T42: R4 cash balance and correction, R7 stock lot, redaction, proofs, backup, and DB tampering passed.');
} finally {
  try {
    if (ownerId) {
      const ids = (await mongoose.connection.collection('collections').find({ ownerId }, { projection: { _id: 1 } }).toArray()).map((item) => item._id.toString());
      for (const kind of ['ledgerheads', 'ledgerredactions', 'stockledgerheads', 'stockmovements', 'stocklocks', 'entries']) await mongoose.connection.collection(kind).deleteMany({ ownerId });
      await mongoose.connection.collection('collections').deleteMany({ ownerId });
      await mongoose.connection.collection('users').deleteMany({ _id: new mongoose.Types.ObjectId(ownerId) });
    }
  } finally { await mongoose.disconnect(); }
}
