import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// T49: Task list planner (Day and Calendar views, repeating tasks, per-day checks, legacy upgrade).
const url = process.env.API_URL || `http://localhost:${process.env.PORT || 3000}/graphql`;
let token;
async function gql(query, variables = {}, expectError = false) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
  const body = await response.json();
  if (expectError) { assert.ok(body.errors?.length, 'expected a rejection'); return body.errors[0].message; }
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  return body.data;
}
token = (await gql('mutation($input:RegisterInput!){register(input:$input){token}}', { input: { name: 'Task Tester', email: `tasks-${randomUUID()}@example.test`, password: 'temporary-test-password' } })).register.token;
const ids = [];
const fields = 'id templateId taskPlanner { formatId doneFieldId startFieldId endFieldId repeatFieldId intervalFieldId weekdaysFieldId completedFieldId } savedViews { id layout name } formats { id fields { id name kind options } }';
try {
  const c = (await gql(`mutation{createCollectionFromTemplate(templateId:"tasks",name:"Maison",language:"fr"){${fields}}}`)).createCollectionFromTemplate;
  ids.push(c.id);
  assert.equal(c.templateId, 'tasks');
  assert.deepEqual(c.savedViews.map((view) => view.layout).sort(), ['TASKS', 'TASK_CALENDAR', 'TASK_DAY']);
  const p = c.taskPlanner;
  const add = async (title, extra) => (await gql('mutation($id:String!,$input:SaveEntryInput!){createEntry(collectionId:$id,input:$input){id}}', { id: c.id, input: { formatId: p.formatId, values: [{ fieldId: c.formats[0].fields[0].id, value: title }, ...Object.entries(extra).map(([fieldId, value]) => ({ fieldId, value }))] } })).createEntry.id;
  const period = await add('Peindre la clôture', { [p.startFieldId]: '2026-11-10', [p.endFieldId]: '2026-11-12', [p.repeatFieldId]: 'Une seule fois' });
  const daily = await add('Arroser', { [p.startFieldId]: '2026-11-10', [p.endFieldId]: '2026-11-20', [p.repeatFieldId]: 'Chaque jour' });
  const everyThree = await add('Litière', { [p.startFieldId]: '2026-11-09', [p.repeatFieldId]: 'Tous les N jours', [p.intervalFieldId]: '3' });
  const weekdays = await add('Sport', { [p.startFieldId]: '2026-11-01', [p.repeatFieldId]: 'Certains jours de la semaine', [p.weekdaysFieldId]: JSON.stringify(['Lundi', 'Mercredi']) });
  const monthly = await add('Loyer', { [p.startFieldId]: '2026-01-31', [p.repeatFieldId]: 'Chaque mois' });
  const late = await add('Rendre le livre', { [p.endFieldId]: '2026-11-05' });
  const undated = await add('Appeler maman', {});
  const agenda = async (from, to, today = '2026-11-11') => (await gql('query($id:String!,$from:String!,$to:String!,$today:String!){taskAgenda(collectionId:$id,from:$from,to:$to,today:$today,timeZone:"Africa/Douala"){occurrences{entryId date done overdue repeating} entries{id}}}', { id: c.id, from, to, today })).taskAgenda;
  const days = (list, entry) => list.occurrences.filter((item) => item.entryId === entry).map((item) => item.date);
  const week = await agenda('2026-11-09', '2026-11-14');
  assert.deepEqual(days(week, period), ['2026-11-10', '2026-11-11', '2026-11-12']);
  assert.deepEqual(days(week, daily), ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14']);
  assert.deepEqual(days(week, everyThree), ['2026-11-09', '2026-11-12']);
  assert.deepEqual(days(week, weekdays), ['2026-11-09', '2026-11-11'], 'Monday 9 and Wednesday 11');
  assert.deepEqual(days(week, late), ['2026-11-11']);
  assert.equal(week.occurrences.find((item) => item.entryId === late).overdue, true);
  assert.deepEqual(days(week, undated), ['2026-11-11']);
  assert.deepEqual(days(await agenda('2027-02-01', '2027-03-03'), monthly), ['2027-02-28', '2027-03-31'].filter((day) => day <= '2027-03-03'));

  const check = (entryId, date, done, expectError) => gql('mutation($id:String!,$entry:String!,$date:String!,$done:Boolean!){setTaskDayDone(collectionId:$id,entryId:$entry,date:$date,done:$done,timeZone:"Africa/Douala"){id taskCompletions}}', { id: c.id, entry: entryId, date, done }, expectError);
  assert.deepEqual((await check(daily, '2026-11-11', true)).setTaskDayDone.taskCompletions, ['2026-11-11']);
  assert.match(await check(daily, '2026-11-25', true, true), /not planned/);
  await check(period, '2026-11-11', true);
  const after = await agenda('2026-11-09', '2026-11-14');
  assert.deepEqual(after.occurrences.filter((item) => item.entryId === daily && item.done).map((item) => item.date), ['2026-11-11'], 'a missed day stays missed');
  assert.deepEqual(after.occurrences.filter((item) => item.entryId === period).map((item) => [item.date, item.done]), [['2026-11-11', true]], 'a done period task shows only on its day');

  const notes = (await gql('mutation{createCollectionFromTemplate(templateId:"notes",name:"Notes",language:"fr"){id formats{id}}}')).createCollectionFromTemplate;
  ids.push(notes.id);
  assert.match(await gql('mutation($id:String!,$input:SavedCollectionViewInput!){saveCollectionView(collectionId:$id,input:$input){id}}', { id: notes.id, input: { name: 'Jour', layout: 'TASK_DAY', formatIds: [notes.formats[0].id], columnFieldIds: [], sort: 'NEWEST', groupByFormat: false } }, true), /Task list template/);

  const legacy = (await gql('mutation($input:CreateCollectionInput!){createCollection(input:$input){id formats{id fields{id kind}}}}', { input: { name: 'Task list', formats: [{ name: 'Task', color: '#FFF5EB', fields: [{ name: 'Title', kind: 'TITLE' }, { name: 'Done', kind: 'BOOLEAN' }, { name: 'Due', kind: 'DATE' }, { name: 'Completed at', kind: 'DATETIME' }] }] } })).createCollection;
  ids.push(legacy.id);
  const kept = (await gql('mutation($id:String!,$input:SaveEntryInput!){createEntry(collectionId:$id,input:$input){id}}', { id: legacy.id, input: { formatId: legacy.formats[0].id, values: [{ fieldId: legacy.formats[0].fields[0].id, value: 'Ancienne tâche' }, { fieldId: legacy.formats[0].fields[2].id, value: '2026-11-11' }] } })).createEntry.id;
  const upgraded = (await gql(`mutation($id:String!){enableTaskPlanner(collectionId:$id,language:"en"){${fields}}}`, { id: legacy.id })).enableTaskPlanner;
  assert.equal(upgraded.templateId, 'tasks');
  assert.equal(upgraded.taskPlanner.endFieldId, legacy.formats[0].fields[2].id, 'the old due date becomes the end');
  assert.ok(upgraded.savedViews.some((view) => view.layout === 'TASK_DAY'));
  const legacyDay = (await gql('query($id:String!){taskAgenda(collectionId:$id,from:"2026-11-11",to:"2026-11-11",today:"2026-11-11",timeZone:"UTC"){occurrences{entryId}}}', { id: legacy.id })).taskAgenda;
  assert.deepEqual(legacyDay.occurrences.map((item) => item.entryId), [kept]);
  console.log('TASK_PLANNER_SMOKE_PASSED');
} finally {
  for (const id of ids) await gql('mutation($id:String!){deleteCollection(id:$id)}', { id });
}
