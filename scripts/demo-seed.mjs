// Persistent, repeatable demo data for the sole local Brainy account.
// Run inside the API container: docker compose exec -T api node scripts/demo-seed.mjs
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import mongoose from 'mongoose';

assert.ok(process.env.MONGODB_URI, 'MONGODB_URI is required');
await mongoose.connect(process.env.MONGODB_URI);
const users = await mongoose.connection.collection('users').find({}, { projection: { _id: 1, email: 1 } }).toArray();
assert.equal(users.length, 1, 'Expected exactly one local account; refusing to guess an owner');
const ownerId = String(users[0]._id);
const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const payload = Buffer.from(JSON.stringify({ sub: ownerId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
const body = `${header}.${payload}`;
const token = `${body}.${createHmac('sha256', process.env.JWT_SECRET || 'brainy-local-development-secret-change-before-deploying').update(body).digest('base64url')}`;
const endpoint = `http://localhost:${process.env.PORT || 3000}/graphql`;

async function gql(query, variables = {}) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ query, variables }) });
  const result = await response.json();
  if (result.errors?.length) throw new Error(`${result.errors.map((error) => error.message).join('; ')}\n${JSON.stringify(variables)}`);
  return result.data;
}

const collectionShape = 'id name formats { id name objectModel fields { id name kind } } savedViews { id name layout } formulas { id name formatId }';
const listQuery = `query { collectionsList { ${collectionShape} } }`;
const entriesQuery = 'query($id:String!) { collectionEntries(collectionId:$id) { id formatId values { fieldId value } recurrence { frequency } } }';
const createQuery = `mutation($input:CreateCollectionInput!) { createCollection(input:$input) { ${collectionShape} } }`;
const addFormatQuery = `mutation($id:String!,$input:CollectionFormatInput!) { addCollectionFormat(collectionId:$id,input:$input) { ${collectionShape} } }`;
const entryQuery = 'mutation($id:String!,$input:SaveEntryInput!) { createEntry(collectionId:$id,input:$input) { id formatId values { fieldId value } } }';
const viewQuery = `mutation($id:String!,$input:SavedCollectionViewInput!) { saveCollectionView(collectionId:$id,input:$input) { ${collectionShape} } }`;
let collections = (await gql(listQuery)).collectionsList;
let createdCollections = 0, createdEntries = 0, createdViews = 0, createdFormulas = 0;

function day(offset = 0) {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}
function at(offset, hour, minute = 0) { return `${day(offset)}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`; }
function field(format, name) { const found = format.fields.find((item) => item.name === name); assert.ok(found, `Missing ${format.name}.${name}`); return found.id; }
function format(collection, name) { const found = collection.formats.find((item) => item.name === name); assert.ok(found, `Missing format ${name}`); return found; }

async function ensureCollection(name, formats) {
  let collection = collections.find((item) => item.name === name);
  if (!collection) {
    collection = (await gql(createQuery, { input: { name, formats } })).createCollection;
    collections.push(collection);
    createdCollections++;
  }
  return collection;
}
async function ensureFormat(collection, definition) {
  if (!collection.formats.some((item) => item.name === definition.name)) collection = (await gql(addFormatQuery, { id: collection.id, input: definition })).addCollectionFormat;
  collections = collections.map((item) => item.id === collection.id ? collection : item);
  return collection;
}
async function ensureEntries(collection, formatName, rows) {
  const definition = format(collection, formatName);
  const current = (await gql(entriesQuery, { id: collection.id })).collectionEntries;
  const titleField = definition.fields.find((item) => item.kind === 'TITLE');
  assert.ok(titleField);
  const byTitle = new Map(current.filter((item) => item.formatId === definition.id).map((item) => [item.values.find((value) => value.fieldId === titleField.id)?.value, item]));
  for (const row of rows) {
    const title = row[titleField.name];
    assert.ok(title, `Missing title for ${formatName}`);
    if (byTitle.has(title)) continue;
    const values = Object.entries(row).filter(([, value]) => value !== undefined && value !== null).map(([name, value]) => ({ fieldId: field(definition, name), value: String(value) }));
    const entry = (await gql(entryQuery, { id: collection.id, input: { formatId: definition.id, values } })).createEntry;
    byTitle.set(title, entry);
    createdEntries++;
  }
  return byTitle;
}
async function ensureView(collection, name, layout, formatName, columns, extra = {}) {
  if (collection.savedViews.some((view) => view.name === name)) return collection;
  const definition = format(collection, formatName);
  const input = { name, layout, formatIds: [definition.id], columnFieldIds: columns.map((name) => field(definition, name)), sort: 'NEWEST', groupByFormat: false, ...extra };
  collection = (await gql(viewQuery, { id: collection.id, input })).saveCollectionView;
  collections = collections.map((item) => item.id === collection.id ? collection : item);
  createdViews++;
  return collection;
}
async function ensureFormula(collection, name, formatName, expression) {
  const definition = format(collection, formatName);
  if ((collection.formulas ?? []).some((item) => item.name === name && item.formatId === definition.id)) return collection;
  collection = (await gql(`mutation($collectionId:String!,$input:FormulaInput!) { saveCollectionFormula(collectionId:$collectionId,input:$input) { ${collectionShape} } }`, { collectionId: collection.id, input: { name, formatId: definition.id, expression: JSON.stringify(expression) } })).saveCollectionFormula;
  collections = collections.map((item) => item.id === collection.id ? collection : item);
  createdFormulas++;
  return collection;
}

