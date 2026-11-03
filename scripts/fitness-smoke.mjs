import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const url = process.env.API_URL || 'http://localhost:4000/graphql';

async function gql(query, variables, token) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (body.errors?.length) throw new Error(body.errors[0].message);
  return body.data;
}

try {
  const registered = await gql('mutation($input:RegisterInput!) { register(input:$input) { token user { id } } }', {
    input: {
      name: 'Fitness Tester',
      email: `fitness-${randomUUID()}@example.test`,
      password: 'temporary-test-password',
    },
  });
  const token = registered.register.token;

  // 1. Check starterTemplates contains fitness in fr and en
  const frTemplates = await gql('query { starterTemplates(language:"fr") { id name description } }');
  const fitnessFr = frTemplates.starterTemplates.find((t) => t.id === 'fitness');
  assert.ok(fitnessFr, 'Fitness template should exist in French');
  assert.equal(fitnessFr.name, 'Entraînement et sport');

  const enTemplates = await gql('query { starterTemplates(language:"en") { id name description } }');
  const fitnessEn = enTemplates.starterTemplates.find((t) => t.id === 'fitness');
  assert.ok(fitnessEn, 'Fitness template should exist in English');
  assert.equal(fitnessEn.name, 'Fitness and workouts');

  // 2. Create collection from template
  const created = (await gql(`mutation {
    createCollectionFromTemplate(templateId:"fitness", name:"Mon Sport", language:"fr") {
      id
      name
      formats {
        id
        name
        color
        objectModel
        fields {
          id
          name
          kind
          unit
        }
      }
      savedViews {
        id
        name
        layout
      }
    }
  }`, {}, token)).createCollectionFromTemplate;

  assert.equal(created.name, 'Mon Sport');
  assert.equal(created.formats.length, 3, 'Should have 3 formats: Exercice, Séance, Série');
  
  const exerciseFormat = created.formats.find((f) => f.name === 'Exercice');
  assert.ok(exerciseFormat, 'Exercice format should exist');
  assert.equal(exerciseFormat.objectModel, true, 'Exercice should be objectModel');

  const workoutFormat = created.formats.find((f) => f.name === 'Séance');
  assert.ok(workoutFormat, 'Séance format should exist');

  const setFormat = created.formats.find((f) => f.name === 'Série');
  assert.ok(setFormat, 'Série format should exist');
  const exerciseRef = setFormat.fields.find((f) => f.kind === 'OBJECT_REF');
  assert.ok(exerciseRef, 'Série should have an OBJECT_REF field pointing to Exercice');

  const calView = created.savedViews.find((v) => v.layout === 'CALENDAR');
  assert.ok(calView, 'Should have a CALENDAR saved view');

  const tableView = created.savedViews.find((v) => v.layout === 'TABLE');
  assert.ok(tableView, 'Should have a TABLE saved view');

  console.log('FITNESS_TEMPLATE_SMOKE_PASSED');
} catch (err) {
  console.error('FITNESS_TEST_FAILED:', err.message);
}

