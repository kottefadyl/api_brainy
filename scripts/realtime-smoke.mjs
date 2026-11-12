// Real-time signals end to end, against the Firebase emulators and an API started with them:
//   npx firebase-tools emulators:start --only firestore,auth --project demo-brainy   (repository root, Java needed)
//   PORT=3103 FIREBASE_PROJECT_ID=demo-brainy FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 node --env-file=.env dist/main.js
//   API_URL=http://localhost:3103/graphql npm run smoke:realtime
// The listener uses the real Firebase web SDK and the real firestore.rules.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import mongoose from 'mongoose';
import { collaborate } from './collaborate-helper.mjs';

const web = createRequire(new URL('../../brainy_web_app/package.json', import.meta.url));
const { initializeApp, deleteApp } = web('firebase/app');
const { getAuth, connectAuthEmulator, signInWithCustomToken } = web('firebase/auth');
const { getFirestore, connectFirestoreEmulator, collection, query, where, onSnapshot, doc, getDoc } = web('firebase/firestore');

const url = process.env.API_URL ?? 'http://localhost:3103/graphql';
process.env.PORT = new URL(url).port; // collaborate-helper calls the same API
assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI for cleanup');
await mongoose.connect(process.env.MONGODB_URI);
const call = async (q, variables = {}, token) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query: q, variables }) })).json();
const data = (result) => { assert.equal(result.errors, undefined, JSON.stringify(result.errors)); return result.data; };
const users = [];
const register = async (name) => { const auth = data(await call('mutation($i:RegisterInput!){register(input:$i){token user{id}}}', { i: { name, email: `rt-${randomUUID()}@example.test`, password: 'test-password-123' } })).register; users.push(auth.user.id); return auth; };

/** A person's listener: a Firebase client signed in with the API's custom token. */
async function listen(person) {
  const app = initializeApp({ projectId: 'demo-brainy', apiKey: 'demo-key', appId: 'demo' }, `rt-${person.user.id}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  const db = getFirestore(app);
  connectFirestoreEmulator(db, '127.0.0.1', 8085);
  const token = data(await call('{realtimeToken}', {}, person.token)).realtimeToken;
  assert.ok(token, 'the API gives a realtime token');
  await signInWithCustomToken(auth, token);
  const events = [];
  let ready;
  const first = new Promise((resolve) => { ready = resolve; });
  const stop = onSnapshot(query(collection(db, 'brainy_signals'), where('readers', 'array-contains', person.user.id)), (snapshot) => {
    for (const change of snapshot.docChanges()) events.push({ type: change.type, id: change.doc.id, ...change.doc.data() });
    ready();
  }, (error) => events.push({ error: error.code }));
  await first;
  return { app, db, events, stop, close: async () => { stop(); await deleteApp(app); } };
}
const waitFor = async (check, what) => { for (let i = 0; i < 50; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 100)); } assert.fail(`timed out waiting for ${what}`); };

const listeners = [];
try {
  const awa = await register('Awa'), bruno = await register('Bruno'), chloe = await register('Chloé');
  await collaborate(awa.token, bruno.token);
  const house = data(await call('mutation($i:CreateCollectionInput!){createCollection(input:$i){id formats{id fields{id}}}}', { i: { name: 'Maison', formats: [{ name: 'Note', color: '#EEF5FF', fields: [{ name: 'Titre', kind: 'TITLE' }] }] } }, awa.token)).createCollection;
  data(await call('mutation($c:String!,$u:String,$r:CollectionRole!){addCollectionMember(collectionId:$c,memberUserId:$u,role:$r){id}}', { c: house.id, u: bruno.user.id, r: 'EDITOR' }, awa.token));

  const brunoSees = await listen(bruno);
  listeners.push(brunoSees);
  const before = brunoSees.events.filter((event) => event.id === house.id).length;

  // Awa writes: Bruno is told at once, with who did it.
  const format = house.formats[0];
  const entry = data(await call('mutation($c:String!,$i:SaveEntryInput!){createEntry(collectionId:$c,input:$i){id}}', { c: house.id, i: { formatId: format.id, values: [{ fieldId: format.fields[0].id, value: 'Pain' }] } }, awa.token)).createEntry;
  await waitFor(() => brunoSees.events.filter((event) => event.id === house.id).length > before, 'the signal of a new entry');
  const signal = brunoSees.events.filter((event) => event.id === house.id).at(-1);
  assert.equal(signal.by, awa.user.id);
  assert.equal(signal.kind, 'createEntry');
  assert.deepEqual([...signal.readers].sort(), [awa.user.id, bruno.user.id].sort());

  // A deletion (only the entry ID in the arguments) is signalled too.
  const count = brunoSees.events.length;
  data(await call('mutation($id:String!){deleteEntry(id:$id)}', { id: entry.id }, awa.token));
  await waitFor(() => brunoSees.events.length > count, 'the signal of a deletion');
  assert.equal(brunoSees.events.at(-1).kind, 'deleteEntry');

  // Someone else cannot read the signal, even knowing the collection ID.
  const chloeSees = await listen(chloe);
  listeners.push(chloeSees);
  assert.equal(chloeSees.events.length, 0, 'no signal of a collection that is not hers');
  await assert.rejects(getDoc(doc(chloeSees.db, 'brainy_signals', house.id)), /permission/i, 'the rules refuse a direct read');

  // Removing Bruno's access removes the signal from his listener: his app reloads and the collection goes.
  data(await call('mutation($c:String!,$u:String!){removeCollectionMember(collectionId:$c,memberUserId:$u){id}}', { c: house.id, u: bruno.user.id }, awa.token));
  await waitFor(() => brunoSees.events.some((event) => event.id === house.id && event.type === 'removed'), 'the end of access');
  console.log('Realtime smoke passed: token, signal on create and delete, author, readers, rules refuse a stranger, end of access.');
} finally {
  for (const listener of listeners) await listener.close().catch(() => undefined);
  const db = mongoose.connection.db;
  const ids = (await db.collection('collections').find({ ownerId: { $in: users } }).project({ _id: 1 }).toArray()).map((item) => String(item._id));
  await db.collection('entries').deleteMany({ collectionId: { $in: ids } });
  await db.collection('auditlogs').deleteMany({ collectionId: { $in: ids } });
  await db.collection('collections').deleteMany({ ownerId: { $in: users } });
  await db.collection('collaborations').deleteMany({ userIds: { $in: users } });
  await db.collection('collaboratorinvites').deleteMany({ userId: { $in: users } });
  await db.collection('users').deleteMany({ _id: { $in: users.map((id) => new mongoose.Types.ObjectId(id)) } });
  await mongoose.disconnect();
}
