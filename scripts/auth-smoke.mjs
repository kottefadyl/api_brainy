import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

const url = `http://localhost:${process.env.PORT ?? 3000}/graphql`;
const suffix = randomUUID().slice(0, 8);
const password = 'test-password-123';
const createdUsers = [];
let createdNote;

async function graphql(query, variables = {}, token) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  return response.json();
}

function data(result) {
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  return result.data;
}

try {
  const register = `mutation($input: RegisterInput!) {
    register(input: $input) { token user { id name email } }
  }`;
  const firstInput = { name: 'Test Ada', email: `brainy-${suffix}-a@example.test`, password };
  const secondInput = { name: 'Test Bisi', email: `brainy-${suffix}-b@example.test`, password };
  const first = data(await graphql(register, { input: firstInput })).register;
  createdUsers.push(first.user.id);
  const second = data(await graphql(register, { input: secondInput })).register;
  createdUsers.push(second.user.id);
  assert.equal(first.user.email, firstInput.email);
  assert.ok((await graphql(register, { input: firstInput })).errors?.length, 'duplicate email should fail');

  const login = `mutation($input: LoginInput!) {
    login(input: $input) { token user { id name email } }
  }`;
  assert.ok((await graphql(login, { input: { email: firstInput.email, password: 'wrong-password' } })).errors?.length,
    'wrong password should fail');
  const signedIn = data(await graphql(login, { input: { email: firstInput.email.toUpperCase(), password } })).login;
  assert.equal(signedIn.user.id, first.user.id);
  assert.equal(data(await graphql('query { me { id } }', {}, signedIn.token)).me.id, first.user.id);
  assert.ok((await graphql('query { me { id } }')).errors?.length, 'anonymous me should fail');
  assert.ok((await graphql('mutation { loginWithGoogle(firebaseIdToken: "not-a-token") { token } }')).errors?.length,
    'invalid Firebase token should fail');

  const create = `mutation($input: CreateNoteInput!) {
    createNote(input: $input) { id title }
  }`;
  createdNote = data(await graphql(create, { input: { title: 'Private thought', content: 'Only Ada can see this' } }, first.token)).createNote.id;
  const list = 'query { notesList { id } }';
  assert.equal(data(await graphql(list, {}, first.token)).notesList.length, 1);
  assert.equal(data(await graphql(list, {}, second.token)).notesList.length, 0);
  assert.ok((await graphql(list)).errors?.length, 'anonymous notes should fail');
  const otherNote = data(await graphql('query($id: String!) { note(id: $id) { id } }', { id: createdNote }, second.token));
  assert.equal(otherNote.note, null);
  console.log('Auth and note isolation smoke test passed.');
} finally {
  if (createdUsers.length > 0 || createdNote) {
    await mongoose.connect(process.env.MONGODB_URI);
    if (createdNote) await mongoose.connection.collection('notes').deleteOne({ _id: new mongoose.Types.ObjectId(createdNote) });
    if (createdUsers.length > 0) {
      await mongoose.connection.collection('users').deleteMany({
        _id: { $in: createdUsers.map((id) => new mongoose.Types.ObjectId(id)) },
      });
    }
    await mongoose.disconnect();
  }
}
