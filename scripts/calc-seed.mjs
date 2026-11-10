// Calculation playground: 7 collections with 3 to 6 months of dated numbers for the
// person's own local account, so sums, averages, trends and comparisons over any period
// (13 days, 3 weeks, 3 months…) have something to work on. Values are fictitious and
// generated from a fixed seed, so every run produces the same data relative to today.
// Run from api/ with the API running: node --env-file=.env scripts/calc-seed.mjs
// A collection that already exists is left untouched (delete it in the app to regenerate).
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import mongoose from 'mongoose';

assert.ok(process.env.MONGODB_URI, 'MONGODB_URI is required');
await mongoose.connect(process.env.MONGODB_URI);
const users = (await mongoose.connection.collection('users').find({}, { projection: { _id: 1, email: 1 } }).toArray())
  .filter((user) => !String(user.email).endsWith('@example.test'));
assert.equal(users.length, 1, 'Expected exactly one real (non @example.test) account; refusing to guess an owner');
const ownerId = String(users[0]._id);
const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const payload = Buffer.from(JSON.stringify({ sub: ownerId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
const token = `${header}.${payload}.${createHmac('sha256', process.env.JWT_SECRET || 'brainy-local-development-secret-change-before-deploying').update(`${header}.${payload}`).digest('base64url')}`;
const endpoint = `http://localhost:${process.env.PORT || 3000}/graphql`;

async function gql(query, variables = {}) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ query, variables }) });
  const result = await response.json();
  if (result.errors?.length) throw new Error(result.errors.map((error) => error.message).join('; '));
  return result.data;
}

const shape = 'id name formats { id name fields { id name kind } } savedViews { id name } formulas { id name formatId } units { id symbol }';
const existing = new Map((await gql(`query { collectionsList { ${shape} } }`)).collectionsList.map((item) => [item.name, item]));

