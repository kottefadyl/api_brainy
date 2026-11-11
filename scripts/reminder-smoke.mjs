import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { createRequire } from 'node:module';
import mongoose from 'mongoose';

const require = createRequire(import.meta.url);
require('reflect-metadata');
const { CollectionSchema } = require('../dist/collections/collection.schema.js');
const { EntrySchema } = require('../dist/collections/entry.schema.js');
const { UserSchema } = require('../dist/auth/user.schema.js');
const { EntryReminderSchema, ReminderDeliverySchema, PushDeviceSchema } = require('../dist/collections/reminder.schema.js');
const { ReminderService } = require('../dist/collections/reminder.service.js');

assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI');
const messages = [];
const smtp = net.createServer((socket) => {
  socket.setEncoding('utf8');
  socket.write('220 localhost Brainy test SMTP\r\n');
  let buffer = '', body = '', inData = false;
  socket.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index + 1).replace(/\r?\n$/, '');
      buffer = buffer.slice(index + 1);
      if (inData) {
        if (line === '.') { messages.push(body); body = ''; inData = false; socket.write('250 2.0.0 accepted\r\n'); }
        else body += `${line}\n`;
      } else if (/^EHLO|^HELO/i.test(line)) socket.write('250-localhost\r\n250 SIZE 1048576\r\n');
      else if (/^DATA/i.test(line)) { inData = true; socket.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
      else if (/^QUIT/i.test(line)) { socket.write('221 bye\r\n'); socket.end(); }
      else socket.write('250 ok\r\n');
    }
  });
});
await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(smtp.address().port);
process.env.SMTP_FROM = 'Brainy <reminders@example.test>';
process.env.SMTP_SECURE = 'false';
process.env.SMTP_REQUIRE_TLS = 'false';
delete process.env.SMTP_USER;
delete process.env.SMTP_PASSWORD;

