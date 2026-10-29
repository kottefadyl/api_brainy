import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI for cleanup');
await mongoose.connect(process.env.MONGODB_URI);
const call = async (query, variables = {}, token) => {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`http://localhost:${process.env.PORT ?? 3000}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
      return response.json();
    } catch (error) {
      if (attempt === 29) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
};
const ok = (result) => { assert.equal(result.errors, undefined, JSON.stringify(result.errors)); return result.data; };
const denied = (result, pattern) => { assert.ok(result.errors?.length, JSON.stringify(result)); assert.match(result.errors[0].message, pattern); };
const collectionIds = [];
let userId;
try {
  const owner = ok(await call('mutation($input:RegisterInput!){register(input:$input){token user{id}}}', { input: { name: 'Contribution test', email: `contribution-${randomUUID()}@example.test`, password: 'password-123' } })).register;
  userId = owner.user.id;
  const collection = ok(await call('mutation($input:CreateCollectionInput!){createCollection(input:$input){id formats{id fields{id name}}}}', { input: { name: 'Public collection', formats: [{ name: 'Survey', color: '#EEF5FF', fields: [{ name: 'Answer', kind: 'TEXT' }, { name: 'Count', kind: 'NUMBER' }] }] } }, owner.token)).createCollection;
  collectionIds.push(collection.id);
  const format = collection.formats[0];
  const answerId = format.fields.find((field) => field.name === 'Answer').id;
  const created = ok(await call('mutation($id:String!,$input:CreateContributionLinkInput!){createContributionLink(collectionId:$id,input:$input){token link{id}}}', { id: collection.id, input: { formatId: format.id, fieldIds: [answerId], titleEn: 'Field survey', titleFr: 'Enquête', consentEn: 'I agree', consentFr: 'J’accepte', allowAnonymous: true, expiresAt: new Date(Date.now() + 86400000).toISOString() } }, owner.token)).createContributionLink;
  const form = ok(await call('query($token:String!){publicContributionForm(token:$token){formatName fields{id name}}}', { token: created.token })).publicContributionForm;
  assert.deepEqual(form.fields.map((field) => field.id), [answerId]);
  assert.equal(form.formatName, 'Survey');
  denied(await call('query($id:String!){contributionSubmissions(collectionId:$id){id}}', { id: collection.id }), /Unauthorized|authentication|Bearer|token|Sign in/i);
  const submit = 'mutation($token:String!,$input:SubmitContributionInput!){submitContribution(token:$token,input:$input){receipt receivedAt}}';
  denied(await call(submit, { token: created.token, input: { consent: false, values: [{ fieldId: answerId, value: 'No consent' }] } }), /Consent/i);
  denied(await call(submit, { token: created.token, input: { consent: true, values: [{ fieldId: format.fields.find((field) => field.name === 'Count').id, value: '2' }] } }), /public field/i);
  const receipts = [];
  for (let i = 0; i < 9; i++) receipts.push(ok(await call(submit, { token: created.token, input: { consent: true, values: [{ fieldId: answerId, value: `Response ${i}` }] } })).submitContribution.receipt);
  denied(await call(submit, { token: created.token, input: { consent: true, values: [{ fieldId: answerId, value: 'Excess' }] } }), /Too many/i);
  assert.equal(ok(await call('query($id:String!){collectionEntries(collectionId:$id){id}}', { id: collection.id }, owner.token)).collectionEntries.length, 0, 'quarantine is invisible to entry list');
  const rows = ok(await call('query($id:String!){contributionSubmissions(collectionId:$id){id status values{value}}}', { id: collection.id }, owner.token)).contributionSubmissions;
  assert.equal(rows.length, 9);
  const firstRow = rows.find((row) => row.values[0].value === 'Response 0');
  ok(await call('mutation($id:String!,$values:[EntryValueInput!]!){correctContribution(id:$id,values:$values){id values{value}}}', { id: firstRow.id, values: [{ fieldId: answerId, value: 'Corrected response' }] }, owner.token));
  const duplicate = ok(await call('mutation($id:String!,$action:String!,$duplicateOf:String){reviewContribution(id:$id,action:$action,duplicateOf:$duplicateOf){status duplicateOf events{kind}}}', { id: rows.find((row) => row.values[0].value === 'Response 1').id, action: 'REJECT', duplicateOf: firstRow.id }, owner.token)).reviewContribution;
  assert.equal(duplicate.duplicateOf, firstRow.id);
  assert.ok(duplicate.events.some((event) => event.kind === 'DUPLICATE_REJECTED'));
  const accepted = ok(await call('mutation($id:String!,$action:String!){reviewContribution(id:$id,action:$action){status acceptedEntryId}}', { id: firstRow.id, action: 'ACCEPT' }, owner.token)).reviewContribution;
  assert.equal(accepted.status, 'ACCEPTED');
  assert.ok(accepted.acceptedEntryId);
  assert.equal(ok(await call('query($id:String!){collectionEntries(collectionId:$id){id contributionLinkId contributionReceivedAt}}', { id: collection.id }, owner.token)).collectionEntries.length, 1);
  const otherEntry = ok(await call('mutation($id:String!,$input:SaveEntryInput!){createEntry(collectionId:$id,input:$input){id}}', { id: collection.id, input: { formatId: format.id, values: [{ fieldId: answerId, value: 'Independent' }] } }, owner.token)).createEntry;
  ok(await call('mutation($collectionId:String!,$fromEntryId:String!,$toEntryId:String!,$kind:RelationKind!){createCollectionRelation(collectionId:$collectionId,fromEntryId:$fromEntryId,toEntryId:$toEntryId,kind:$kind){id}}', { collectionId: collection.id, fromEntryId: accepted.acceptedEntryId, toEntryId: otherEntry.id, kind: 'ASSOCIATION' }, owner.token));
  const archive = ok(await call('query{workspaceBackup}', {}, owner.token)).workspaceBackup;
  const backup = JSON.parse(archive);
  assert.equal(backup.data.contributionLinks.length, 1);
  assert.equal(backup.data.contributionSubmissions.length, 9);
  assert.equal(ok(await call('mutation($archive:String!){restoreWorkspaceBackup(archive:$archive,dryRun:true){allowed}}', { archive }, owner.token)).restoreWorkspaceBackup.allowed, true);
  const ownExport = ok(await call('query($receipt:String!){contributionByReceipt(receipt:$receipt){status values{value}}}', { receipt: receipts[8] })).contributionByReceipt;
  assert.equal(ownExport.status, 'PENDING');
  assert.equal(ownExport.values[0].value, 'Response 8');
  ok(await call('mutation($receipt:String!){eraseContributionByReceipt(receipt:$receipt)}', { receipt: receipts[8] }));
  denied(await call('query($receipt:String!){contributionByReceipt(receipt:$receipt){status}}', { receipt: receipts[8] }), /Receipt not found/i);
  ok(await call('mutation($receipt:String!){eraseContributionByReceipt(receipt:$receipt)}', { receipt: receipts[0] }));
  assert.deepEqual(ok(await call('query($id:String!){collectionEntries(collectionId:$id){id}}', { id: collection.id }, owner.token)).collectionEntries.map((entry) => entry.id), [otherEntry.id]);
  assert.equal(await mongoose.connection.collection('entryrelations').countDocuments({ $or: [{ fromEntryId: accepted.acceptedEntryId }, { toEntryId: accepted.acceptedEntryId }] }), 0);
  ok(await call('mutation($id:String!){revokeContributionLink(id:$id){revokedAt}}', { id: created.link.id }, owner.token));
  denied(await call('query($token:String!){publicContributionForm(token:$token){formatName}}', { token: created.token }), /unavailable/i);
  console.log('T41 contribution smoke passed: public form, access, consent, quarantine, rate limit, correction, duplicate review, acceptance, provenance, backup, receipt erasure, revocation.');
} finally {
  if (collectionIds.length) {
    await mongoose.connection.collection('contributionlinks').deleteMany({ collectionId: { $in: collectionIds } });
    await mongoose.connection.collection('contributionsubmissions').deleteMany({ collectionId: { $in: collectionIds } });
    await mongoose.connection.collection('entryrelations').deleteMany({ collectionId: { $in: collectionIds } });
    await mongoose.connection.collection('entrylinks').deleteMany({ collectionId: { $in: collectionIds } });
    await mongoose.connection.collection('entries').deleteMany({ collectionId: { $in: collectionIds } });
    await mongoose.connection.collection('collections').deleteMany({ _id: { $in: collectionIds.map((id) => new mongoose.Types.ObjectId(id)) } });
  }
  if (userId) { await mongoose.connection.collection('auditlogs').deleteMany({ userId }); await mongoose.connection.collection('users').deleteOne({ _id: new mongoose.Types.ObjectId(userId) }); }
  await mongoose.disconnect();
}