// Deterministic pseudo-random numbers (mulberry32).
let state = 20261110;
function random() { state |= 0; state = (state + 0x6d2b79f5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const between = (min, max) => min + random() * (max - min);
const round = (value, step) => Math.round(value / step) * step;
const pick = (list) => list[Math.floor(random() * list.length)];
const chance = (p) => random() < p;

const today = new Date(); today.setUTCHours(12, 0, 0, 0);
const dateAt = (offset) => { const date = new Date(today); date.setUTCDate(date.getUTCDate() + offset); return date; };
const iso = (offset) => dateAt(offset).toISOString().slice(0, 10);
const duration = (raw) => { const minutes = Math.round(raw); return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`; };
const months = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

const report = [];

/** Creates the collection with one data format, its entries, a table view and formulas. */
async function seed({ name, format, rows, view, units = [], formulas = [] }) {
  let collection = existing.get(name);
  const isNew = !collection;
  if (isNew) collection = (await gql(`mutation($input:CreateCollectionInput!) { createCollection(input:$input) { ${shape} } }`, { input: { name, formats: [format] } })).createCollection;
  const definition = collection.formats[0];
  const fieldId = (fieldName) => { const found = definition.fields.find((item) => item.name === fieldName); assert.ok(found, `Missing field ${fieldName}`); return found.id; };
  // Ratio units such as FCFA/kg let a division formula keep a meaningful unit.
  for (const unit of units) {
    if ((collection.units ?? []).some((item) => item.symbol === unit.symbol)) continue;
    collection = (await gql(`mutation($id:String!,$input:CollectionUnitInput!) { saveCollectionUnit(collectionId:$id,input:$input) { ${shape} } }`, { id: collection.id, input: unit })).saveCollectionUnit;
  }
  if (!isNew) {
    const added = await saveFormulas(collection, definition, fieldId, formulas.filter((formula) => !collection.formulas.some((item) => item.name === formula.name)));
    report.push({ name, status: 'already present: entries left untouched', formulasAdded: added });
    return;
  }
  let created = 0;
  for (const row of rows) {
    const values = Object.entries(row).filter(([, value]) => value !== undefined && value !== null && value !== '').map(([fieldName, value]) => ({ fieldId: fieldId(fieldName), value: String(value) }));
    await gql('mutation($id:String!,$input:SaveEntryInput!) { createEntry(collectionId:$id,input:$input) { id } }', { id: collection.id, input: { formatId: definition.id, values } });
    created++;
  }
  collection = (await gql(`mutation($id:String!,$input:SavedCollectionViewInput!) { saveCollectionView(collectionId:$id,input:$input) { ${shape} } }`, { id: collection.id, input: { name: view.name, layout: 'TABLE', formatIds: [definition.id], columnFieldIds: view.columns.map(fieldId), sort: 'NEWEST', groupByFormat: false } })).saveCollectionView;
  report.push({ name, status: 'created', entries: created, formulas: await saveFormulas(collection, definition, fieldId, formulas) });
}

async function saveFormulas(collection, definition, fieldId, formulas) {
  const saved = [];
  for (const formula of formulas) {
    try {
      await gql(`mutation($collectionId:String!,$input:FormulaInput!) { saveCollectionFormula(collectionId:$collectionId,input:$input) { id } }`, { collectionId: collection.id, input: { name: formula.name, formatId: definition.id, expression: JSON.stringify(formula.build(fieldId)) } });
      saved.push(formula.name);
    } catch (error) {
      saved.push(`${formula.name} (refused: ${error.message})`);
    }
  }
  return saved;
}

const field = (fieldId) => ({ kind: 'field', fieldId });
const op = (operator, left, right) => ({ kind: 'operation', operator, args: [left, right] });
const number = (value) => ({ kind: 'number', value: String(value) });

try {
  // 1. Expenses and income: 6 months, the signed "Net" column sums to the money actually made.
  {
    const rows = [];
    const add = (offset, label, type, category, amount, payment) => {
      const value = round(amount, 50);
      rows.push({ Libellé: `${label} · ${iso(offset)}${rows.some((row) => row.Libellé.startsWith(`${label} · ${iso(offset)}`)) ? ` (${rows.length})` : ''}`, Date: iso(offset), Type: type, Catégorie: category, Montant: value, Net: type === 'Revenu' ? value : -value, 'Moyen de paiement': payment });
    };
    for (let offset = -182; offset <= 0; offset++) {
      const date = dateAt(offset), day = date.getUTCDate(), weekday = date.getUTCDay(), month = months[date.getUTCMonth()];
      if (day === 28) add(offset, `Salaire de ${month}`, 'Revenu', 'Salaire', 350000, 'Virement');
      if (day === 5) add(offset, 'Loyer', 'Dépense', 'Logement', 120000, 'Virement');
      if (day === 10) add(offset, 'Électricité', 'Dépense', 'Factures', between(15000, 32000), 'Mobile Money');
      if (day === 12) add(offset, 'Eau', 'Dépense', 'Factures', between(5000, 9000), 'Mobile Money');
      if (day === 15) add(offset, 'Internet et téléphone', 'Dépense', 'Factures', 20000, 'Mobile Money');
      if (day === 1) add(offset, 'Épargne mensuelle', 'Dépense', 'Épargne', 50000, 'Virement');
      if (day === 8 || day === 22) add(offset, 'Mission freelance', 'Revenu', 'Prestation', between(45000, 160000), 'Virement');
      if (chance(0.45)) add(offset, 'Vente de produits', 'Revenu', 'Vente', between(5000, 40000), pick(['Espèces', 'Mobile Money']));
      if (chance(0.9)) add(offset, 'Courses et repas', 'Dépense', 'Alimentation', between(2500, 9000), pick(['Espèces', 'Mobile Money', 'Carte']));
      if (weekday >= 1 && weekday <= 5) add(offset, 'Transport', 'Dépense', 'Transport', between(1000, 3500), pick(['Espèces', 'Mobile Money']));
      if ((weekday === 0 || weekday === 6) && chance(0.55)) add(offset, 'Sortie', 'Dépense', 'Loisirs', between(5000, 25000), pick(['Espèces', 'Carte']));
      if (chance(0.04)) add(offset, 'Pharmacie', 'Dépense', 'Santé', between(3000, 18000), 'Espèces');
    }
    await seed({
      name: 'Calculs · Dépenses et revenus',
      format: { name: 'Opération', color: '#EDF9F3', fields: [
        { name: 'Libellé', kind: 'TITLE' }, { name: 'Date', kind: 'DATE' }, { name: 'Type', kind: 'SELECT', options: ['Revenu', 'Dépense'] },
        { name: 'Catégorie', kind: 'SELECT', options: ['Salaire', 'Prestation', 'Vente', 'Logement', 'Factures', 'Alimentation', 'Transport', 'Loisirs', 'Santé', 'Épargne'] },
        { name: 'Montant', kind: 'NUMBER', unit: 'FCFA' }, { name: 'Net', kind: 'NUMBER', unit: 'FCFA' },
        { name: 'Moyen de paiement', kind: 'SELECT', options: ['Espèces', 'Mobile Money', 'Carte', 'Virement'] },
      ] },
      rows,
      view: { name: 'Toutes les opérations', columns: ['Libellé', 'Date', 'Type', 'Catégorie', 'Montant', 'Net'] },
      formulas: [{ name: 'Montant hors TVA (18 %)', build: (id) => op('DIVIDE', field(id('Montant')), number('1.18')) }],
    });
  }

  // 2. Shop sales: quantities, prices and costs give turnover and margin.
  {
    const products = [['Riz 5 kg', 4500, 3800], ['Huile 1 L', 1500, 1150], ['Sucre 1 kg', 900, 700], ['Savon', 350, 220], ['Lait en poudre', 2800, 2200]];
    const rows = [];
    let reference = 1;
    for (let offset = -120; offset <= 0; offset++) {
      const count = Math.floor(between(0, 4));
      for (let index = 0; index < count; index++) {
        const [product, price, cost] = pick(products);
        rows.push({ Référence: `V-${String(reference++).padStart(4, '0')}`, Date: iso(offset), Produit: product, Quantité: Math.ceil(between(1, 8)), 'Prix unitaire': price, 'Coût unitaire': cost, Client: pick(['Comptoir', 'Comptoir', 'Restaurant Chez Ami', 'École du quartier']) });
      }
    }
    await seed({
      name: 'Calculs · Ventes boutique',
      format: { name: 'Vente', color: '#FFF0F4', fields: [
        { name: 'Référence', kind: 'TITLE' }, { name: 'Date', kind: 'DATE' }, { name: 'Produit', kind: 'SELECT', options: products.map(([name]) => name) },
        { name: 'Quantité', kind: 'NUMBER' }, { name: 'Prix unitaire', kind: 'NUMBER', unit: 'FCFA' }, { name: 'Coût unitaire', kind: 'NUMBER', unit: 'FCFA' }, { name: 'Client', kind: 'TEXT' },
      ] },
      rows,
      view: { name: 'Journal des ventes', columns: ['Référence', 'Date', 'Produit', 'Quantité', 'Prix unitaire'] },
      formulas: [
        { name: 'Chiffre d’affaires', build: (id) => op('MULTIPLY', field(id('Quantité')), field(id('Prix unitaire'))) },
        { name: 'Marge', build: (id) => op('MULTIPLY', field(id('Quantité')), op('SUBTRACT', field(id('Prix unitaire')), field(id('Coût unitaire')))) },
      ],
    });
  }

  // 3. Sport: distances, durations, heart rate and calories per activity.
  {
    const rows = [];
    for (let offset = -120; offset <= 0; offset++) {
      if (!chance(0.5)) continue;
      const activity = pick(['Course', 'Course', 'Vélo', 'Natation', 'Marche']);
      const speed = { Course: between(8.5, 11.5), Vélo: between(18, 26), Natation: between(2, 3), Marche: between(4.5, 6) }[activity];
      const minutes = Math.round(between(25, 75));
      const distance = Number((speed * minutes / 60).toFixed(2));
      rows.push({ Titre: `${activity} · ${iso(offset)}`, Date: iso(offset), Activité: activity, Distance: distance, Durée: duration(minutes), 'Fréquence cardiaque': Math.round(between(118, 162)), Calories: Math.round(minutes * between(6, 11)) });
    }
    await seed({
      name: 'Calculs · Sport',
      format: { name: 'Séance', color: '#F4F0FF', fields: [
        { name: 'Titre', kind: 'TITLE' }, { name: 'Date', kind: 'DATE' }, { name: 'Activité', kind: 'SELECT', options: ['Course', 'Vélo', 'Natation', 'Marche'] },
        { name: 'Distance', kind: 'NUMBER', unit: 'km' }, { name: 'Durée', kind: 'DURATION' }, { name: 'Fréquence cardiaque', kind: 'NUMBER', unit: 'bpm' }, { name: 'Calories', kind: 'NUMBER' },
      ] },
      rows,
      view: { name: 'Séances', columns: ['Titre', 'Activité', 'Distance', 'Durée'] },
      units: [{ name: 'Kilomètre par heure', symbol: 'km/h', dimension: 'SPEED', factor: '1' }],
      formulas: [{ name: 'Vitesse moyenne', build: (id) => op('DIVIDE', field(id('Distance')), { kind: 'durationIn', unit: 'HOURS', duration: { kind: 'durationField', fieldId: id('Durée') } }) }],
    });
  }

  // 4. Fuel: litres, amount paid and odometer (a cumulative reading: use "successive difference").
  {
    const rows = [];
    let odometer = 48250;
    for (let offset = -180; offset <= 0; offset += Math.round(between(4, 9))) {
      odometer += Math.round(between(220, 480));
      const litres = Number(between(28, 45).toFixed(1));
      const pricePerLitre = offset < -90 ? 875 : 840;
      rows.push({ Titre: `Plein · ${iso(offset)}`, Date: iso(offset), Litres: litres, 'Montant payé': round(litres * pricePerLitre, 5), Compteur: odometer, Station: pick(['Station Plateau', 'Station Cocody', 'Station Yopougon']) });
    }
    await seed({
      name: 'Calculs · Carburant',
      format: { name: 'Plein', color: '#FBF7E9', fields: [
        { name: 'Titre', kind: 'TITLE' }, { name: 'Date', kind: 'DATE' }, { name: 'Litres', kind: 'NUMBER', unit: 'L' }, { name: 'Montant payé', kind: 'NUMBER', unit: 'FCFA' },
        { name: 'Compteur', kind: 'NUMBER', unit: 'km' }, { name: 'Station', kind: 'SELECT', options: ['Station Plateau', 'Station Cocody', 'Station Yopougon'] },
      ] },
      rows,
      view: { name: 'Pleins', columns: ['Titre', 'Litres', 'Montant payé', 'Compteur'] },
      units: [{ name: 'FCFA par litre', symbol: 'FCFA/L', dimension: 'PRICE_PER_VOLUME', factor: '1' }],
      formulas: [{ name: 'Prix au litre', build: (id) => op('DIVIDE', field(id('Montant payé')), field(id('Litres'))) }],
    });
  }

  // 5. School marks out of 20 with coefficients (weighted average).
  {
    const subjects = [['Mathématiques', 4, 13], ['Français', 3, 12], ['Anglais', 2, 14], ['Physique', 3, 11], ['Histoire', 2, 13.5]];
    const rows = [];
    for (let offset = -150; offset <= 0; offset += 3) {
      const [subject, coefficient, level] = pick(subjects);
      const kind = pick(['Interrogation', 'Interrogation', 'Devoir', 'Examen']);
      const mark = Math.min(20, Math.max(2, round(level + (offset + 150) / 60 + between(-4, 4), 0.5)));
      rows.push({ Titre: `${subject} · ${kind} · ${iso(offset)}`, Date: iso(offset), Matière: subject, Type: kind, Note: mark, Coefficient: kind === 'Examen' ? coefficient * 2 : coefficient });
    }
    await seed({
      name: 'Calculs · Notes scolaires',
      format: { name: 'Évaluation', color: '#EEF5FF', fields: [
        { name: 'Titre', kind: 'TITLE' }, { name: 'Date', kind: 'DATE' }, { name: 'Matière', kind: 'SELECT', options: subjects.map(([name]) => name) },
        { name: 'Type', kind: 'SELECT', options: ['Interrogation', 'Devoir', 'Examen'] }, { name: 'Note', kind: 'NUMBER' }, { name: 'Coefficient', kind: 'NUMBER' },
      ] },
      rows,
      view: { name: 'Bulletin', columns: ['Titre', 'Matière', 'Note', 'Coefficient'] },
      formulas: [
        { name: 'Points pondérés', build: (id) => op('MULTIPLY', field(id('Note')), field(id('Coefficient'))) },
        { name: 'Note sur 100', build: (id) => op('MULTIPLY', field(id('Note')), number('5')) },
      ],
    });
  }

  // 6. Daily weight, sleep, steps and water: a slow downward weight trend for trend and moving averages.
  {
    const rows = [];
    for (let offset = -90; offset <= 0; offset++) {
      if (chance(0.1)) continue;
      rows.push({ Titre: `Mesure · ${iso(offset)}`, Date: iso(offset), Poids: Number((82 - (offset + 90) * 0.03 + between(-0.6, 0.6)).toFixed(1)), Sommeil: duration(between(330, 500)), Pas: Math.round(between(3500, 13000)), 'Eau bue': Number(between(1.2, 2.8).toFixed(1)) });
    }
    await seed({
      name: 'Calculs · Poids et sommeil',
      format: { name: 'Mesure du jour', color: '#F1F8ED', fields: [
        { name: 'Titre', kind: 'TITLE' }, { name: 'Date', kind: 'DATE' }, { name: 'Poids', kind: 'NUMBER', unit: 'kg' }, { name: 'Sommeil', kind: 'DURATION' },
        { name: 'Pas', kind: 'NUMBER' }, { name: 'Eau bue', kind: 'NUMBER', unit: 'L' },
      ] },
      rows,
      view: { name: 'Mesures', columns: ['Titre', 'Poids', 'Sommeil', 'Pas'] },
      formulas: [{ name: 'Distance estimée (pas × 0,75 m)', build: (id) => op('MULTIPLY', field(id('Pas')), { kind: 'number', value: '0.75', unit: 'm' }) }],
    });
  }

  // 7. Harvests per plot and crop, with rainfall and sale amount (cross-tables plot × month).
  {
    const crops = [['Maïs', 250, 450], ['Tomate', 400, 650], ['Manioc', 150, 300]];
    const rows = [];
    for (let offset = -180; offset <= 0; offset += 2) {
      if (!chance(0.6)) continue;
      const [crop, low, high] = pick(crops);
      const plot = pick(['Parcelle Nord', 'Parcelle Sud', 'Parcelle Est']);
      const quantity = Math.round(between(40, 320));
      rows.push({ Titre: `${crop} · ${plot} · ${iso(offset)}`, Date: iso(offset), Parcelle: plot, Culture: crop, Quantité: quantity, 'Montant vendu': round(quantity * between(low, high), 25), Pluie: Number((chance(0.4) ? 0 : between(1, 35)).toFixed(1)) });
    }
    await seed({
      name: 'Calculs · Récoltes',
      format: { name: 'Récolte', color: '#FFF7F1', fields: [
        { name: 'Titre', kind: 'TITLE' }, { name: 'Date', kind: 'DATE' }, { name: 'Parcelle', kind: 'SELECT', options: ['Parcelle Nord', 'Parcelle Sud', 'Parcelle Est'] },
        { name: 'Culture', kind: 'SELECT', options: crops.map(([name]) => name) }, { name: 'Quantité', kind: 'NUMBER', unit: 'kg' }, { name: 'Montant vendu', kind: 'NUMBER', unit: 'FCFA' }, { name: 'Pluie', kind: 'NUMBER', unit: 'mm' },
      ] },
      rows,
      view: { name: 'Récoltes', columns: ['Titre', 'Culture', 'Quantité', 'Montant vendu'] },
      units: [{ name: 'FCFA par kilogramme', symbol: 'FCFA/kg', dimension: 'PRICE_PER_MASS', factor: '1' }],
      formulas: [{ name: 'Prix moyen au kg', build: (id) => op('DIVIDE', field(id('Montant vendu')), field(id('Quantité'))) }],
    });
  }

  console.log(JSON.stringify({ account: users[0].email.replace(/^(.).*@/, '$1***@'), report }, null, 2));
} finally {
  await mongoose.disconnect();
}
