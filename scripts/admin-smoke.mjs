// Administration (web /admin), account view preferences, list fields and entry counts, against a running
// API started with BRAINY_ADMIN_EMAILS=admin-smoke@example.test (npm run smoke:admin). Cleans up after itself.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

const url = `http://localhost:${process.env.PORT ?? 3000}/graphql`;
const adminEmail = 'admin-smoke@example.test';
const suffix = randomUUID().slice(0, 8);
const userIds = [];
assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI to run and clean up smoke data');
await mongoose.connect(process.env.MONGODB_URI);
const users = mongoose.connection.collection('users');

async function graphql(query, variables = {}, token) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
  return response.json();
}
const data = (result) => { assert.equal(result.errors, undefined, JSON.stringify(result.errors)); return result.data; };
const refused = (result, text) => { assert.ok(result.errors?.some((error) => error.message.includes(text)), `expected "${text}", got ${JSON.stringify(result.errors ?? result.data)}`); };
const register = async (name, email) => {
  const { register: payload } = data(await graphql('mutation($input: RegisterInput!) { register(input: $input) { token user { id } } }', { input: { name, email, password: 'test-password-123' } }));
  userIds.push(payload.user.id);
  return payload;
};
const login = (email) => graphql('mutation($input: LoginInput!) { login(input: $input) { token } }', { input: { email, password: 'test-password-123' } });

