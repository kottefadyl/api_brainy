// T57: learning progress on two-sided cards — answer log, statistics, daily goal, new-card limit, data per person.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

const endpoint = `http://localhost:${process.env.PORT ?? 3000}/graphql`;
assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI for cleanup');
await mongoose.connect(process.env.MONGODB_URI);
const call = async (query, variables = {}, token) => (await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) })).json();
const data = (result) => { assert.equal(result.errors, undefined, JSON.stringify(result.errors)); return result.data; };
const users = [];
const register = async (name) => { const auth = data(await call('mutation($i:RegisterInput!){register(input:$i){token user{id}}}', { i: { name, email: `progress-${randomUUID()}@example.test`, password: 'test-password-123' } })).register; users.push(auth.user.id); return auth; };
const offset = 120; // Ana lives at UTC+2.
const localToday = (shiftDays = 0) => new Date(Date.now() + offset * 60_000 + shiftDays * 86_400_000).toISOString().slice(0, 10);
const STATS = 'query($c:String!,$f:String,$o:Int){cardStats(collectionId:$c,formatId:$f,utcOffsetMinutes:$o){total fresh learning mature reviewed7 reviewed30 successRate30 days{day answers remembered} forecast hardest{entryId title forgotten} today{reviewed newCards goal newLimit streak}}}';

