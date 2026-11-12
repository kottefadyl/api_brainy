// T52/T53: repeatable demo data to try collaborators and shared collections by hand.
// Creates two demo people (Awa and Bruno), makes them collaborators of your own local account,
// and shares collections in both directions with entries written by different people.
// Run from api/ with the API running: node --env-file=.env scripts/collab-seed.mjs [--me=<your e-mail>]
// Without --me, the only local account that is not a test or demo account is used.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import mongoose from 'mongoose';

const PASSWORD = 'BrainyDemo-2026';
const DEMO = [
  { key: 'awa', name: 'Awa Diallo', email: 'awa.demo@brainy.local', profession: 'Infirmière', interests: ['Cuisine', 'Santé'] },
  { key: 'bruno', name: 'Bruno Kamga', email: 'bruno.demo@brainy.local', profession: 'Enseignant', interests: ['Voyages', 'Photographie'] },
];
const endpoint = `http://localhost:${process.env.PORT || 3000}/graphql`;

async function gql(query, variables = {}, token) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
  const result = await response.json();
  if (result.errors?.length) throw new Error(result.errors.map((error) => error.message).join('; '));
  return result.data;
}

// --- People -------------------------------------------------------------------------------
assert.ok(process.env.MONGODB_URI, 'MONGODB_URI is required');
await mongoose.connect(process.env.MONGODB_URI);
const meArg = process.argv.find((arg) => arg.startsWith('--me='))?.slice(5).trim().toLowerCase();
const accounts = await mongoose.connection.collection('users').find({}, { projection: { _id: 1, email: 1, name: 1 } }).toArray();
await mongoose.disconnect();
const real = accounts.filter((user) => meArg ? user.email?.toLowerCase() === meArg : !/(@example\.test|@brainy\.local)$/i.test(user.email ?? ''));
assert.equal(real.length, 1, meArg ? 'No account with this e-mail' : `Expected one personal account, found ${real.length}; pass --me=<your e-mail>`);
const me = { id: String(real[0]._id), name: real[0].name };
const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const payload = Buffer.from(JSON.stringify({ sub: me.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
me.token = `${header}.${payload}.${createHmac('sha256', process.env.JWT_SECRET || 'brainy-local-development-secret-change-before-deploying').update(`${header}.${payload}`).digest('base64url')}`;

const people = { me };
for (const person of DEMO) {
  let auth;
  try {
    auth = (await gql('mutation($i:RegisterInput!){register(input:$i){token user{id}}}', { i: { name: person.name, email: person.email, password: PASSWORD } })).register;
  } catch {
    auth = (await gql('mutation($i:LoginInput!){login(input:$i){token user{id}}}', { i: { email: person.email, password: PASSWORD } })).login;
  }
  await gql('mutation($i:ProfileInput!){updateProfile(input:$i){id}}', { i: { name: person.name, profession: person.profession, job: '', fieldOfStudy: '', interests: person.interests, hobbies: [] } }, auth.token);
  await gql('mutation{setOnboardingCompleted(completed:true){id}}', {}, auth.token);
  people[person.key] = { id: auth.user.id, name: person.name, token: auth.token };
}

// Everyone becomes collaborator of everyone (accepting a link is enough; nothing is shared yet).
async function collaborate(a, b) {
  const known = (await gql('query{collaborators{userId}}', {}, a.token)).collaborators.some((item) => item.userId === b.id);
  if (known) return;
  const { collaborationInviteToken: link } = await gql('query{collaborationInviteToken}', {}, a.token);
  await gql('mutation($t:String!){acceptCollaboration(token:$t){userId}}', { t: link }, b.token);
}
await collaborate(people.me, people.awa);
await collaborate(people.me, people.bruno);
await collaborate(people.awa, people.bruno);

// --- Collections --------------------------------------------------------------------------
const shape = 'id name sharedBy{userId} formats{id name fields{id name kind}}';
const day = (offset) => { const date = new Date(); date.setUTCDate(date.getUTCDate() + offset); return date.toISOString().slice(0, 10); };
let createdCollections = 0, createdEntries = 0;

async function ensureCollection(owner, name, formats, rows, shares, views = []) {
  const mine = (await gql(`query{collectionsList{${shape}}}`, {}, owner.token)).collectionsList.filter((item) => !item.sharedBy);
  let collection = mine.find((item) => item.name === name);
  const fresh = !collection;
  if (fresh) {
    collection = (await gql(`mutation($i:CreateCollectionInput!){createCollection(input:$i){${shape}}}`, { i: { name, formats } }, owner.token)).createCollection;
    createdCollections++;
  }
  for (const [person, role] of shares) {
    await gql('mutation($c:String!,$u:String,$r:CollectionRole!){addCollectionMember(collectionId:$c,memberUserId:$u,role:$r){id}}', { c: collection.id, u: person.id, r: role }, owner.token);
  }
  if (!fresh) return collection;
  for (const view of views) {
    const format = collection.formats.find((item) => item.name === view.format);
    await gql('mutation($id:String!,$i:SavedCollectionViewInput!){saveCollectionView(collectionId:$id,input:$i){id}}', { id: collection.id, i: { name: view.name, layout: view.layout, formatIds: [format.id], columnFieldIds: format.fields.map((item) => item.id), sort: 'NEWEST', groupByFormat: false } }, owner.token);
  }
  // rows: [author, formatName, {fieldName: value}, editor?, {fieldName: newValue}?]
  for (const [author, formatName, values, editor, changes] of rows) {
    const format = collection.formats.find((item) => item.name === formatName);
    const toValues = (object) => Object.entries(object).map(([fieldName, value]) => {
      const field = format.fields.find((item) => item.name === fieldName);
      assert.ok(field, `Missing field ${formatName}.${fieldName}`);
      return { fieldId: field.id, value: String(value) };
    });
    const entry = (await gql('mutation($id:String!,$i:SaveEntryInput!){createEntry(collectionId:$id,input:$i){id values{fieldId value}}}', { id: collection.id, i: { formatId: format.id, values: toValues(values) } }, author.token)).createEntry;
    createdEntries++;
    if (editor) {
      const merged = new Map(entry.values.map((item) => [item.fieldId, item.value]));
      for (const item of toValues(changes)) merged.set(item.fieldId, item.value);
      await gql('mutation($id:String!,$i:SaveEntryInput!){updateEntry(id:$id,input:$i){id}}', { id: entry.id, i: { values: [...merged].map(([fieldId, value]) => ({ fieldId, value })) } }, editor.token);
    }
  }
  return collection;
}

const { me: kevin, awa, bruno } = people;

// 1. Awa → you and Bruno, read and write: several authors and a last editor different from the creator.
await ensureCollection(awa, 'Courses de la famille', [
  { name: 'Article', color: '#EDF9F3', fields: [{ name: 'Titre', kind: 'TITLE' }, { name: 'Quantité', kind: 'NUMBER' }, { name: 'Rayon', kind: 'SELECT', options: ['Fruits et légumes', 'Épicerie', 'Boissons', 'Maison'] }, { name: 'Acheté', kind: 'BOOLEAN' }] },
], [
  [awa, 'Article', { Titre: 'Tomates', Quantité: 2, Rayon: 'Fruits et légumes', Acheté: false }, bruno, { Acheté: true }],
  [awa, 'Article', { Titre: 'Riz parfumé', Quantité: 1, Rayon: 'Épicerie', Acheté: false }],
  [bruno, 'Article', { Titre: 'Jus de bissap', Quantité: 3, Rayon: 'Boissons', Acheté: false }],
  [kevin, 'Article', { Titre: 'Savon', Quantité: 4, Rayon: 'Maison', Acheté: true }, awa, { Quantité: 6 }],
  [bruno, 'Article', { Titre: 'Plantains', Quantité: 5, Rayon: 'Fruits et légumes', Acheté: false }],
], [[kevin, 'EDITOR'], [bruno, 'EDITOR']], [{ name: 'Liste en tableau', layout: 'TABLE', format: 'Article' }]);

// 2. Awa → you, read only: a reader sees entries and the table but no write action.
await ensureCollection(awa, 'Recettes d’Awa', [
  { name: 'Recette', color: '#FFF5EB', fields: [{ name: 'Titre', kind: 'TITLE' }, { name: 'Ingrédients', kind: 'LONG_TEXT' }, { name: 'Temps (minutes)', kind: 'NUMBER' }, { name: 'Difficulté', kind: 'SELECT', options: ['Facile', 'Moyenne', 'Difficile'] }] },
], [
  [awa, 'Recette', { Titre: 'Ndolé', Ingrédients: 'Feuilles de ndolé, arachides, crevettes, viande, oignons', 'Temps (minutes)': 120, Difficulté: 'Difficile' }],
  [awa, 'Recette', { Titre: 'Poulet DG', Ingrédients: 'Poulet, plantains mûrs, carottes, haricots verts, poivrons', 'Temps (minutes)': 75, Difficulté: 'Moyenne' }],
  [awa, 'Recette', { Titre: 'Beignets haricots', Ingrédients: 'Farine, levure, sucre, haricots rouges', 'Temps (minutes)': 45, Difficulté: 'Facile' }],
], [[kevin, 'READER']], [{ name: 'Recettes en tableau', layout: 'TABLE', format: 'Recette' }]);

// 3. Bruno → you and Awa, read and write, two data formats.
await ensureCollection(bruno, 'Voyage à Kribi', [
  { name: 'Étape', color: '#EEF5FF', fields: [{ name: 'Titre', kind: 'TITLE' }, { name: 'Date', kind: 'DATE' }, { name: 'Lieu', kind: 'TEXT' }] },
  { name: 'Dépense', color: '#FFF0F4', fields: [{ name: 'Titre', kind: 'TITLE' }, { name: 'Montant', kind: 'NUMBER', unit: 'XAF' }, { name: 'Payé par', kind: 'SELECT', options: ['Bruno', 'Awa', 'Kevin'] }] },
], [
  [bruno, 'Étape', { Titre: 'Départ de Douala', Date: day(14), Lieu: 'Gare routière de Douala' }],
  [bruno, 'Étape', { Titre: 'Chutes de la Lobé', Date: day(15), Lieu: 'Lobé' }, awa, { Lieu: 'Chutes de la Lobé, Kribi' }],
  [awa, 'Dépense', { Titre: 'Billets de bus', Montant: 15000, 'Payé par': 'Awa' }],
  [kevin, 'Dépense', { Titre: 'Hôtel, 2 nuits', Montant: 60000, 'Payé par': 'Kevin' }],
  [bruno, 'Dépense', { Titre: 'Poisson braisé', Montant: 8000, 'Payé par': 'Bruno' }],
], [[kevin, 'EDITOR'], [awa, 'EDITOR']]);

// 4. You → Awa (read and write) and Bruno (read only): to try the owner side (share, change role, end).
await ensureCollection(kevin, 'Projet partagé (démo)', [
  { name: 'Idée', color: '#F4F0FF', fields: [{ name: 'Titre', kind: 'TITLE' }, { name: 'Détail', kind: 'LONG_TEXT' }, { name: 'Priorité', kind: 'SELECT', options: ['Haute', 'Moyenne', 'Basse'] }] },
], [
  [kevin, 'Idée', { Titre: 'Tester le partage', Détail: 'Changer le rôle de Bruno, puis retirer son accès.', Priorité: 'Haute' }],
  [awa, 'Idée', { Titre: 'Ajouter des photos', Détail: 'Une photo de profil s’affiche à côté du nom de l’auteur.', Priorité: 'Moyenne' }, kevin, { Priorité: 'Basse' }],
], [[awa, 'EDITOR'], [bruno, 'READER']]);

console.log(`Collaboration demo ready: ${createdCollections} collection(s) and ${createdEntries} entr(y/ies) created.`);
console.log(`Demo accounts (password ${PASSWORD}): ${DEMO.map((person) => `${person.name} <${person.email}>`).join(', ')}`);
console.log('Your account now sees “Courses de la famille” (read and write), “Recettes d’Awa” (read only) and “Voyage à Kribi” (read and write) under Shared with me, and owns “Projet partagé (démo)”.');