try {
  await users.deleteMany({ email: adminEmail });
  const admin = await register('Admin Smoke', adminEmail);
  const target = await register('Target Smoke', `target-${suffix}@example.test`);
  const other = await register('Other Smoke', `other-${suffix}@example.test`);

  // The target owns a collection with entries; list fields are limited to three.
  const fields = [{ name: 'Title', kind: 'TITLE', showInList: true }, { name: 'A', kind: 'TEXT', showInList: true }, { name: 'B', kind: 'TEXT', showInList: true }, { name: 'C', kind: 'TEXT', showInList: true }];
  refused(await graphql('mutation($input: CreateCollectionInput!) { createCollection(input: $input) { id } }', { input: { name: 'Too many', formats: [{ name: 'Notes', color: '#EEF5FF', fields }] } }, target.token), 'at most 3 fields');
  fields[3].showInList = false;
  const collection = data(await graphql('mutation($input: CreateCollectionInput!) { createCollection(input: $input) { id formats { id maxEntries fields { id showInList } } } }', { input: { name: 'Notes', formats: [{ name: 'Notes', color: '#EEF5FF', maxEntries: 5, fields }] } }, target.token)).createCollection;
  assert.deepEqual(collection.formats[0].fields.map((field) => !!field.showInList), [true, true, true, false]);
  const format = collection.formats[0];
  for (const title of ['one', 'two']) data(await graphql('mutation($id: String!, $input: SaveEntryInput!) { createEntry(collectionId: $id, input: $input) { id } }', { id: collection.id, input: { formatId: format.id, values: [{ fieldId: format.fields[0].id, value: title }] } }, target.token));
  const counts = data(await graphql('query($id: String!) { formatEntryCounts(collectionId: $id) { formatId count } }', { id: collection.id }, target.token)).formatEntryCounts;
  assert.deepEqual(counts, [{ formatId: format.id, count: 2 }]);

  // View preferences live on the account.
  const saved = data(await graphql('mutation($input: ViewPreferencesInput!) { saveViewPreferences(input: $input) { viewPreferences { lastCollectionId pageSize views { collectionId viewId } } } }', { input: { lastCollectionId: collection.id, pageSize: 50, views: [{ collectionId: collection.id, viewId: 'view-1' }] } }, target.token)).saveViewPreferences.viewPreferences;
  assert.equal(saved.pageSize, 50);
  const me = data(await graphql('{ me { viewPreferences { lastCollectionId views { viewId } } } }', {}, target.token)).me;
  assert.equal(me.viewPreferences.lastCollectionId, collection.id);
  refused(await graphql('mutation($input: ViewPreferencesInput!) { saveViewPreferences(input: $input) { id } }', { input: { pageSize: 7, views: [] } }, target.token), '30, 50 or 100');

  // Only the administrator gets in.
  assert.equal(data(await graphql('{ adminAccess }', {}, other.token)).adminAccess, false);
  assert.equal(data(await graphql('{ adminAccess }')).adminAccess, false);
  refused(await graphql('{ adminOverview { userCount } }', {}, other.token), 'reserved to the Brainy administrator');
  refused(await graphql('mutation($id: String!) { adminSetUserBlocked(userId: $id, blocked: true) }', { id: target.user.id }, other.token), 'reserved');
  assert.equal(data(await graphql('{ adminAccess }', {}, admin.token)).adminAccess, true);
  const overview = data(await graphql('{ adminOverview { userCount users { id email admin collections entries databaseBytes fileBytes totalBytes } } }', {}, admin.token)).adminOverview;
  const row = overview.users.find((user) => user.id === target.user.id);
  assert.equal(row.collections, 1);
  assert.equal(row.entries, 2);
  assert.ok(row.databaseBytes > 0 && row.totalBytes >= row.databaseBytes);
  assert.equal(overview.users.find((user) => user.id === admin.user.id).admin, true);
  refused(await graphql('mutation($id: String!) { adminSetUserBlocked(userId: $id, blocked: true) }', { id: admin.user.id }, admin.token), 'cannot be changed');

  // Blocking closes sign-in and open sessions; unblocking reopens them.
  assert.equal(data(await graphql('mutation($id: String!) { adminSetUserBlocked(userId: $id, blocked: true) }', { id: target.user.id }, admin.token)).adminSetUserBlocked, true);
  refused(await login(`target-${suffix}@example.test`), 'This account is blocked');
  refused(await graphql('{ me { id } }', {}, target.token), 'This account is blocked');
  assert.equal(data(await graphql('mutation($id: String!) { adminSetUserBlocked(userId: $id, blocked: false) }', { id: target.user.id }, admin.token)).adminSetUserBlocked, false);
  data(await login(`target-${suffix}@example.test`));

  // Erasing needs the email typed again; the account stays, empty.
  const erase = 'mutation($id: String!, $email: String!, $delete: Boolean!) { adminEraseUser(userId: $id, confirmEmail: $email, deleteAccount: $delete) { collections documents accountDeleted } }';
  refused(await graphql(erase, { id: target.user.id, email: 'wrong@example.test', delete: false }, admin.token), 'Type the account email');
  const erased = data(await graphql(erase, { id: target.user.id, email: `target-${suffix}@example.test`, delete: false }, admin.token)).adminEraseUser;
  assert.equal(erased.collections, 1);
  assert.ok(erased.documents >= 3);
  assert.equal(erased.accountDeleted, false);
  assert.deepEqual(data(await graphql('{ collectionsList { id } }', {}, target.token)).collectionsList, []);
  assert.equal(await mongoose.connection.collection('entries').countDocuments({ collectionId: collection.id }), 0);
  assert.equal(data(await graphql('{ me { profileCompleted viewPreferences { pageSize } } }', {}, target.token)).me.viewPreferences, null);

  // Deleting removes the account itself.
  const deleted = data(await graphql(erase, { id: other.user.id, email: `other-${suffix}@example.test`, delete: true }, admin.token)).adminEraseUser;
  assert.equal(deleted.accountDeleted, true);
  assert.equal(await users.countDocuments({ _id: new mongoose.Types.ObjectId(other.user.id) }), 0);
  refused(await graphql('{ me { id } }', {}, other.token), 'Invalid or expired session');

  console.log('admin smoke passed');
} finally {
  try {
    const ids = userIds.map((id) => new mongoose.Types.ObjectId(id));
    const collections = await mongoose.connection.collection('collections').find({ ownerId: { $in: userIds } }).toArray();
    await mongoose.connection.collection('entries').deleteMany({ collectionId: { $in: collections.map((item) => item._id.toString()) } });
    await mongoose.connection.collection('collections').deleteMany({ ownerId: { $in: userIds } });
    await users.deleteMany({ _id: { $in: ids } });
  } finally {
    await mongoose.disconnect();
  }
}
