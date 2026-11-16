// T56: Two-sided cards — template with faces, review sessions (due, oldest, newest, random), spaced repetition per person.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

const endpoint = `http://localhost:${process.env.PORT ?? 3000}/graphql`;
assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI for cleanup');
await mongoose.connect(process.env.MONGODB_URI);
const call = async (query, variables = {}, token) => (await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) })).json();
const data = (result) => { assert.equal(result.errors, undefined, JSON.stringify(result.errors)); return result.data; };
const users = [];
const register = async (name) => { const auth = data(await call('mutation($i:RegisterInput!){register(input:$i){token user{id}}}', { i: { name, email: `cards-${randomUUID()}@example.test`, password: 'test-password-123' } })).register; users.push(auth.user.id); return auth; };

try {
  const ana = await register('Ana');
  const ben = await register('Ben');
  const deck = data(await call('mutation{createCollectionFromTemplate(templateId:"cards",name:"Español",language:"en"){id templateId calculations formats{id name fields{id name kind face}}}}', {}, ana.token)).createCollectionFromTemplate;
  assert.equal(deck.templateId, 'cards');
  assert.equal(deck.calculations, false, 'a learning collection starts simple');
  const card = deck.formats[0];
  assert.deepEqual(card.fields.map((field) => field.face), ['FRONT', 'FRONT', 'FRONT', 'BACK', 'BACK', 'BACK', 'BACK']);
  const [word, , , definition] = card.fields;
  const words = [['hola', 'hello'], ['gracias', 'thank you'], ['adiós', 'goodbye']];
  const ids = [];
  for (const [front, back] of words) ids.push(data(await call('mutation($c:String!,$i:SaveEntryInput!){createEntry(collectionId:$c,input:$i){id}}', { c: deck.id, i: { formatId: card.id, values: [{ fieldId: word.id, value: front }, { fieldId: definition.id, value: back }] } }, ana.token)).createEntry.id);

  const decks = 'query($c:String!){cardDecks(collectionId:$c){formatId total due fresh}}';
  assert.deepEqual(data(await call(decks, { c: deck.id }, ana.token)).cardDecks, [{ formatId: card.id, total: 3, due: 0, fresh: 3 }]);
  const session = (order, count = 10, token = ana.token) => call('query($c:String!,$f:String!,$n:Int!,$o:CardReviewOrder!){cardReviewSession(collectionId:$c,formatId:$f,count:$n,order:$o){entry{id} state{intervalDays reps} preview{again hard good easy}}}', { c: deck.id, f: card.id, n: count, o: order }, token).then((result) => data(result).cardReviewSession);
  assert.deepEqual((await session('OLDEST')).map((item) => item.entry.id), ids);
  assert.deepEqual((await session('NEWEST', 2)).map((item) => item.entry.id), [ids[2], ids[1]]);
  assert.deepEqual((await session('RANDOM')).map((item) => item.entry.id).sort(), [...ids].sort());
  const first = (await session('DUE'))[0];
  assert.deepEqual(first.preview, { again: 10, hard: 1440, good: 1440, easy: 5760 }, 'new card: 10 min, 1 d, 1 d, 4 d');

  const grade = (entryId, value, token = ana.token) => call('mutation($c:String!,$e:String!,$g:CardGrade!){gradeCard(collectionId:$c,entryId:$e,grade:$g){intervalDays reps lapses ease due lastGrade}}', { c: deck.id, e: entryId, g: value }, token).then((result) => data(result).gradeCard);
  const good = await grade(ids[0], 'GOOD');
  assert.deepEqual([good.intervalDays, good.reps, good.lastGrade], [1, 1, 'GOOD']);
  const again = await grade(ids[1], 'AGAIN');
  assert.deepEqual([again.intervalDays, again.reps], [0, 0]);
  assert.ok(new Date(again.due).getTime() - Date.now() < 11 * 60_000, 'a forgotten card comes back in 10 minutes');
  await grade(ids[2], 'EASY');
  // Later answers grow the interval: simulate the card being due again.
  await mongoose.connection.db.collection('cardreviewstates').updateOne({ userId: ana.user.id, entryId: ids[0] }, { $set: { due: new Date(Date.now() - 1000) } });
  assert.deepEqual((await session('DUE')).map((item) => item.entry.id), [ids[0]], 'only the card due now (the others are scheduled later)');
  const second = await grade(ids[0], 'GOOD');
  assert.deepEqual([second.intervalDays, second.reps], [3, 2], '1 day × ease 2.5 → 3 days');
  assert.deepEqual(data(await call(decks, { c: deck.id }, ana.token)).cardDecks[0], { formatId: card.id, total: 3, due: 0, fresh: 0 });

  // A collaborator reviews with their own schedule and never changes the owner's.
  const { collaborationInviteToken } = data(await call('query{collaborationInviteToken}', {}, ana.token));
  data(await call('mutation($t:String!){acceptCollaboration(token:$t){userId}}', { t: collaborationInviteToken }, ben.token));
  data(await call('mutation($c:String!,$u:String,$r:CollectionRole!){addCollectionMember(collectionId:$c,memberUserId:$u,role:$r){id}}', { c: deck.id, u: ben.user.id, r: 'READER' }, ana.token));
  assert.deepEqual(data(await call(decks, { c: deck.id }, ben.token)).cardDecks[0], { formatId: card.id, total: 3, due: 0, fresh: 3 }, 'Ben starts fresh');
  await grade(ids[0], 'AGAIN', ben.token);
  assert.equal((await mongoose.connection.db.collection('cardreviewstates').findOne({ userId: ana.user.id, entryId: ids[0] })).reps, 2, 'Ana keeps her progress');

  // Read-aloud language per data format (owner only), and cards only in Flash cards collections.
  const language = data(await call('mutation($c:String!,$f:String!,$l:String){setCardSpeechLanguage(collectionId:$c,formatId:$f,language:$l){formats{speechLanguage}}}', { c: deck.id, f: card.id, l: 'es-ES' }, ana.token)).setCardSpeechLanguage;
  assert.equal(language.formats[0].speechLanguage, 'es-ES');
  assert.match((await call('mutation($c:String!,$f:String!,$l:String){setCardSpeechLanguage(collectionId:$c,formatId:$f,language:$l){id}}', { c: deck.id, f: card.id, l: 'fr-FR' }, ben.token)).errors[0].message, /owner/i);
  const notes = data(await call('mutation{createCollectionFromTemplate(templateId:"notes",name:"N",language:"en"){id formats{id}}}', {}, ana.token)).createCollectionFromTemplate;
  assert.match((await call('query($c:String!){cardDecks(collectionId:$c){total}}', { c: notes.id }, ana.token)).errors[0].message, /only in Flash cards/);
  assert.equal(data(await call('mutation($c:String!){resetCardReviews(collectionId:$c)}', { c: deck.id }, ana.token)).resetCardReviews, true);
  assert.equal(data(await call(decks, { c: deck.id }, ana.token)).cardDecks[0].fresh, 3);
  console.log('Flash cards smoke passed: template faces, session orders, spaced repetition, per-person schedules, read-aloud language.');
} finally {
  const db = mongoose.connection.db;
  const ids = (await db.collection('collections').find({ ownerId: { $in: users } }).project({ _id: 1 }).toArray()).map((item) => String(item._id));
  await db.collection('entries').deleteMany({ collectionId: { $in: ids } });
  await db.collection('cardreviewstates').deleteMany({ userId: { $in: users } });
  await db.collection('auditlogs').deleteMany({ collectionId: { $in: ids } });
  await db.collection('collections').deleteMany({ ownerId: { $in: users } });
  await db.collection('collaborations').deleteMany({ userIds: { $in: users } });
  await db.collection('collaboratorinvites').deleteMany({ userId: { $in: users } });
  await db.collection('users').deleteMany({ _id: { $in: users.map((id) => new mongoose.Types.ObjectId(id)) } });
  await mongoose.disconnect();
}