try {
  let notes = await ensureCollection('Démo · Notes et ressources', [
    { name: 'Note', color: '#EEF5FF', fields: [{ name: 'Titre', kind: 'TITLE' }, { name: 'Date', kind: 'DATE' }, { name: 'Catégorie', kind: 'SELECT', options: ['Idée', 'Réunion', 'Journal'] }, { name: 'Contenu', kind: 'LONG_TEXT' }] },
    { name: 'Ressource', color: '#EDF9F3', fields: [{ name: 'Titre', kind: 'TITLE' }, { name: 'Lien', kind: 'LINK' }, { name: 'Sujet', kind: 'TEXT' }, { name: 'Consulté le', kind: 'DATE' }] },
  ]);
  await ensureEntries(notes, 'Note', [
    { Titre: 'Idées pour organiser mes archives', Date: day(-5), Catégorie: 'Idée', Contenu: 'Classer les documents par année, puis ajouter des mots clés pour les retrouver.' },
    { Titre: 'Compte rendu du point hebdomadaire', Date: day(-3), Catégorie: 'Réunion', Contenu: 'Priorités : finaliser la liste des tâches et vérifier les prochaines échéances.' },
    { Titre: 'Journal de la semaine', Date: day(-1), Catégorie: 'Journal', Contenu: 'Les notes et les liens importants sont désormais réunis dans la même collection.' },
  ]);
  await ensureEntries(notes, 'Ressource', [
    { Titre: 'Guide de référence Python', Lien: 'https://docs.python.org/3/', Sujet: 'Programmation', 'Consulté le': day(-4) },
    { Titre: 'Données ouvertes de la Banque mondiale', Lien: 'https://data.worldbank.org/', Sujet: 'Données publiques', 'Consulté le': day(-2) },
  ]);
  notes = await ensureView(notes, 'Toutes les notes', 'TABLE', 'Note', ['Titre', 'Date', 'Catégorie']);

  let tasks = await ensureCollection('Démo · Tâches personnelles', [{ name: 'Tâche', color: '#FFF5EB', fields: [
    { name: 'Titre', kind: 'TITLE' }, { name: 'Terminée', kind: 'BOOLEAN' }, { name: 'Échéance', kind: 'DATE' }, { name: 'Terminée le', kind: 'DATETIME' }, { name: 'Priorité', kind: 'SELECT', options: ['Haute', 'Moyenne', 'Basse'] }, { name: 'Détails', kind: 'LONG_TEXT' },
  ] }]);
  const taskEntries = await ensureEntries(tasks, 'Tâche', [
    { Titre: 'Préparer la présentation', Terminée: 'false', Échéance: day(2), Priorité: 'Haute', Détails: 'Rassembler les points essentiels et relire les chiffres.' },
    { Titre: 'Commander des fournitures', Terminée: 'false', Échéance: day(5), Priorité: 'Moyenne' },
    { Titre: 'Trier les documents', Terminée: 'false', Échéance: day(7), Priorité: 'Basse' },
    { Titre: 'Relire le rapport', Terminée: 'false', Échéance: day(1), Priorité: 'Haute' },
    { Titre: 'Vérifier les contacts', Terminée: 'false', Priorité: 'Moyenne' },
    { Titre: 'Planifier la semaine', Terminée: 'true', Échéance: day(-2), 'Terminée le': at(-2, 15), Priorité: 'Moyenne' },
  ]);
  tasks = await ensureView(tasks, 'À faire', 'TASKS', 'Tâche', ['Titre', 'Échéance', 'Priorité'], { taskDoneFieldId: field(format(tasks, 'Tâche'), 'Terminée'), taskDueFieldId: field(format(tasks, 'Tâche'), 'Échéance'), taskCompletedFieldId: field(format(tasks, 'Tâche'), 'Terminée le'), taskPriorityFieldId: field(format(tasks, 'Tâche'), 'Priorité') });

  let agenda = await ensureCollection('Démo · Agenda', [{ name: 'Rendez-vous', color: '#F4F0FF', fields: [
    { name: 'Titre', kind: 'TITLE' }, { name: 'Début', kind: 'DATETIME' }, { name: 'Fin', kind: 'DATETIME' }, { name: 'Lieu', kind: 'TEXT' }, { name: 'Notes', kind: 'LONG_TEXT' },
  ] }]);
  const events = await ensureEntries(agenda, 'Rendez-vous', [
    { Titre: 'Point d’équipe', Début: at(3, 9), Fin: at(3, 9, 45), Lieu: 'Visioconférence', Notes: 'Faire le point sur les tâches en cours.' },
    { Titre: 'Cours de langue', Début: at(4, 17), Fin: at(4, 18), Lieu: 'Centre culturel' },
    { Titre: 'Visite de contrôle', Début: at(6, 10), Fin: at(6, 10, 30), Lieu: 'Cabinet médical', Notes: 'Rendez-vous fictif de démonstration.' },
    { Titre: 'Revue hebdomadaire', Début: at(1, 8), Fin: at(1, 8, 30), Lieu: 'À domicile', Notes: 'Revoir les notes et les priorités.' },
  ]);
  agenda = await ensureView(agenda, 'Calendrier', 'CALENDAR', 'Rendez-vous', ['Titre', 'Début', 'Fin', 'Lieu'], { calendarStartFieldId: field(format(agenda, 'Rendez-vous'), 'Début'), calendarEndFieldId: field(format(agenda, 'Rendez-vous'), 'Fin'), calendarTimeZone: 'Africa/Lagos' });
  const recurring = events.get('Revue hebdomadaire');
  if (!recurring.recurrence) await gql('mutation($collectionId:String!,$viewId:String!,$entryId:String!,$input:EntryRecurrenceInput) { setCollectionEntryRecurrence(collectionId:$collectionId,viewId:$viewId,entryId:$entryId,input:$input) { id } }', { collectionId: agenda.id, viewId: agenda.savedViews.find((view) => view.name === 'Calendrier').id, entryId: recurring.id, input: { timeZone: 'Africa/Lagos', frequency: 'WEEKLY', interval: 1, excludedDates: [] } });

  let shop = await ensureCollection('Démo · Boutique', [{ name: 'Article', color: '#FFF0F4', objectModel: true, fields: [
    { name: 'Nom', kind: 'TITLE' }, { name: 'Marque', kind: 'TEXT' }, { name: 'Contenance', kind: 'TEXT' }, { name: 'Poids', kind: 'NUMBER', unit: 'kg' }, { name: 'Prix unitaire', kind: 'NUMBER', unit: 'EUR' },
  ] }]);
  const products = await ensureEntries(shop, 'Article', [
    { Nom: 'Bouteille d’eau 50 cl', Marque: 'Source claire', Contenance: '50 cl', Poids: '0.52', 'Prix unitaire': '1.2' },
    { Nom: 'Shampoing doux 250 ml', Marque: 'Belle feuille', Contenance: '250 ml', Poids: '0.28', 'Prix unitaire': '5.9' },
    { Nom: 'Cahier A5', Marque: 'Papier libre', Contenance: '96 pages', Poids: '0.18', 'Prix unitaire': '2.5' },
  ]);
  shop = await ensureFormat(shop, { name: 'Vente', color: '#EAF8FA', fields: [
    { name: 'Référence', kind: 'TITLE' }, { name: 'Article vendu', kind: 'OBJECT_REF', targetObjectFormatId: format(shop, 'Article').id, referenceMode: 'SNAPSHOT', variableName: 'article' }, { name: 'Quantité', kind: 'NUMBER' }, { name: 'Prix unitaire', kind: 'NUMBER', unit: 'EUR' }, { name: 'Date', kind: 'DATE' }, { name: 'Client', kind: 'TEXT' },
  ] });
  await ensureEntries(shop, 'Vente', [
    { Référence: 'Vente DEMO-001', 'Article vendu': JSON.stringify([products.get('Bouteille d’eau 50 cl').id]), Quantité: '3', 'Prix unitaire': '1.2', Date: day(-4), Client: 'Client comptoir' },
    { Référence: 'Vente DEMO-002', 'Article vendu': JSON.stringify([products.get('Shampoing doux 250 ml').id]), Quantité: '1', 'Prix unitaire': '5.9', Date: day(-3), Client: 'Client comptoir' },
    { Référence: 'Vente DEMO-003', 'Article vendu': JSON.stringify([products.get('Cahier A5').id]), Quantité: '2', 'Prix unitaire': '2.5', Date: day(-2), Client: 'Association locale' },
    { Référence: 'Vente DEMO-004', 'Article vendu': JSON.stringify([products.get('Bouteille d’eau 50 cl').id]), Quantité: '4', 'Prix unitaire': '1.2', Date: day(-1), Client: 'Client comptoir' },
  ]);
  shop = await ensureView(shop, 'Journal des ventes', 'TABLE', 'Vente', ['Référence', 'Article vendu', 'Quantité', 'Prix unitaire', 'Date']);
  shop = await ensureFormula(shop, 'Montant de la vente', 'Vente', { kind: 'operation', operator: 'MULTIPLY', args: [{ kind: 'field', fieldId: field(format(shop, 'Vente'), 'Quantité') }, { kind: 'field', fieldId: field(format(shop, 'Vente'), 'Prix unitaire') }] });

  let weather = await ensureCollection('Démo · Observations météo', [{ name: 'Relevé météo', color: '#FBF7E9', fields: [
    { name: 'Titre', kind: 'TITLE' }, { name: 'Date et heure', kind: 'DATETIME' }, { name: 'Température', kind: 'NUMBER', unit: '°C' }, { name: 'Pluie', kind: 'NUMBER', unit: 'mm' }, { name: 'Ciel', kind: 'SELECT', options: ['Dégagé', 'Nuageux', 'Pluvieux'] }, { name: 'Station', kind: 'TEXT' },
  ] }]);
  await ensureEntries(weather, 'Relevé météo', [
    [-6, 29.1, 0, 'Dégagé'], [-5, 28.4, 2.5, 'Nuageux'], [-4, 27.6, 11.2, 'Pluvieux'], [-3, 30.2, 0, 'Dégagé'], [-2, 29.8, 0.4, 'Nuageux'], [-1, 28.9, 5.1, 'Pluvieux'], [0, 29.4, 0, 'Dégagé'],
  ].map(([offset, temperature, rain, sky]) => ({ Titre: `Relevé ${day(offset)}`, 'Date et heure': at(offset, 8), Température: String(temperature), Pluie: String(rain), Ciel: sky, Station: 'Station Lagos A (fictive)' })));
  weather = await ensureView(weather, 'Relevés', 'TABLE', 'Relevé météo', ['Titre', 'Date et heure', 'Température', 'Pluie', 'Ciel']);

  let health = await ensureCollection('Démo · Santé personnelle', [
    { name: 'Mesure', color: '#F1F8ED', fields: [{ name: 'Titre', kind: 'TITLE' }, { name: 'Date', kind: 'DATE' }, { name: 'Pouls au repos', kind: 'NUMBER', unit: 'bpm' }, { name: 'Sommeil', kind: 'DURATION' }, { name: 'Note', kind: 'TEXT' }] },
    { name: 'Journal de santé', color: '#F8F0FA', fields: [{ name: 'Titre', kind: 'TITLE' }, { name: 'Date', kind: 'DATE' }, { name: 'Catégorie', kind: 'SELECT', options: ['Habitude', 'Rendez-vous', 'Observation'] }, { name: 'Détails', kind: 'LONG_TEXT' }] },
  ]);
  await ensureEntries(health, 'Mesure', [[-6, 72, '7:20'], [-5, 70, '7:45'], [-4, 74, '6:50'], [-3, 69, '8:10'], [-2, 71, '7:30'], [-1, 73, '7:05'], [0, 70, '7:40']].map(([offset, pulse, sleep]) => ({ Titre: `Mesure ${day(offset)}`, Date: day(offset), 'Pouls au repos': String(pulse), Sommeil: sleep, Note: 'Valeurs fictives pour tester la saisie.' })));
  await ensureEntries(health, 'Journal de santé', [
    { Titre: 'Marche du matin', Date: day(-2), Catégorie: 'Habitude', Détails: 'Promenade tranquille de trente minutes.' },
    { Titre: 'Suivi personnel', Date: day(0), Catégorie: 'Observation', Détails: 'Notes de démonstration, sans interprétation médicale.' },
  ]);
  health = await ensureView(health, 'Mesures récentes', 'TABLE', 'Mesure', ['Titre', 'Date', 'Pouls au repos', 'Sommeil']);

  let science = await ensureCollection('Démo · Expérience scientifique', [{ name: 'Échantillon', color: '#F1F5FA', objectModel: true, fields: [
    { name: 'Nom', kind: 'TITLE' }, { name: 'Origine', kind: 'TEXT' }, { name: 'Masse initiale', kind: 'NUMBER', unit: 'g' }, { name: 'Prélevé le', kind: 'DATE' },
  ] }]);
  const samples = await ensureEntries(science, 'Échantillon', [
    { Nom: 'Sol A', Origine: 'Parcelle nord (fictive)', 'Masse initiale': '150', 'Prélevé le': day(-6) },
    { Nom: 'Sol B', Origine: 'Parcelle sud (fictive)', 'Masse initiale': '155', 'Prélevé le': day(-6) },
  ]);
  science = await ensureFormat(science, { name: 'Mesure de séchage', color: '#FFF7F1', fields: [
    { name: 'Titre', kind: 'TITLE' }, { name: 'Échantillon', kind: 'OBJECT_REF', targetObjectFormatId: format(science, 'Échantillon').id, referenceMode: 'SNAPSHOT' }, { name: 'Date', kind: 'DATE' }, { name: 'Masse après séchage', kind: 'NUMBER', unit: 'g' }, { name: 'Durée de séchage', kind: 'DURATION' }, { name: 'Observation', kind: 'LONG_TEXT' },
  ] });
  await ensureEntries(science, 'Mesure de séchage', [
    { Titre: 'Sol A · essai 1', Échantillon: JSON.stringify([samples.get('Sol A').id]), Date: day(-5), 'Masse après séchage': '126.4', 'Durée de séchage': '2:00', Observation: 'Protocole identique pour les deux échantillons.' },
    { Titre: 'Sol B · essai 1', Échantillon: JSON.stringify([samples.get('Sol B').id]), Date: day(-5), 'Masse après séchage': '131.7', 'Durée de séchage': '2:00', Observation: 'Masse mesurée après refroidissement.' },
    { Titre: 'Sol A · essai 2', Échantillon: JSON.stringify([samples.get('Sol A').id]), Date: day(-3), 'Masse après séchage': '125.9', 'Durée de séchage': '2:15', Observation: 'Répétition de contrôle.' },
  ]);
  science = await ensureView(science, 'Résultats', 'TABLE', 'Mesure de séchage', ['Titre', 'Échantillon', 'Date', 'Masse après séchage']);
  science = await ensureFormula(science, 'Perte de masse', 'Mesure de séchage', { kind: 'operation', operator: 'SUBTRACT', args: [{ kind: 'property', referenceFieldId: field(format(science, 'Mesure de séchage'), 'Échantillon'), propertyFieldId: field(format(science, 'Échantillon'), 'Masse initiale') }, { kind: 'field', fieldId: field(format(science, 'Mesure de séchage'), 'Masse après séchage') }] });

  const formulaExamples = [];
  for (const [collection, formulaName, formatName, entryTitle, expected] of [
    [shop, 'Montant de la vente', 'Vente', 'Vente DEMO-001', '3.6'],
    [science, 'Perte de masse', 'Mesure de séchage', 'Sol A · essai 1', '23.6'],
  ]) {
    const definition = format(collection, formatName);
    const titleId = definition.fields.find((item) => item.kind === 'TITLE').id;
    const entries = (await gql(entriesQuery, { id: collection.id })).collectionEntries;
    const entry = entries.find((item) => item.formatId === definition.id && item.values.some((value) => value.fieldId === titleId && value.value === entryTitle));
    const formula = collection.formulas.find((item) => item.name === formulaName && item.formatId === definition.id);
    assert.ok(entry && formula, `Missing formula example ${formulaName}`);
    const result = (await gql('query($collectionId:String!,$formulaId:String!,$entryId:String!) { calculateCollectionFormula(collectionId:$collectionId,formulaId:$formulaId,entryId:$entryId) { value unit missing } }', { collectionId: collection.id, formulaId: formula.id, entryId: entry.id })).calculateCollectionFormula;
    assert.equal(result.value, expected, `Wrong result for ${formulaName}`);
    formulaExamples.push({ formula: formulaName, entry: entryTitle, value: result.value, unit: result.unit });
  }

  const summary = [];
  for (const collection of collections.filter((item) => item.name.startsWith('Démo · '))) {
    const entries = (await gql(entriesQuery, { id: collection.id })).collectionEntries;
    summary.push({ name: collection.name, formats: collection.formats.length, entries: entries.length, views: collection.savedViews.length });
  }
  console.log(JSON.stringify({ account: users[0].email, createdCollections, createdEntries, createdViews, createdFormulas, formulaExamples, summary }, null, 2));
} finally {
  await mongoose.disconnect();
}