await mongoose.connect(process.env.MONGODB_URI);
const User = mongoose.model('ReminderSmokeUser', UserSchema, 'users');
const Collection = mongoose.model('ReminderSmokeCollection', CollectionSchema, 'collections');
const Entry = mongoose.model('ReminderSmokeEntry', EntrySchema, 'entries');
const Reminder = mongoose.model('ReminderSmokeReminder', EntryReminderSchema, 'entryreminders');
const Delivery = mongoose.model('ReminderSmokeDelivery', ReminderDeliverySchema, 'reminderdeliveries');
const Device = mongoose.model('ReminderSmokeDevice', PushDeviceSchema, 'pushdevices');
const service = new ReminderService(Reminder, Delivery, Device, Collection, Entry, User);
const ownerId = new mongoose.Types.ObjectId().toString();
const collectionId = new mongoose.Types.ObjectId().toString();
const entryId = new mongoose.Types.ObjectId().toString();
const fieldId = randomUUID();
const formatId = randomUUID();
try {
  await mongoose.connection.collection('users').insertOne({ _id: new mongoose.Types.ObjectId(ownerId), name: 'SMTP tester', email: `smtp-${randomUUID()}@example.test` });
  await mongoose.connection.collection('collections').insertOne({ _id: new mongoose.Types.ObjectId(collectionId), ownerId, name: 'Test reminders', formats: [{ id: formatId, name: 'Events', color: '#EEF5FF', version: 1, fields: [{ id: fieldId, name: 'Start', kind: 'DATETIME' }] }] });
  const firstDate = new Date(Date.now() + 60_000);
  await mongoose.connection.collection('entries').insertOne({ _id: new mongoose.Types.ObjectId(entryId), ownerId, collectionId, formatId, values: [{ fieldId, value: firstDate.toISOString() }] });
  const input = { fieldId, minutesBefore: 0, timeZone: 'UTC', channels: ['EMAIL'] };
  const reminder = await service.save(entryId, ownerId, input);
  assert.equal(reminder.state, 'ACTIVE');
  assert.equal(await service.list(entryId, '000000000000000000000001').then(() => false, () => true), true, 'foreign account cannot list reminder');
  const changedDate = new Date(Date.now() + 1100);
  await Entry.updateOne({ _id: entryId }, { $set: { values: [{ fieldId, value: changedDate.toISOString() }] } });
  await service.refreshEntry(entryId, ownerId);
  const scheduled = await Reminder.findById(reminder.id);
  assert.equal(scheduled.occurrenceAt.toISOString(), changedDate.toISOString(), 'editing an entry reschedules its reminder');
  await new Promise((resolve) => setTimeout(resolve, 1300));
  await service.processDue();
  assert.equal(messages.length, 1, 'SMTP receives one message');
  await service.processDue();
  assert.equal(messages.length, 1, 'retry after successful delivery stays idempotent');
  assert.equal((await Reminder.findById(reminder.id)).state, 'DONE');
  assert.equal(await Delivery.countDocuments({ reminderId: reminder.id, state: 'SENT' }), 1);
  const nearEntryId = new mongoose.Types.ObjectId().toString();
  await mongoose.connection.collection('entries').insertOne({ _id: new mongoose.Types.ObjectId(nearEntryId), ownerId, collectionId, formatId, values: [{ fieldId, value: new Date(Date.now() + 5 * 60_000).toISOString() }] });
  const immediate = await service.save(nearEntryId, ownerId, { ...input, minutesBefore: 15 });
  assert.ok(immediate.nextAt.getTime() <= Date.now(), 'late creation is ready for immediate delivery');
  await service.processDue();
  assert.equal(messages.length, 2, 'late creation sends immediately');
  process.env.FIREBASE_PROJECT_ID = 'brainy-test';
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: 'brainy-test', client_email: 'test@example.test', private_key: 'test' });
  const firstDevice = await service.registerDevice(ownerId, `fid-${randomUUID()}`, 'ANDROID', 'First phone', 'FID');
  const secondDevice = await service.registerDevice(ownerId, `fid-${randomUUID()}`, 'ANDROID', 'Second phone', 'FID');
  const pushEntryId = new mongoose.Types.ObjectId().toString();
  await mongoose.connection.collection('entries').insertOne({ _id: new mongoose.Types.ObjectId(pushEntryId), ownerId, collectionId, formatId, values: [{ fieldId, value: new Date(Date.now() + 1100).toISOString() }] });
  const pushReminder = await service.save(pushEntryId, ownerId, { ...input, channels: ['PUSH'] });
  const calls = new Map();
  service.send = async (_channel, _reminder, _key, device) => {
    const count = (calls.get(device.id) ?? 0) + 1;
    calls.set(device.id, count);
    if (device.id === secondDevice.id && count === 1) throw new Error('Temporary second-device failure');
  };
  await new Promise((resolve) => setTimeout(resolve, 1300));
  await service.processDue();
  assert.equal((await Reminder.findById(pushReminder.id)).state, 'ACTIVE', 'one failed device keeps the occurrence pending');
  await Reminder.updateOne({ _id: pushReminder.id }, { $set: { nextAt: new Date(0) } });
  await service.processDue();
  assert.equal(calls.get(firstDevice.id), 1, 'successful first device is not notified twice');
  assert.equal(calls.get(secondDevice.id), 2, 'only failed device is retried');
  assert.equal((await Reminder.findById(pushReminder.id)).state, 'DONE');
  delete service.send; // back to the real email delivery replaced by the push test above
  // T49: a reminder on the start of a repeating task comes back at each open occurrence and skips checked days.
  const taskCollectionId = new mongoose.Types.ObjectId().toString(), taskEntryId = new mongoose.Types.ObjectId().toString();
  const taskFormat = randomUUID(), [titleId, doneId, startId, endId, repeatId, everyId, daysId] = Array.from({ length: 7 }, () => randomUUID());
  await mongoose.connection.collection('collections').insertOne({ _id: new mongoose.Types.ObjectId(taskCollectionId), ownerId, name: 'Tasks', templateId: 'tasks', taskPlanner: { formatId: taskFormat, doneFieldId: doneId, startFieldId: startId, endFieldId: endId, repeatFieldId: repeatId, intervalFieldId: everyId, weekdaysFieldId: daysId }, formats: [{ id: taskFormat, name: 'Task', color: '#FFF5EB', version: 1, fields: [{ id: titleId, name: 'Title', kind: 'TITLE' }, { id: doneId, name: 'Done', kind: 'BOOLEAN' }, { id: startId, name: 'Start', kind: 'DATE' }, { id: endId, name: 'End', kind: 'DATE' }, { id: repeatId, name: 'Repeat', kind: 'SELECT', options: ['Once', 'Every day'] }, { id: everyId, name: 'Every', kind: 'NUMBER' }, { id: daysId, name: 'Days', kind: 'MULTI_SELECT', options: ['Monday'] }] }] });
  const todayUtc = new Date().toISOString().slice(0, 10);
  const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  await mongoose.connection.collection('entries').insertOne({ _id: new mongoose.Types.ObjectId(taskEntryId), ownerId, collectionId: taskCollectionId, formatId: taskFormat, createdAt: new Date(), values: [{ fieldId: titleId, value: 'Water' }, { fieldId: startId, value: todayUtc }, { fieldId: repeatId, value: 'Every day' }] });
  const taskReminder = await service.save(taskEntryId, ownerId, { fieldId: startId, minutesBefore: 0, timeZone: 'UTC', timeOfDay: '23:59', channels: ['EMAIL'] });
  const firstDay = Date.now() < Date.parse(`${todayUtc}T23:59:00Z`) ? todayUtc : nextDay(todayUtc);
  assert.equal(taskReminder.occurrenceAt.toISOString(), `${firstDay}T23:59:00.000Z`, 'first open occurrence at the chosen time');
  await Entry.updateOne({ _id: taskEntryId }, { $set: { taskCompletions: [firstDay] } });
  await service.refreshEntry(taskEntryId, ownerId);
  assert.equal((await Reminder.findById(taskReminder.id)).occurrenceAt.toISOString(), `${nextDay(firstDay)}T23:59:00.000Z`, 'a checked day is skipped');
  await Reminder.updateOne({ _id: taskReminder.id }, { $set: { nextAt: new Date(Date.now() - 1000) } });
  const sentBefore = messages.length;
  await service.processDue();
  assert.equal(messages.length, sentBefore + 1, 'the task reminder is sent');
  const rescheduled = await Reminder.findById(taskReminder.id);
  assert.equal(rescheduled.state, 'ACTIVE');
  assert.equal(rescheduled.occurrenceAt.toISOString(), `${nextDay(nextDay(firstDay))}T23:59:00.000Z`, 'the reminder comes back the next day');
  console.log('SMTP scheduling, date edit, late reminder, push retry ledger, account isolation, one delivery per occurrence and repeating task reminders passed.');
} finally {
  await Delivery.deleteMany({ ownerId });
  await Reminder.deleteMany({ ownerId });
  await Device.deleteMany({ ownerId });
  await Entry.deleteMany({ ownerId });
  await Collection.deleteMany({ ownerId });
  await User.deleteOne({ _id: ownerId });
  await mongoose.disconnect();
  await new Promise((resolve) => smtp.close(resolve));
}
