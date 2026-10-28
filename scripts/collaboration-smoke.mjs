import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

const endpoint = `http://localhost:${process.env.PORT ?? 3000}/graphql`;
assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI for cleanup');
await mongoose.connect(process.env.MONGODB_URI);

const query = async (source, variables = {}, token) => {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query: source, variables }),
  });
  return res.json();
};

const data = (result) => {
  assert.equal(result.errors, undefined, JSON.stringify(result.errors));
  return result.data;
};

const createdUserIds = [];

try {
  // 1. Register 3 users: Alice (Owner), Bob (Editor), Charlie (Reader)
  const registerUser = async (name) => {
    const email = `${name.toLowerCase()}-${randomUUID()}@example.test`;
    const res = data(
      await query(
        'mutation($input:RegisterInput!) { register(input:$input) { token user { id email name } } }',
        { input: { name, email, password: 'password-123' } }
      )
    ).register;
    createdUserIds.push(res.user.id);
    return res;
  };

  const alice = await registerUser('Alice');
  const bob = await registerUser('Bob');
  const charlie = await registerUser('Charlie');

  // 2. Alice creates a collection with 2 fields: Titre (TITLE) and Note (TEXT)
  const colRes = data(
    await query(
      `mutation($input:CreateCollectionInput!) {
        createCollection(input:$input) {
          id
          name
          formats {
            id
            fields { id name kind }
          }
        }
      }`,
      {
        input: {
          name: 'Collab T28 Project',
          formats: [
            {
              name: 'Fiche',
              color: '#EEF5FF',
              fields: [
                { name: 'Titre', kind: 'TITLE' },
                { name: 'Note secrète', kind: 'TEXT' },
              ],
            },
          ],
        },
      },
      alice.token
    )
  ).createCollection;

  const collectionId = colRes.id;
  const format = colRes.formats[0];
  const titleField = format.fields.find((f) => f.name === 'Titre');
  const secretField = format.fields.find((f) => f.name === 'Note secrète');
  assert.ok(titleField && secretField, 'Fields created');

  // 3. Alice adds Bob as EDITOR
  const addBobRes = data(
    await query(
      `mutation($collectionId:String!, $email:String!, $role:CollectionRole!) {
        addCollectionMember(collectionId:$collectionId, email:$email, role:$role) {
          id
          members { userId email role }
        }
      }`,
      {
        collectionId,
        email: bob.user.email,
        role: 'EDITOR',
      },
      alice.token
    )
  ).addCollectionMember;

  const bobMember = addBobRes.members.find((m) => m.userId === bob.user.id);
  assert.ok(bobMember, 'Bob is a member');
  assert.equal(bobMember.role, 'EDITOR', 'Bob role is EDITOR');

  // 4. Alice adds Charlie as READER with only titleField accessible
  const addCharlieRes = data(
    await query(
      `mutation($collectionId:String!, $email:String!, $role:CollectionRole!, $sharedFieldIds:[String!]) {
        addCollectionMember(collectionId:$collectionId, email:$email, role:$role, sharedFieldIds:$sharedFieldIds) {
          id
          members { userId email role sharedFieldIds }
        }
      }`,
      {
        collectionId,
        email: charlie.user.email,
        role: 'READER',
        sharedFieldIds: [titleField.id],
      },
      alice.token
    )
  ).addCollectionMember;

  const charlieMember = addCharlieRes.members.find((m) => m.userId === charlie.user.id);
  assert.ok(charlieMember, 'Charlie is a member');
  assert.equal(charlieMember.role, 'READER', 'Charlie role is READER');
  assert.deepEqual(charlieMember.sharedFieldIds, [titleField.id], 'Charlie has restricted fields');

  // 5. Bob (EDITOR) creates an entry
  const bobEntry = data(
    await query(
      `mutation($collectionId:String!, $input:SaveEntryInput!) {
        createEntry(collectionId:$collectionId, input:$input) {
          id
          values { fieldId value }
        }
      }`,
      {
        collectionId,
        input: {
          formatId: format.id,
          values: [
            { fieldId: titleField.id, value: 'Rapport Bob' },
            { fieldId: secretField.id, value: 'Chiffre confidentiel 42' },
          ],
        },
      },
      bob.token
    )
  ).createEntry;

  assert.ok(bobEntry.id, 'Bob successfully created entry');
  assert.equal(bobEntry.values.length, 2, 'Entry has 2 values');

  // 6. Charlie (READER) tries to create an entry -> MUST FAIL
  const charlieCreateRes = await query(
    `mutation($collectionId:String!, $input:SaveEntryInput!) {
      createEntry(collectionId:$collectionId, input:$input) { id }
    }`,
    {
      collectionId,
      input: {
        formatId: format.id,
        values: [{ fieldId: titleField.id, value: 'Tentative Charlie' }],
      },
    },
    charlie.token
  );
  assert.ok(charlieCreateRes.errors?.length > 0, 'Charlie create entry must fail');
  assert.match(charlieCreateRes.errors[0].message, /Read-only members cannot modify collection data/i);

  // 7. Charlie (READER) tries to update Bob's entry -> MUST FAIL
  const charlieUpdateRes = await query(
    `mutation($id:String!, $input:SaveEntryInput!) {
      updateEntry(id:$id, input:$input) { id }
    }`,
    {
      id: bobEntry.id,
      input: {
        formatId: format.id,
        values: [{ fieldId: titleField.id, value: 'Modification Charlie' }],
      },
    },
    charlie.token
  );
  assert.ok(charlieUpdateRes.errors?.length > 0, 'Charlie update entry must fail');
  assert.match(charlieUpdateRes.errors[0].message, /Read-only members cannot modify collection data/i);

  // 8. Charlie (READER) reads entries -> MUST ONLY see titleField, NOT secretField
  const charlieEntries = data(
    await query(
      `query($collectionId:String!) {
        collectionEntries(collectionId:$collectionId) {
          id
          values { fieldId value }
        }
      }`,
      { collectionId },
      charlie.token
    )
  ).collectionEntries;

  assert.equal(charlieEntries.length, 1, 'Charlie sees the entry');
  const charlieEntryValues = charlieEntries[0].values;
  assert.equal(charlieEntryValues.length, 1, 'Charlie only sees 1 field (secret field is filtered)');
  assert.equal(charlieEntryValues[0].fieldId, titleField.id, 'Only titleField is visible to Charlie');
  assert.equal(charlieEntryValues[0].value, 'Rapport Bob');

  // 9. Charlie tries to delete the collection -> MUST FAIL
  const charlieDeleteColRes = await query(
    `mutation($id:String!) { deleteCollection(id:$id) }`,
    { id: collectionId },
    charlie.token
  );
  assert.ok(charlieDeleteColRes.errors?.length > 0, 'Charlie delete collection must fail');
  assert.match(charlieDeleteColRes.errors[0].message, /Only a collection owner can perform this action/i);

  // 10. Bob (EDITOR) tries to delete the collection -> MUST FAIL
  const bobDeleteColRes = await query(
    `mutation($id:String!) { deleteCollection(id:$id) }`,
    { id: collectionId },
    bob.token
  );
  assert.ok(bobDeleteColRes.errors?.length > 0, 'Bob delete collection must fail');
  assert.match(bobDeleteColRes.errors[0].message, /Only a collection owner can perform this action/i);

  // 11. Alice reads audit logs
  const logs = data(
    await query(
      `query($collectionId:String!) {
        collectionAuditLogs(collectionId:$collectionId) {
          id
          action
          userId
          details
        }
      }`,
      { collectionId },
      alice.token
    )
  ).collectionAuditLogs;

  assert.ok(logs.length >= 3, 'Audit logs recorded sensitive actions');
  const actions = logs.map((l) => l.action);
  assert.ok(actions.includes('SHARE_COLLECTION'), 'Contains SHARE_COLLECTION');
  assert.ok(actions.includes('CREATE_ENTRY'), 'Contains CREATE_ENTRY');

  // 12. Alice revokes Charlie
  const revokeRes = data(
    await query(
      `mutation($collectionId:String!, $memberUserId:String!) {
        removeCollectionMember(collectionId:$collectionId, memberUserId:$memberUserId) {
          id
          members { userId }
        }
      }`,
      { collectionId, memberUserId: charlie.user.id },
      alice.token
    )
  ).removeCollectionMember;
  assert.ok(!revokeRes.members.some((m) => m.userId === charlie.user.id), 'Charlie revoked');

  // 13. Charlie now gets access denied to collection
  const charliePostRevoke = await query(
    `query($collectionId:String!) {
      collectionEntries(collectionId:$collectionId) { id }
    }`,
    { collectionId },
    charlie.token
  );
  assert.ok(charliePostRevoke.errors?.length > 0, 'Revoked Charlie cannot read entries');
  assert.match(charliePostRevoke.errors[0].message, /Access denied to this collection|Collection not found/i);

  console.log('T28: Collaboration smoke passed cleanly (roles, restricted fields, audit logs, and member revocation).');
} finally {
  try {
    if (createdUserIds.length) {
      await mongoose.connection.collection('collections').deleteMany({ ownerId: { $in: createdUserIds } });
      await mongoose.connection.collection('entries').deleteMany({ ownerId: { $in: createdUserIds } });
      await mongoose.connection.collection('auditlogs').deleteMany({ userId: { $in: createdUserIds } });
      await mongoose.connection.collection('users').deleteMany({ _id: { $in: createdUserIds.map((id) => new mongoose.Types.ObjectId(id)) } });
    }
  } finally {
    await mongoose.disconnect();
  }
}
