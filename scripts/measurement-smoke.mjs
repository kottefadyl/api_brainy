import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

const endpoint = `http://localhost:${process.env.PORT ?? 3000}/graphql`;
assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI for cleanup');
await mongoose.connect(process.env.MONGODB_URI);

let ownerId;
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

try {
  // 1. Authenticate user
  const email = `measure-${randomUUID()}@example.test`;
  const auth = data(
    await query(
      'mutation($input:RegisterInput!) { register(input:$input) { token user { id } } }',
      { input: { name: 'Measure Tester', email, password: 'test-password-123' } }
    )
  ).register;
  ownerId = auth.user.id;
  const token = auth.token;

  // 2. Weather scenario (R5)
  const weatherCol = data(
    await query(
      `mutation($input:CreateCollectionInput!) {
        createCollection(input:$input) {
          id
          formats {
            id
            version
            fields { id name kind unit }
          }
        }
      }`,
      {
        input: {
          name: 'Station Météo R5',
          formats: [
            {
              name: 'Relevé',
              color: '#EEF5FF',
              fields: [
                { name: 'Station', kind: 'TITLE' },
                { name: 'Date', kind: 'DATE' },
                { name: 'Température', kind: 'MEASURE', unit: '°C' },
                { name: 'Pression', kind: 'MEASURE', unit: 'hPa' },
              ],
            },
          ],
        },
      },
      token
    )
  ).createCollection;

  const weatherFormat = weatherCol.formats[0];
  const fMap = Object.fromEntries(weatherFormat.fields.map((f) => [f.name, f.id]));

  const saveMut = `mutation($id:String!,$input:SaveEntryInput!) {
    createEntry(collectionId:$id,input:$input) {
      id
      values {
        fieldId
        value
        numberValue
        measureValue { status uncertainty instrument quality }
      }
    }
  }`;

  // Reading 1: 18.5, MEASURED, uncertainty: 0.2
  const r1 = data(
    await query(
      saveMut,
      {
        id: weatherCol.id,
        input: {
          formatId: weatherFormat.id,
          values: [
            { fieldId: fMap['Station'], value: 'Station A' },
            { fieldId: fMap['Date'], value: '2026-05-01' },
            {
              fieldId: fMap['Température'],
              value: '18.5',
              measureValue: { status: 'MEASURED', uncertainty: '0.2', instrument: 'Sonde PT100' },
            },
          ],
        },
      },
      token
    )
  ).createEntry;

  // Reading 2: 19.0, ESTIMATED, uncertainty: 1.0
  const r2 = data(
    await query(
      saveMut,
      {
        id: weatherCol.id,
        input: {
          formatId: weatherFormat.id,
          values: [
            { fieldId: fMap['Station'], value: 'Station A' },
            { fieldId: fMap['Date'], value: '2026-05-02' },
            {
              fieldId: fMap['Température'],
              value: '19.0',
              measureValue: { status: 'ESTIMATED', uncertainty: '1.0', instrument: 'Interpolation' },
            },
          ],
        },
      },
      token
    )
  ).createEntry;

  // Reading 3: ABSENT
  const r3 = data(
    await query(
      saveMut,
      {
        id: weatherCol.id,
        input: {
          formatId: weatherFormat.id,
          values: [
            { fieldId: fMap['Station'], value: 'Station A' },
            { fieldId: fMap['Date'], value: '2026-05-03' },
            {
              fieldId: fMap['Température'],
              value: '',
              measureValue: { status: 'ABSENT', instrument: 'Panne capteur' },
            },
          ],
        },
      },
      token
    )
  ).createEntry;

  // Reading 4: 21.5, MEASURED, uncertainty: 0.2
  const r4 = data(
    await query(
      saveMut,
      {
        id: weatherCol.id,
        input: {
          formatId: weatherFormat.id,
          values: [
            { fieldId: fMap['Station'], value: 'Station A' },
            { fieldId: fMap['Date'], value: '2026-05-04' },
            {
              fieldId: fMap['Température'],
              value: '21.5',
              measureValue: { status: 'MEASURED', uncertainty: '0.2', instrument: 'Sonde PT100' },
            },
          ],
        },
      },
      token
    )
  ).createEntry;

  // Perform AVERAGE analysis on Temperature
  const analysisResult = data(
    await query(
      `query($collectionId:String!,$input:AnalysisInput!) {
        analyseCollection(collectionId:$collectionId,input:$input) {
          operation
          skippedMissingCount
          hasEstimated
          propagatedUncertainty
          explanation
          rows { group value count }
        }
      }`,
      {
        collectionId: weatherCol.id,
        input: {
          formatId: weatherFormat.id,
          fieldId: fMap['Température'],
          dateFieldId: fMap['Date'],
          groupBy: 'NONE',
          operation: 'AVERAGE',
          measureKind: 'EVENT',
        },
      },
      token
    )
  ).analyseCollection;

  assert.equal(analysisResult.skippedMissingCount, 1, 'Absent measurement is skipped');
  assert.equal(analysisResult.hasEstimated, true, 'Estimated measurement is flagged');
  assert.ok(analysisResult.explanation.includes('estimées'), 'Explanation notes estimated values');
  assert.ok(analysisResult.propagatedUncertainty, 'Uncertainty is propagated');
  const avgVal = parseFloat(analysisResult.rows[0].value.replace(',', '.'));
  assert.ok(Math.abs(avgVal - (18.5 + 19.0 + 21.5) / 3) < 0.001, 'Average matches numeric observations');

  // 3. Laboratory scenario & Revisions (R6)
  const labCol = data(
    await query(
      `mutation($input:CreateCollectionInput!) {
        createCollection(input:$input) {
          id
          formats {
            id
            version
            fields { id name kind unit }
          }
        }
      }`,
      {
        input: {
          name: 'Laboratoire R6',
          formats: [
            {
              name: 'Analyse',
              color: '#FFF0F4',
              fields: [
                { name: 'Échantillon', kind: 'TITLE' },
                { name: 'Concentration', kind: 'MEASURE', unit: 'mg/L' },
              ],
            },
          ],
        },
      },
      token
    )
  ).createCollection;

  const labFormat = labCol.formats[0];
  const labMap = Object.fromEntries(labFormat.fields.map((f) => [f.name, f.id]));

  const labEntry = data(
    await query(
      saveMut,
      {
        id: labCol.id,
        input: {
          formatId: labFormat.id,
          values: [
            { fieldId: labMap['Échantillon'], value: 'Ech-001' },
            {
              fieldId: labMap['Concentration'],
              value: '4.25',
              measureValue: { status: 'MEASURED', uncertainty: '0.05', quality: 'Certifié' },
            },
          ],
        },
      },
      token
    )
  ).createEntry;

  // Record timestamp before update
  const beforeRevision = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 50));

  // Update entry (revision)
  const updatedLabEntry = data(
    await query(
      `mutation($id:String!,$input:SaveEntryInput!) {
        updateEntry(id:$id,input:$input) {
          id
          values { fieldId value measureValue { status uncertainty quality revisionNote } }
          revisions { at values { fieldId value } }
        }
      }`,
      {
        id: labEntry.id,
        input: {
          formatId: labFormat.id,
          values: [
            { fieldId: labMap['Échantillon'], value: 'Ech-001' },
            {
              fieldId: labMap['Concentration'],
              value: '4.18',
              measureValue: { status: 'MEASURED', uncertainty: '0.04', quality: 'Certifié', revisionNote: 'Ré-étalonnage' },
            },
          ],
        },
      },
      token
    )
  ).updateEntry;

  assert.equal(
    updatedLabEntry.values.find((v) => v.fieldId === labMap['Concentration']).value,
    '4.18'
  );
  assert.ok(updatedLabEntry.revisions.length >= 1, 'Revision history is preserved');

  // Query asOfDate (before update)
  const asOfBefore = data(
    await query(
      `query($entryId:String!,$asOfDate:String!) {
        collectionEntryAsOfDate(entryId:$entryId,asOfDate:$asOfDate) {
          id
          values { fieldId value }
        }
      }`,
      { entryId: labEntry.id, asOfDate: beforeRevision },
      token
    )
  ).collectionEntryAsOfDate;

  assert.equal(
    asOfBefore.values.find((v) => v.fieldId === labMap['Concentration']).value,
    '4.25',
    'asOfDate accurately returns historical measurement value before revision'
  );

  // 4. Conversion without loss from NUMBER to MEASURE
  const numCol = data(
    await query(
      `mutation($input:CreateCollectionInput!) {
        createCollection(input:$input) {
          id
          formats {
            id
            version
            fields { id name kind unit }
          }
        }
      }`,
      {
        input: {
          name: 'Conversion Test',
          formats: [
            {
              name: 'Données',
              color: '#F4F0FF',
              fields: [
                { name: 'Titre', kind: 'TITLE' },
                { name: 'Poids', kind: 'NUMBER', unit: 'kg' },
              ],
            },
          ],
        },
      },
      token
    )
  ).createCollection;

  const numFormat = numCol.formats[0];
  const numMap = Object.fromEntries(numFormat.fields.map((f) => [f.name, f.id]));

  data(
    await query(
      saveMut,
      {
        id: numCol.id,
        input: {
          formatId: numFormat.id,
          values: [
            { fieldId: numMap['Titre'], value: 'Item 1' },
            { fieldId: numMap['Poids'], value: '42.5' },
          ],
        },
      },
      token
    )
  );

  // Update format: convert Poids from NUMBER to MEASURE with same unit
  const convertedFormatCol = data(
    await query(
      `mutation($collectionId:String!,$formatId:String!,$input:UpdateCollectionFormatInput!) {
        updateCollectionFormat(collectionId:$collectionId,formatId:$formatId,input:$input) {
          id
          formats {
            id
            fields { id name kind unit }
          }
        }
      }`,
      {
        collectionId: numCol.id,
        formatId: numFormat.id,
        input: {
          name: 'Données',
          expectedVersion: numFormat.version ?? 1,
          fields: [
            { id: numMap['Titre'], name: 'Titre', kind: 'TITLE' },
            { id: numMap['Poids'], name: 'Poids', kind: 'MEASURE', unit: 'kg' },
          ],
        },
      },
      token
    )
  ).updateCollectionFormat;

  const convertedField = convertedFormatCol.formats[0].fields.find((f) => f.id === numMap['Poids']);
  assert.equal(convertedField.kind, 'MEASURE', 'Field successfully converted from NUMBER to MEASURE');

  // Verify existing entry has preserved value
  const numEntries = data(
    await query(
      `query($id:String!) {
        collectionEntries(collectionId:$id) {
          values { fieldId value }
        }
      }`,
      { id: numCol.id },
      token
    )
  ).collectionEntries;
  assert.equal(
    numEntries[0].values.find((v) => v.fieldId === numMap['Poids']).value,
    '42.5',
    'Value is preserved without loss after conversion'
  );

  console.log('T36: Measurement smoke passed (weather R5, lab R6, revisions, uncertainty propagation, and NUMBER->MEASURE conversion).');
} finally {
  try {
    if (ownerId) {
      const ids = (
        await mongoose.connection
          .collection('collections')
          .find({ ownerId }, { projection: { _id: 1 } })
          .toArray()
      ).map((item) => item._id.toString());
      await mongoose.connection.collection('entries').deleteMany({ collectionId: { $in: ids } });
      await mongoose.connection.collection('collections').deleteMany({ ownerId });
      await mongoose.connection.collection('users').deleteMany({ _id: new mongoose.Types.ObjectId(ownerId) });
    }
  } finally {
    await mongoose.disconnect();
  }
}