try {
  const ana = await register('Ana');
  const ben = await register('Ben');
  const deck = data(await call('mutation{createCollectionFromTemplate(templateId:"cards",name:"Español",language:"en"){id calculations formats{id fields{id kind}}}}', {}, ana.token)).createCollectionFromTemplate;
  assert.equal(deck.calculations, false);
  const format = deck.formats[0];
  const title = format.fields.find((field) => field.kind === 'TITLE');
  const ids = [];
  for (const word of ['hola', 'gracias', 'adiós', 'perro', 'gato']) ids.push(data(await call('mutation($c:String!,$i:SaveEntryInput!){createEntry(collectionId:$c,input:$i){id}}', { c: deck.id, i: { formatId: format.id, values: [{ fieldId: title.id, value: word }] } }, ana.token)).createEntry.id);
  const stats = (token = ana.token, formatId = null) => call(STATS, { c: deck.id, f: formatId, o: offset }, token).then((result) => data(result).cardStats);

  // Before any review: everything is new; statistics stay available though "Calculations and statistics" is off.
  let s = await stats();
  assert.deepEqual([s.total, s.fresh, s.learning, s.mature, s.reviewed30, s.successRate30], [5, 5, 0, 0, 0, null]);
  assert.equal(s.days.length, 30);
  assert.deepEqual(s.today, { reviewed: 0, newCards: 0, goal: null, newLimit: null, streak: 0 });

  // Daily goal: 3 cards, at most 2 new cards a day; bad values are refused.
  const goal = (reviews, fresh, token = ana.token) => call('mutation($c:String!,$r:Int,$n:Int){setCardGoal(collectionId:$c,reviewsPerDay:$r,newPerDay:$n){reviewsPerDay newPerDay}}', { c: deck.id, r: reviews, n: fresh }, token);
  assert.match((await goal(0, 2)).errors[0].message, /whole number from 1 to 9999/);
  assert.deepEqual(data(await goal(3, 2)).setCardGoal, { reviewsPerDay: 3, newPerDay: 2 });
  const session = (token = ana.token) => call('query($c:String!,$f:String!,$o:Int){cardReviewSession(collectionId:$c,formatId:$f,count:10,order:DUE,utcOffsetMinutes:$o){entry{id}}}', { c: deck.id, f: format.id, o: offset }, token).then((result) => data(result).cardReviewSession.map((card) => card.entry.id));
  assert.deepEqual(await session(), ids.slice(0, 2), 'only 2 new cards today');
  const grade = (entryId, value, token = ana.token) => call('mutation($c:String!,$e:String!,$g:CardGrade!,$o:Int){gradeCard(collectionId:$c,entryId:$e,grade:$g,utcOffsetMinutes:$o){reps}}', { c: deck.id, e: entryId, g: value, o: offset }, token).then(data);
  await grade(ids[0], 'GOOD');
  await grade(ids[1], 'AGAIN');
  await grade(ids[1], 'GOOD');
  assert.deepEqual(await session(), [], 'the daily limit of new cards is reached');
  // Free orders (oldest, newest, random) are not limited.
  assert.equal(data(await call('query($c:String!,$f:String!){cardReviewSession(collectionId:$c,formatId:$f,count:10,order:OLDEST){entry{id}}}', { c: deck.id, f: format.id }, ana.token)).cardReviewSession.length, 5);

  s = await stats();
  assert.deepEqual([s.fresh, s.learning, s.mature, s.reviewed7, s.reviewed30], [3, 2, 0, 3, 3]);
  assert.equal(Math.round(s.successRate30 * 100), 67, '2 of 3 answers remembered');
  assert.deepEqual(s.today, { reviewed: 2, newCards: 2, goal: 3, newLimit: 2, streak: 0 }, '2 of 3 today: no streak yet');
  assert.deepEqual(s.days.at(-1), { day: localToday(), answers: 3, remembered: 2 });
  assert.deepEqual(s.hardest, [{ entryId: ids[1], title: 'gracias', forgotten: 1 }]);
  assert.equal(s.forecast.length, 7);
  assert.equal(s.forecast.reduce((a, b) => a + b, 0), 2, 'both reviewed cards come back within a week');
  assert.equal((await stats(ana.token, format.id)).reviewed30, 3, 'per data format');

  // Yesterday's goal reached; today reached too → 2 days in a row.
  await mongoose.connection.db.collection('cardanswers').insertMany([2, 3, 4].map((index) => ({ userId: ana.user.id, collectionId: deck.id, formatId: format.id, entryId: ids[index], grade: 'GOOD', wasNew: false, day: localToday(-1), at: new Date(Date.now() - 86_400_000) })));
  assert.equal((await stats()).today.streak, 1, 'yesterday counts while today is not reached yet');
  await mongoose.connection.db.collection('cardreviewstates').updateOne({ userId: ana.user.id, entryId: ids[0] }, { $set: { due: new Date(Date.now() - 1000), intervalDays: 30, reps: 3 } });
  await grade(ids[0], 'GOOD');
  assert.equal((await stats()).today.streak, 1, 'the same card twice counts once: still 2 of 3 today');
  await grade(ids[2], 'GOOD');
  s = await stats();
  assert.equal(s.today.streak, 2);
  assert.equal(s.mature, 1, 'a card coming back in 21 days or more is learned');

  // Another person has their own statistics and goal.
  const { collaborationInviteToken } = data(await call('query{collaborationInviteToken}', {}, ana.token));
  data(await call('mutation($t:String!){acceptCollaboration(token:$t){userId}}', { t: collaborationInviteToken }, ben.token));
  data(await call('mutation($c:String!,$u:String,$r:CollectionRole!){addCollectionMember(collectionId:$c,memberUserId:$u,role:$r){id}}', { c: deck.id, u: ben.user.id, r: 'READER' }, ana.token));
  const benStats = await stats(ben.token);
  assert.deepEqual([benStats.fresh, benStats.reviewed30, benStats.today.goal], [5, 0, null]);
  assert.deepEqual(data(await goal(10, null, ben.token)).setCardGoal, { reviewsPerDay: 10, newPerDay: null }, 'a reader sets their own goal');
  assert.equal((await session(ben.token)).length, 5, 'no new-card limit for Ben');

  // Forgetting my history also clears my answer log.
  data(await call('mutation($c:String!){resetCardReviews(collectionId:$c)}', { c: deck.id }, ana.token));
  s = await stats();
  assert.deepEqual([s.fresh, s.reviewed30, s.today.streak], [5, 0, 0]);
  console.log('Card progress smoke passed');
} finally {
  const db = mongoose.connection.db;
  const owned = await db.collection('collections').find({ ownerId: { $in: users } }).project({ _id: 1 }).toArray();
  const collectionIds = owned.map((item) => item._id.toString());
  for (const name of ['entries', 'cardreviewstates', 'cardanswers', 'cardgoals']) await db.collection(name).deleteMany({ collectionId: { $in: collectionIds } });
  await db.collection('collections').deleteMany({ ownerId: { $in: users } });
  await db.collection('collaborations').deleteMany({ userIds: { $in: users } });
  await db.collection('collaboratorinvites').deleteMany({ userId: { $in: users } });
  await db.collection('users').deleteMany({ _id: { $in: users.map((id) => new mongoose.Types.ObjectId(id)) } });
  await mongoose.disconnect();
}
