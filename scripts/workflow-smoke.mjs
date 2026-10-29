import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI for cleanup');
await mongoose.connect(process.env.MONGODB_URI);
const users = [];
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
const register = async (name) => {
  const result = ok(await call('mutation($input:RegisterInput!){register(input:$input){token user{id email}}}', { input: { name, email: `${name}-${randomUUID()}@example.test`, password: 'password-123' } })).register;
  users.push(result.user.id);
  return result;
};
const entryFields = 'id updatedAt values{fieldId value} workflow{assigneeUserId dueAt reminderMinutesBefore history{kind from to actorUserId at assigneeUserId dueAt}}';
const createEntry = 'mutation($id:String!,$input:SaveEntryInput!){createEntry(collectionId:$id,input:$input){' + entryFields + '}}';
const transition = 'mutation($id:String!,$to:String!,$at:String!){transitionWorkflowEntry(entryId:$id,to:$to,expectedUpdatedAt:$at){' + entryFields + '}}';
const assignment = 'mutation($id:String!,$input:WorkflowAssignmentInput!){assignWorkflowEntry(entryId:$id,input:$input){' + entryFields + '}}';

try {
  const owner = await register('workflow-owner');
  const editor = await register('workflow-editor');
  const reader = await register('workflow-reader');
  const collection = ok(await call('mutation($input:CreateCollectionInput!){createCollection(input:$input){id formats{id fields{id name kind options}}}}', { input: { name: 'Workflow T40', formats: [{ name: 'Notes', color: '#EEF5FF', fields: [{ name: 'Title', kind: 'TITLE' }] }, { name: 'Custom', color: '#F4F0FF', fields: [{ name: 'Title', kind: 'TITLE' }, { name: 'State', kind: 'SELECT', options: ['New', 'Done'] }] }] } }, owner.token)).createCollection;
  ok(await call('mutation($id:String!,$email:String!,$role:CollectionRole!){addCollectionMember(collectionId:$id,email:$email,role:$role){id}}', { id: collection.id, email: editor.user.email, role: 'EDITOR' }, owner.token));
  ok(await call('mutation($id:String!,$email:String!,$role:CollectionRole!){addCollectionMember(collectionId:$id,email:$email,role:$role){id}}', { id: collection.id, email: reader.user.email, role: 'READER' }, owner.token));
  const note = ok(await call(createEntry, { id: collection.id, input: { formatId: collection.formats[0].id, values: [{ fieldId: collection.formats[0].fields[0].id, value: 'Plain note' }] } }, owner.token)).createEntry;
  assert.equal(note.workflow, null, 'Plain entries remain without workflow');
  const custom = collection.formats[1];
  const customState = custom.fields.find((item) => item.kind === 'SELECT').id;
  const customTitle = custom.fields.find((item) => item.kind === 'TITLE').id;
  ok(await call('mutation($id:String!,$formatId:String!,$input:WorkflowDefinitionInput!){setCollectionFormatWorkflow(collectionId:$id,formatId:$formatId,input:$input){id formats{id version workflow{stateFieldId}}}}', { id: collection.id, formatId: custom.id, input: { stateFieldId: customState, initialState: 'New', transitions: [{ from: 'New', to: 'Done', minimumRole: 'OWNER' }], requirements: [{ state: 'Done', fieldIds: [customTitle] }], expectedVersion: 1 } }, owner.token));
  let customEntry = ok(await call(createEntry, { id: collection.id, input: { formatId: custom.id, values: [{ fieldId: customTitle, value: 'Check custom flow' }] } }, owner.token)).createEntry;
  customEntry = ok(await call('mutation($id:String!,$input:SaveEntryInput!){updateEntry(id:$id,input:$input){' + entryFields + '}}', { id: customEntry.id, input: { formatId: custom.id, values: [{ fieldId: customState, value: 'New' }] } }, owner.token)).updateEntry;
  denied(await call(transition, { id: customEntry.id, to: 'Done', at: customEntry.updatedAt }, owner.token), /Fill in Title/i);
  customEntry = ok(await call('mutation($id:String!,$input:SaveEntryInput!){updateEntry(id:$id,input:$input){' + entryFields + '}}', { id: customEntry.id, input: { formatId: custom.id, values: [{ fieldId: customTitle, value: 'Check custom flow' }, { fieldId: customState, value: 'New' }] } }, owner.token)).updateEntry;
  customEntry = ok(await call(transition, { id: customEntry.id, to: 'Done', at: customEntry.updatedAt }, owner.token)).transitionWorkflowEntry;
  assert.equal(customEntry.workflow.history.length, 1, 'Configured flow records transition');

  const result = ok(await call('mutation($id:String!){addCollectionWorkflowTemplate(collectionId:$id,templateId:"APPROVAL",color:"#EDF9F3",language:"en"){id formats{id name version workflow{stateFieldId initialState transitions{from to minimumRole}} fields{id name kind options}}}}', { id: collection.id }, owner.token)).addCollectionWorkflowTemplate;
  const format = result.formats.find((item) => item.name === 'Approval request');
  const title = format.fields.find((item) => item.kind === 'TITLE');
  const state = format.workflow.stateFieldId;
  let entry = ok(await call(createEntry, { id: collection.id, input: { formatId: format.id, values: [{ fieldId: title.id, value: 'Approve the plan' }] } }, editor.token)).createEntry;
  assert.equal(entry.values.find((item) => item.fieldId === state).value, 'Submitted', 'Initial state supplied by API');
  denied(await call(createEntry, { id: collection.id, input: { formatId: format.id, values: [{ fieldId: title.id, value: 'Skip' }, { fieldId: state, value: 'Approved' }] } }, owner.token), /initial state/i);

  const due = new Date(Date.now() + 86400_000).toISOString();
  entry = ok(await call(assignment, { id: entry.id, input: { assigneeUserId: editor.user.id, dueAt: due, reminderMinutesBefore: 60, expectedUpdatedAt: entry.updatedAt } }, owner.token)).assignWorkflowEntry;
  assert.equal(entry.workflow.assigneeUserId, editor.user.id);
  assert.equal(entry.workflow.history[0].kind, 'ASSIGNMENT');
  const notices = ok(await call('query{workflowNotifications{id entryId readAt}}', {}, editor.token)).workflowNotifications;
  assert.ok(notices.some((item) => item.entryId === entry.id), 'Editor receives an in-app assignment notice');
  denied(await call(transition, { id: entry.id, to: 'Approved', at: entry.updatedAt }, editor.token), /not allowed/i);
  denied(await call(transition, { id: entry.id, to: 'In review', at: entry.updatedAt }, reader.token), /Access denied|permission|Read-only/i);
  entry = ok(await call(transition, { id: entry.id, to: 'In review', at: entry.updatedAt }, editor.token)).transitionWorkflowEntry;
  denied(await call(transition, { id: entry.id, to: 'Approved', at: entry.updatedAt }, editor.token), /Access denied|permission|Only a collection owner/i);
  denied(await call('mutation($id:String!,$input:SaveEntryInput!){updateEntry(id:$id,input:$input){id}}', { id: entry.id, input: { formatId: format.id, values: [{ fieldId: title.id, value: 'Approve the plan' }, { fieldId: state, value: 'Approved' }] } }, owner.token), /workflow transition/i);
  entry = ok(await call(transition, { id: entry.id, to: 'Approved', at: entry.updatedAt }, owner.token)).transitionWorkflowEntry;
  assert.deepEqual(entry.workflow.history.map((event) => [event.from, event.to]), [['Submitted', 'Submitted'], ['Submitted', 'In review'], ['In review', 'Approved']]);
  denied(await call(transition, { id: entry.id, to: 'Rejected', at: entry.updatedAt }, owner.token), /not allowed/i);
  const importRow = { sourceId: 'approval-copy', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T01:00:00.000Z', values: entry.values, workflowHistory: entry.workflow.history.map((event) => ({ ...event, at: event.at, dueAt: event.dueAt })) };
  const imported = ok(await call('mutation($id:String!,$input:ImportEntriesInput!){importEntriesBatch(collectionId:$id,input:$input){validCount createdCount errors{sourceId message}}}', { id: collection.id, input: { formatId: format.id, importKey: `workflow-${randomUUID()}`, dryRun: false, rows: [importRow] } }, owner.token)).importEntriesBatch;
  assert.deepEqual(imported.errors, [], 'Import accepts transition history');
  assert.equal(imported.createdCount, 1);
  const taskCollection = ok(await call('mutation($id:String!){addCollectionWorkflowTemplate(collectionId:$id,templateId:"TASK",color:"#FFF5EB",language:"fr"){formats{id name workflow{stateFieldId initialState transitions{from to}} fields{id kind}}}}', { id: collection.id }, owner.token)).addCollectionWorkflowTemplate;
  const taskFormat = taskCollection.formats.find((item) => item.name === 'Tâche');
  let task = ok(await call(createEntry, { id: collection.id, input: { formatId: taskFormat.id, values: [{ fieldId: taskFormat.fields.find((item) => item.kind === 'TITLE').id, value: 'Plan d’action de réunion' }] } }, owner.token)).createEntry;
  assert.equal(task.values.find((item) => item.fieldId === taskFormat.workflow.stateFieldId).value, 'À faire');
  task = ok(await call(assignment, { id: task.id, input: { assigneeUserId: editor.user.id, dueAt: due, reminderMinutesBefore: 15, expectedUpdatedAt: task.updatedAt } }, owner.token)).assignWorkflowEntry;
  task = ok(await call(transition, { id: task.id, to: 'En cours', at: task.updatedAt }, editor.token)).transitionWorkflowEntry;
  task = ok(await call(transition, { id: task.id, to: 'Fait', at: task.updatedAt }, editor.token)).transitionWorkflowEntry;
  assert.equal(task.workflow.history.length, 3, 'Meeting task keeps assignment and transitions');
  const copyTarget = ok(await call('mutation($input:CreateCollectionInput!){createCollection(input:$input){id}}', { input: { name: 'Workflow copy target', formats: [{ name: 'General', color: '#EEF5FF', fields: [{ name: 'Text', kind: 'TEXT' }] }] } }, owner.token)).createCollection;
  const copy = ok(await call('mutation($formatId:String!,$targetCollectionId:String!,$withEntries:Boolean!){copyCollectionDataFormat(formatId:$formatId,targetCollectionId:$targetCollectionId,withEntries:$withEntries){dataFormatId copiedEntries}}', { formatId: format.id, targetCollectionId: copyTarget.id, withEntries: true }, owner.token)).copyCollectionDataFormat;
  assert.ok(copy.copiedEntries >= 1);
  const copiedCollection = await mongoose.connection.collection('collections').findOne({ _id: new mongoose.Types.ObjectId(copyTarget.id) });
  const copiedDefinition = copiedCollection.formats.find((item) => item.id === copy.dataFormatId);
  assert.ok(copiedDefinition.workflow && copiedDefinition.workflow.stateFieldId !== state, 'State field ID is remapped on copy');
  const copiedEntry = await mongoose.connection.collection('entries').findOne({ collectionId: copyTarget.id, formatId: copy.dataFormatId, copiedFromEntryId: entry.id });
  assert.equal(copiedEntry.workflow.history.length, entry.workflow.history.length, 'Copy preserves history');
  assert.equal(copiedEntry.workflow.assigneeUserId, undefined, 'Copy does not activate assignment');
  console.log('T40 workflow smoke passed: optional flow, custom rules, roles, assignment, notification, history, import, copy.');
} finally {
  try {
    if (users.length) {
      for (const name of ['collections', 'entries', 'entryreminders']) await mongoose.connection.collection(name).deleteMany({ ownerId: { $in: users } });
      await mongoose.connection.collection('auditlogs').deleteMany({ userId: { $in: users } });
      await mongoose.connection.collection('workflownotifications').deleteMany({ recipientUserId: { $in: users } });
      await mongoose.connection.collection('users').deleteMany({ _id: { $in: users.map((id) => new mongoose.Types.ObjectId(id)) } });
    }
  } finally { await mongoose.disconnect(); }
}
