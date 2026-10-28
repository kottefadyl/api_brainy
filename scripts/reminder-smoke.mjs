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
  console.log('SMTP scheduling, date edit, late reminder, push retry ledger, account isolation, and one delivery per occurrence passed.');
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
