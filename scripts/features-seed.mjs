// Feature playground: 10 collections that exercise Brainy's calculations and features on
// fictitious data for the person's own local account (formulas of every kind, measures with
// uncertainty, forecasts, geography and classifications, stock, objects and components,
// workflows, an append-only ledger, sensitive fields, rates and meter readings).
// Run from api/ with the API running: node --env-file=.env scripts/features-seed.mjs [--replace | --rebuild=Atelier,Caisse]
// Without --replace an existing collection is left untouched; with it, this script's
// collections are deleted and rebuilt. Each collection is seeded on its own, so one
// failure is reported without stopping the others.
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
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
const replaceAll = process.argv.includes('--replace');
// --rebuild=Atelier,Caisse rebuilds only the collections whose name contains one of these words.
const rebuild = (process.argv.find((arg) => arg.startsWith('--rebuild='))?.slice(10).split(',') ?? []).filter(Boolean);
const shouldReplace = (name) => replaceAll || rebuild.some((part) => name.includes(part));

async function gql(query, variables = {}) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ query, variables }) });
  const result = await response.json();
  if (result.errors?.length) throw new Error(result.errors.map((error) => error.message).join('; '));
  return result.data;
}

const SHAPE = 'id name formats { id name version objectModel fields { id name kind } workflow { stateFieldId initialState transitions { from to } } } formulas { id name formatId } units { id symbol } stockRules { id kind formatId }';
const existing = new Map((await gql(`query { collectionsList { id name } }`)).collectionsList.map((item) => [item.name, item]));

// Deterministic pseudo-random numbers (mulberry32), so reruns give the same data.
let state = 77001;
function random() { state |= 0; state = (state + 0x6d2b79f5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const between = (min, max) => min + random() * (max - min);
const round = (value, step) => Math.round(value / step) * step;
const pick = (list) => list[Math.floor(random() * list.length)];
const chance = (p) => random() < p;
const fixed = (value, digits) => Number(value.toFixed(digits));

const today = new Date(); today.setUTCHours(12, 0, 0, 0);
const dateAt = (offset) => { const date = new Date(today); date.setUTCDate(date.getUTCDate() + offset); return date; };
const iso = (offset) => dateAt(offset).toISOString().slice(0, 10);
const isoTime = (offset, hour, minute = 0) => `${iso(offset)}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`;
const monthDay = (monthsBack, day = 15) => { const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - monthsBack, day, 12)); return date.toISOString().slice(0, 10); };

// --- Small helpers shared by every collection --------------------------------------
const createCollection = async (name, formats) => (await gql(`mutation($input:CreateCollectionInput!) { createCollection(input:$input) { ${SHAPE} } }`, { input: { name, formats } })).createCollection;
const refetch = async (id) => (await gql(`query { collectionsList { ${SHAPE} } }`)).collectionsList.find((item) => item.id === id);
const formatOf = (collection, name) => { const found = collection.formats.find((item) => item.name === name); assert.ok(found, `Missing data format ${name}`); return found; };
const ids = (format) => Object.fromEntries(format.fields.map((item) => [item.name, item.id]));

/** row: { fieldName: value | { value, measureValue } }; empty values are skipped. */
async function addEntry(collection, format, row) {
  const fields = ids(format);
  const values = Object.entries(row).filter(([, value]) => value !== undefined && value !== null && value !== '').map(([name, value]) => {
    assert.ok(fields[name], `Missing field ${format.name}.${name}`);
    return typeof value === 'object' ? { fieldId: fields[name], ...value, value: String(value.value) } : { fieldId: fields[name], value: String(value) };
  });
  return (await gql('mutation($id:String!,$input:SaveEntryInput!) { createEntry(collectionId:$id,input:$input) { id updatedAt } }', { id: collection.id, input: { formatId: format.id, values } })).createEntry;
}
async function addView(collection, format, name, columns) {
  const fields = ids(format);
  await gql('mutation($id:String!,$input:SavedCollectionViewInput!) { saveCollectionView(collectionId:$id,input:$input) { id } }', { id: collection.id, input: { name, layout: 'TABLE', formatIds: [format.id], columnFieldIds: columns.map((column) => fields[column]), sort: 'NEWEST', groupByFormat: false } });
}
async function addUnit(collection, unit) {
  await gql('mutation($id:String!,$input:CollectionUnitInput!) { saveCollectionUnit(collectionId:$id,input:$input) { id } }', { id: collection.id, input: unit });
}
/** Saves each formula in order; a refused one is reported and the others still go in. */
async function addFormulas(collection, format, formulas, report) {
  const saved = {};
  for (const [name, build] of formulas) {
    try {
      const result = (await gql(`mutation($collectionId:String!,$input:FormulaInput!) { saveCollectionFormula(collectionId:$collectionId,input:$input) { formulas { id name formatId } } }`, { collectionId: collection.id, input: { name, formatId: format.id, expression: JSON.stringify(build(saved)) } })).saveCollectionFormula;
      saved[name] = result.formulas.find((item) => item.name === name && item.formatId === format.id).id;
      report.formulas.push(name);
    } catch (error) {
      report.refused.push(`${name}: ${error.message}`);
    }
  }
}

// Formula building blocks (see src/collections/formula_nodes.ts).
const F = {
  field: (fieldId) => ({ kind: 'field', fieldId }),
  num: (value, unit) => (unit ? { kind: 'number', value: String(value), unit } : { kind: 'number', value: String(value) }),
  op: (operator, left, right) => ({ kind: 'operation', operator, args: [left, right] }),
  date: (fieldId) => ({ kind: 'dateField', fieldId }),
  text: (fieldId) => ({ kind: 'textField', fieldId }),
  lit: (value) => ({ kind: 'textLiteral', value }),
  cmp: (operator, left, right) => ({ kind: 'comparison', operator, left, right }),
};

const report = [];
async function seed(name, build) {
  const entry = { name, status: '', entries: 0, formulas: [], refused: [], notes: [] };
  report.push(entry);
  const found = existing.get(name);
  if (found && !shouldReplace(name)) { entry.status = 'already present, left untouched (use --replace or --rebuild=<word> to rebuild)'; return; }
  if (found) {
    // A collection holding a ledger is protected from deletion until a retention policy exists.
    try { await gql('mutation($id:String!) { deleteCollection(id:$id) }', { id: found.id }); } catch (error) { entry.status = `kept: ${error.message}`; return; }
  }
  try {
    await build(entry);
    entry.status = found ? 'rebuilt' : 'created';
  } catch (error) {
    entry.status = `FAILED: ${error.message}`;
  }
}

try {
  // 1. Formulas: dates, durations, text, conditions, rounding, min/max and formula reuse.
  await seed('Calculs · Formules (dates, texte, conditions)', async (r) => {
    const collection = await createCollection('Calculs · Formules (dates, texte, conditions)', [{ name: 'Contrat', color: '#EEF5FF', fields: [
      { name: 'Titre', kind: 'TITLE' }, { name: 'Client', kind: 'TEXT' }, { name: 'Début', kind: 'DATE' }, { name: 'Fin', kind: 'DATE' },
      { name: 'Montant mensuel', kind: 'NUMBER', unit: 'FCFA' }, { name: 'Remise', kind: 'NUMBER' }, { name: 'Pénalité', kind: 'NUMBER', unit: 'FCFA' },
      { name: 'Arrivée', kind: 'DATETIME' }, { name: 'Départ', kind: 'DATETIME' }, { name: 'Pause', kind: 'DURATION' }, { name: 'Note interne', kind: 'TEXT' },
    ] }]);
    const format = collection.formats[0];
    const clients = ['awa koné', 'société BATIR', 'jean-marc yao', 'clinique sainte rita', 'école les palmiers', 'fatou diallo', 'garage du port', 'hôtel la lagune'];
    for (let index = 0; index < 24; index++) {
      const start = -Math.round(between(20, 400));
      const months = Math.round(between(3, 24));
      const arrival = Math.round(between(7, 10));
      await addEntry(collection, format, {
        Titre: `Contrat ${String(index + 1).padStart(3, '0')}`, Client: pick(clients), Début: iso(start), Fin: iso(start + months * 30),
        'Montant mensuel': round(between(40000, 450000), 500), Remise: pick([0, 0, 5, 10, 15]), Pénalité: chance(0.3) ? round(between(5000, 60000), 500) : '',
        Arrivée: isoTime(start, arrival, pick([0, 15, 30])), Départ: isoTime(start, arrival + Math.round(between(7, 10)), pick([0, 20, 45])), Pause: pick(['0:30', '0:45', '1:00', '1:30']),
        'Note interne': chance(0.5) ? 'À renouveler' : '',
      });
      r.entries++;
    }
    await addView(collection, format, 'Contrats', ['Titre', 'Client', 'Début', 'Fin', 'Montant mensuel']);
    const f = ids(format);
    const amount = F.field(f['Montant mensuel']);
    await addFormulas(collection, format, [
      ['Durée du contrat (mois)', () => ({ kind: 'dateDiff', unit: 'MONTHS', start: F.date(f.Début), end: F.date(f.Fin) })],
      ['Durée du contrat (jours)', () => ({ kind: 'dateDiff', unit: 'DAYS', start: F.date(f.Début), end: F.date(f.Fin) })],
      ['Valeur totale', (saved) => ({ kind: 'round', digits: 0, mode: 'HALF_UP', value: F.op('MULTIPLY', amount, { kind: 'dateDiff', unit: 'MONTHS', start: F.date(f.Début), end: F.date(f.Fin) }) })],
      ['Valeur totale TTC (formule réutilisée)', (saved) => F.op('MULTIPLY', { kind: 'formula', formulaId: saved['Valeur totale'] }, F.num('1.18'))],
      ['Montant après remise', () => F.op('MULTIPLY', amount, F.op('SUBTRACT', F.num(1), F.op('DIVIDE', F.field(f.Remise), F.num(100))))],
      ['Mois de début', () => ({ kind: 'datePart', part: 'MONTH', date: F.date(f.Début) })],
      ['Année de fin', () => ({ kind: 'datePart', part: 'YEAR', date: F.date(f.Fin) })],
      ['Jour de la semaine de fin (1 = lundi)', () => ({ kind: 'datePart', part: 'WEEKDAY', date: F.date(f.Fin) })],
      ['Date de relance (30 jours avant la fin)', () => ({ kind: 'addDays', date: F.date(f.Fin), days: F.num(-30) })],
      ['Premier jour du mois de début', () => ({ kind: 'startOfMonth', date: F.date(f.Début) })],
      ['Dernier jour du mois de fin', () => ({ kind: 'endOfMonth', date: F.date(f.Fin) })],
      ['Heures de présence', () => ({ kind: 'dateDifference', fromFieldId: f.Arrivée, toFieldId: f.Départ, unit: 'h' })],
      ['Pause en minutes', () => ({ kind: 'durationIn', unit: 'MINUTES', duration: { kind: 'durationField', fieldId: f.Pause } })],
      ['Heures travaillées', () => F.op('SUBTRACT', { kind: 'dateDifference', fromFieldId: f.Arrivée, toFieldId: f.Départ, unit: 'h' }, { kind: 'durationIn', unit: 'HOURS', duration: { kind: 'durationField', fieldId: f.Pause } })],
      ['Gros contrat (1 = oui)', () => ({ kind: 'conditional', condition: F.cmp('GTE', amount, F.num(200000, 'FCFA')), then: F.num(1), else: F.num(0) })],
      ['Remise et pas de petit montant (1 = oui)', () => ({ kind: 'conditional', condition: { kind: 'logical', operator: 'AND', args: [F.cmp('GT', F.field(f.Remise), F.num(0)), { kind: 'not', arg: F.cmp('LT', amount, F.num(100000, 'FCFA')) }] }, then: F.num(1), else: F.num(0) })],
      ['Pénalité ou zéro', () => ({ kind: 'coalesce', args: [F.field(f.Pénalité), F.num(0, 'FCFA')] })],
      ['Plafonné à 300 000', () => ({ kind: 'min', args: [amount, F.num(300000, 'FCFA')] })],
      ['Au moins 50 000', () => ({ kind: 'max', args: [amount, F.num(50000, 'FCFA')] })],
      ['Écart à 250 000 (valeur absolue)', () => ({ kind: 'abs', value: F.op('SUBTRACT', amount, F.num(250000, 'FCFA')) })],
      ['Milliers (arrondi inférieur)', () => ({ kind: 'floor', value: F.op('DIVIDE', amount, F.num(1000)) })],
      ['Milliers (arrondi supérieur)', () => ({ kind: 'ceil', value: F.op('DIVIDE', amount, F.num(1000)) })],
      ['Reste après billets de 10 000', () => ({ kind: 'modulo', left: amount, right: F.num(10000, 'FCFA') })],
      ['Client en majuscules', () => ({ kind: 'upper', text: F.text(f.Client) })],
      ['Client en minuscules', () => ({ kind: 'lower', text: F.text(f.Client) })],
      ['Client (Nom Propre)', () => ({ kind: 'proper', text: F.text(f.Client) })],
      ['Code client (3 lettres)', () => ({ kind: 'upper', text: { kind: 'substring', text: F.text(f.Client), start: F.num(1), length: F.num(3) } })],
      ['Longueur du nom du client', () => ({ kind: 'textLength', text: F.text(f.Client) })],
      ['Note ou « aucune »', () => ({ kind: 'coalesceText', args: [F.text(f['Note interne']), F.lit('aucune')] })],
      ['Libellé complet', () => ({ kind: 'concat', args: [{ kind: 'proper', text: F.text(f.Client) }, F.lit(' — '), { kind: 'formatText', value: amount, pattern: '#,##0', locale: 'fr' }, F.lit(' '), { kind: 'unitOf', value: amount }] })],
      ['Date de fin en toutes lettres', () => ({ kind: 'formatText', value: F.date(f.Fin), pattern: 'DD/MM/YYYY', locale: 'fr' })],
    ], r);
  });

  // 2. Laboratory: measures with status, uncertainty and instrument; several stations.
  await seed('Calculs · Laboratoire (mesures)', async (r) => {
    const collection = await createCollection('Calculs · Laboratoire (mesures)', [{ name: 'Relevé d’eau', color: '#F1F5FA', fields: [
      { name: 'Titre', kind: 'TITLE' }, { name: 'Prélevé le', kind: 'DATETIME' }, { name: 'Station', kind: 'SELECT', options: ['Lagune', 'Rivière', 'Puits'] },
      { name: 'Température', kind: 'MEASURE', unit: '°C' }, { name: 'Conductivité', kind: 'MEASURE', unit: 'µS/cm' }, { name: 'pH', kind: 'NUMBER' },
      { name: 'Turbidité', kind: 'NUMBER', unit: 'NTU' }, { name: 'Oxygène dissous', kind: 'NUMBER', unit: 'mg/L' },
    ] }]);
    const format = collection.formats[0];
    const base = { Lagune: [29, 1450, 7.6, 18], Rivière: [26.5, 380, 7.1, 35], Puits: [27.5, 620, 6.8, 2] };
    for (let offset = -120; offset <= 0; offset += 2) {
      for (const station of ['Lagune', 'Rivière', 'Puits']) {
        if (chance(0.2)) continue;
        const [temperature, conductivity, ph, turbidity] = base[station];
        const estimated = chance(0.1);
        const season = Math.sin((offset / 365) * 2 * Math.PI) * 1.5;
        await addEntry(collection, format, {
          Titre: `${station} · ${iso(offset)}`, 'Prélevé le': isoTime(offset, 8, pick([0, 15, 30, 45])), Station: station,
          Température: { value: fixed(temperature + season + between(-0.8, 0.8), 1), measureValue: estimated ? { status: 'ESTIMATED', uncertainty: '1.0', instrument: 'Interpolation' } : { status: 'MEASURED', uncertainty: '0.2', instrument: 'Sonde PT100' } },
          Conductivité: { value: Math.round(conductivity * between(0.9, 1.1)), measureValue: { status: 'MEASURED', uncertainty: '15', instrument: 'Conductimètre C-20' } },
          pH: fixed(ph + between(-0.3, 0.3), 2), Turbidité: fixed(turbidity * between(0.6, 1.5), 1), 'Oxygène dissous': fixed(between(4.5, 8.5), 2),
        });
        r.entries++;
      }
    }
    await addView(collection, format, 'Relevés', ['Titre', 'Station', 'Température', 'pH', 'Conductivité']);
    const f = ids(format);
    await addFormulas(collection, format, [
      // Custom units (NTU, mg/L, µS/cm) are kept for analyses but cannot enter formulas.
      ['pH arrondi au dixième', () => ({ kind: 'round', digits: 1, mode: 'HALF_UP', value: F.field(f.pH) })],
      ['Écart au pH neutre', () => ({ kind: 'abs', value: F.op('SUBTRACT', F.field(f.pH), F.num(7)) })],
      ['Eau acide (1 = oui)', () => ({ kind: 'conditional', condition: F.cmp('LT', F.field(f.pH), F.num('6.5')), then: F.num(1), else: F.num(0) })],
    ], r);
    r.notes.push('Analyses : moyenne, écart type, percentiles et tableau croisé Station × Mois sur la température.');
  });

  // 3. Forecasts: 24 months of turnover with trend and seasonality, and daily visitors.
  await seed('Calculs · Prévisions', async (r) => {
    const collection = await createCollection('Calculs · Prévisions', [
      { name: 'Bilan mensuel', color: '#EDF9F3', fields: [
        { name: 'Titre', kind: 'TITLE' }, { name: 'Mois', kind: 'DATE' }, { name: 'Chiffre d’affaires', kind: 'NUMBER', unit: 'FCFA' },
        { name: 'Abonnés', kind: 'NUMBER' }, { name: 'Satisfaction', kind: 'NUMBER', unit: '%' },
      ] },
      { name: 'Fréquentation', color: '#FFF5EB', fields: [
        { name: 'Titre', kind: 'TITLE' }, { name: 'Date', kind: 'DATE' }, { name: 'Visiteurs', kind: 'NUMBER' }, { name: 'Jour', kind: 'SELECT', options: ['Semaine', 'Week-end'] },
      ] },
    ]);
    const monthly = formatOf(collection, 'Bilan mensuel');
    let subscribers = 420;
    for (let back = 24; back >= 1; back--) {
      const index = 24 - back;
      const month = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - back, 15)).getUTCMonth();
      const seasonal = month === 11 ? 1.35 : month === 7 ? 0.8 : 1;
      subscribers += Math.round(between(8, 30));
      await addEntry(collection, monthly, { Titre: `Bilan ${monthDay(back).slice(0, 7)}`, Mois: monthDay(back), 'Chiffre d’affaires': round((2400000 + index * 65000) * seasonal * between(0.93, 1.07), 1000), Abonnés: subscribers, Satisfaction: fixed(between(78, 93), 1) });
      r.entries++;
    }
    const visits = formatOf(collection, 'Fréquentation');
    for (let offset = -120; offset <= 0; offset++) {
      const weekend = [0, 6].includes(dateAt(offset).getUTCDay());
      await addEntry(collection, visits, { Titre: `Visiteurs · ${iso(offset)}`, Date: iso(offset), Visiteurs: Math.round((weekend ? 340 : 190) + (offset + 120) * 0.6 + between(-35, 35)), Jour: weekend ? 'Week-end' : 'Semaine' });
      r.entries++;
    }
    await addView(collection, monthly, 'Bilans mensuels', ['Titre', 'Mois', 'Chiffre d’affaires', 'Abonnés']);
    // Proves the forecast works on this data before handing it over.
    const m = ids(monthly);
    const forecast = (await gql('query($c:String!,$input:ForecastInput!) { forecastCollection(collectionId:$c,input:$input) { forecast { date estimate } } }', { c: collection.id, input: { formatId: monthly.id, fieldId: m['Chiffre d’affaires'], dateFieldId: m.Mois, frequency: 'MONTH', method: 'LINEAR', measureKind: 'EVENT', horizon: 3, holdout: 2 } })).forecastCollection;
    r.notes.push(`Prévision linéaire vérifiée : ${forecast.forecast.map((item) => `${item.date} ≈ ${Math.round(Number(item.estimate)).toLocaleString('fr-FR')} FCFA`).join(', ')}`);
  });

  // 4. Geography and territories: a 3-level classification, positions and delivery zones.
  await seed('Calculs · Géographie et territoires', async (r) => {
    let collection = await createCollection('Calculs · Géographie et territoires', [{ name: 'Zone de livraison', color: '#FBF7E9', fields: [{ name: 'Nom', kind: 'TITLE' }, { name: 'Zone', kind: 'ZONE' }, { name: 'Tarif', kind: 'NUMBER', unit: 'FCFA' }] }]);
    const territories = [
      ['CI', 'Côte d’Ivoire', 'Côte d’Ivoire'], ['CI-AB', 'Abidjan', 'Abidjan', 'CI'], ['CI-YM', 'Yamoussoukro', 'Yamoussoukro', 'CI'], ['CI-BK', 'Bouaké', 'Bouaké', 'CI'],
      ['CI-AB-COC', 'Cocody', 'Cocody', 'CI-AB'], ['CI-AB-PLA', 'Plateau', 'Plateau', 'CI-AB'], ['CI-AB-YOP', 'Yopougon', 'Yopougon', 'CI-AB'], ['CI-AB-ABO', 'Abobo', 'Abobo', 'CI-AB'],
      ['SN', 'Senegal', 'Sénégal'], ['SN-DK', 'Dakar', 'Dakar', 'SN'], ['SN-DK-PLA', 'Dakar Plateau', 'Dakar Plateau', 'SN-DK'], ['SN-DK-PIK', 'Pikine', 'Pikine', 'SN-DK'],
    ].map(([code, labelEn, labelFr, parentCode]) => ({ code, labelEn, labelFr, ...(parentCode ? { parentCode } : {}) }));
    const list = (await gql('mutation($c:String!,$n:String!,$codes:[ClassificationCodeInput!]!) { saveClassification(collectionId:$c,name:$n,codes:$codes) { codeLists { id name } } }', { c: collection.id, n: 'Territoires', codes: territories })).saveClassification.codeLists.find((item) => item.name === 'Territoires');
    collection = (await gql(`mutation($c:String!,$input:CollectionFormatInput!) { addCollectionFormat(collectionId:$c,input:$input) { ${SHAPE} } }`, { c: collection.id, input: { name: 'Visite commerciale', color: '#EAF8FA', fields: [
      { name: 'Titre', kind: 'TITLE' }, { name: 'Date', kind: 'DATE' }, { name: 'Position', kind: 'POSITION' }, { name: 'Commune', kind: 'CODE', codeListId: list.id },
      { name: 'Ventes', kind: 'NUMBER', unit: 'FCFA' }, { name: 'Type de client', kind: 'SELECT', options: ['Boutique', 'Supermarché', 'Kiosque'] },
    ] } })).addCollectionFormat;
    const zones = formatOf(collection, 'Zone de livraison');
    const places = { 'CI-AB-COC': [5.3599, -3.987], 'CI-AB-PLA': [5.3237, -4.0237], 'CI-AB-YOP': [5.3456, -4.089], 'CI-AB-ABO': [5.418, -4.02], 'CI-YM': [6.8276, -5.2893], 'CI-BK': [7.6906, -5.0303], 'SN-DK-PLA': [14.6697, -17.4381], 'SN-DK-PIK': [14.7547, -17.39] };
    for (const [name, value, tarif] of [
      ['Cocody (rayon 3 km)', { type: 'Circle', center: [-3.987, 5.3599], radiusMeters: 3000 }, 1000],
      ['Plateau (rayon 2 km)', { type: 'Circle', center: [-4.0237, 5.3237], radiusMeters: 2000 }, 1500],
      ['Grand Abidjan (polygone)', { type: 'Polygon', coordinates: [[-4.15, 5.25], [-3.9, 5.25], [-3.9, 5.48], [-4.15, 5.48]] }, 2500],
      ['Dakar (rayon 8 km)', { type: 'Circle', center: [-17.43, 14.7], radiusMeters: 8000 }, 3000],
    ]) { await addEntry(collection, zones, { Nom: name, Zone: JSON.stringify(value), Tarif: tarif }); r.entries++; }
    const visits = formatOf(collection, 'Visite commerciale');
    for (let offset = -150; offset <= 0; offset++) {
      if (!chance(0.7)) continue;
      const commune = pick(Object.keys(places));
      const [lat, lon] = places[commune];
      await addEntry(collection, visits, { Titre: `Visite ${commune} · ${iso(offset)}${chance(0.5) ? ' (matin)' : ''} #${r.entries}`, Date: iso(offset), Position: JSON.stringify({ latitude: fixed(lat + between(-0.02, 0.02), 5), longitude: fixed(lon + between(-0.02, 0.02), 5), accuracy: Math.round(between(5, 30)) }), Commune: commune, Ventes: round(between(15000, 220000), 500), 'Type de client': pick(['Boutique', 'Boutique', 'Supermarché', 'Kiosque']) });
      r.entries++;
    }
    await addView(collection, visits, 'Visites', ['Titre', 'Date', 'Commune', 'Ventes']);
    r.notes.push('Regrouper par Commune avec « Niveau de regroupement » : pays, ville, commune. Carte, distances et comptage par zone.');
  });

  // 5. Stock: the shop template's products and explicit movements over two months.
  await seed('Calculs · Stock magasin', async (r) => {
    const collection = (await gql(`mutation($t:String!,$n:String!,$l:String) { createCollectionFromTemplate(templateId:$t,name:$n,language:$l) { ${SHAPE} } }`, { t: 'shop', n: 'Calculs · Stock magasin', l: 'fr' })).createCollectionFromTemplate;
    const productFormat = collection.formats.find((item) => item.objectModel) ?? collection.formats[0];
    const titleId = productFormat.fields.find((item) => item.kind === 'TITLE')?.id ?? productFormat.fields[0].id;
    const products = {};
    for (const name of ['Riz parfumé 25 kg', 'Huile de palme 5 L', 'Lait concentré (carton)', 'Savon de Marseille']) {
      products[name] = (await gql('mutation($id:String!,$input:SaveEntryInput!) { createEntry(collectionId:$id,input:$input) { id } }', { id: collection.id, input: { formatId: productFormat.id, values: [{ fieldId: titleId, value: name }] } })).createEntry.id;
      r.entries++;
    }
    const levels = {};
    const move = async (kind, product, quantity, from, to, offset, extra = {}) => {
      const result = (await gql('mutation($c:String!,$input:StockMovementInput!) { commitStockMovement(collectionId:$c,input:$input) { id } }', { c: collection.id, input: { kind, productId: products[product], quantity: String(quantity), fromLocation: from, toLocation: to, occurredAt: isoTime(offset, 10), idempotencyKey: `features-seed:${randomUUID()}`, ...extra } })).commitStockMovement;
      if (from) levels[`${product}|${from}`] -= quantity;
      if (to) levels[`${product}|${to}`] = (levels[`${product}|${to}`] ?? 0) + quantity;
      return result;
    };
    let lastSale;
    for (let offset = -60; offset <= 0; offset++) {
      for (const product of Object.keys(products)) {
        if (offset % 14 === -60 % 14) await move('IN', product, Math.round(between(40, 80)), '', 'Réserve', offset);
        const reserve = levels[`${product}|Réserve`] ?? 0, shelf = levels[`${product}|Rayon`] ?? 0;
        if (shelf < 10 && reserve > 0) await move('TRANSFER', product, Math.min(reserve, 20), 'Réserve', 'Rayon', offset);
        const available = levels[`${product}|Rayon`] ?? 0;
        const sold = Math.min(available, Math.round(between(0, 6)));
        if (sold > 0) lastSale = { product, quantity: sold, id: (await move('OUT', product, sold, 'Rayon', '', offset)).id };
      }
    }
    if (lastSale) await move('RETURN', lastSale.product, 1, '', 'Rayon', 0, { reversalOf: lastSale.id });
    const positions = (await gql('query($c:String!) { stockPositions(collectionId:$c) { productId location quantity } }', { c: collection.id })).stockPositions;
    const productNames = Object.fromEntries(Object.entries(products).map(([name, id]) => [id, name]));
    r.notes.push(`Stock actuel : ${positions.map((item) => `${productNames[item.productId] ?? '?'} @ ${item.location} = ${item.quantity}`).join(' ; ')}`);
  });

  // 6. Workshop: objects, multi-object references (sum/avg/min/max/count) and components.
  await seed('Calculs · Atelier (objets et composants)', async (r) => {
    let collection = await createCollection('Calculs · Atelier (objets et composants)', [{ name: 'Pièce', color: '#FFF0F4', objectModel: true, fields: [
      { name: 'Nom', kind: 'TITLE' }, { name: 'Coût', kind: 'NUMBER', unit: 'FCFA' }, { name: 'Masse', kind: 'NUMBER', unit: 'kg' }, { name: 'Fournisseur', kind: 'TEXT' },
    ] }]);
    const part = formatOf(collection, 'Pièce');
    const parts = {};
    for (const [name, cost, mass, supplier] of [
      ['Vélo de ville', 15000, 0, 'Atelier'], ['Cadre acier', 45000, 4.2, 'Métal Plus'], ['Roue complète', 3000, 0, 'Atelier'], ['Jante 28 pouces', 7500, 0.6, 'Roues & Co'],
      ['Rayon inox', 150, 0.01, 'Roues & Co'], ['Pneu 700x35', 6500, 0.45, 'Pneus Afrique'], ['Selle confort', 8000, 0.4, 'Confort Assise'], ['Chaîne', 5500, 0.3, 'Métal Plus'], ['Guidon', 6000, 0.5, 'Métal Plus'],
    ]) { parts[name] = (await addEntry(collection, part, { Nom: name, Coût: cost, Masse: mass, Fournisseur: supplier })).id; r.entries++; }
    const relation = (from, to, quantity) => gql('mutation($c:String!,$f:String!,$t:String!,$k:RelationKind!,$q:String,$u:String) { createCollectionRelation(collectionId:$c,fromEntryId:$f,toEntryId:$t,kind:$k,quantity:$q,unit:$u) { id } }', { c: collection.id, f: parts[from], t: parts[to], k: 'COMPONENT', q: String(quantity), u: 'item' });
    for (const [from, to, quantity] of [['Vélo de ville', 'Cadre acier', 1], ['Vélo de ville', 'Roue complète', 2], ['Vélo de ville', 'Selle confort', 1], ['Vélo de ville', 'Chaîne', 1], ['Vélo de ville', 'Guidon', 1], ['Roue complète', 'Jante 28 pouces', 1], ['Roue complète', 'Rayon inox', 32], ['Roue complète', 'Pneu 700x35', 1]]) await relation(from, to, quantity);
    const total = (await gql('query($c:String!,$root:String!,$k:RelationKind!,$f:String!) { collectionRelationTotal(collectionId:$c,rootId:$root,kind:$k,fieldName:$f) { value unit nodes } }', { c: collection.id, root: parts['Vélo de ville'], k: 'COMPONENT', f: 'Coût' })).collectionRelationTotal;
    r.notes.push(`Coût complet du vélo (nomenclature) : ${total.value} ${total.unit ?? ''} sur ${total.nodes} pièces`);
    collection = (await gql(`mutation($c:String!,$input:CollectionFormatInput!) { addCollectionFormat(collectionId:$c,input:$input) { ${SHAPE} } }`, { c: collection.id, input: { name: 'Commande de pièces', color: '#EAF8FA', fields: [
      { name: 'Titre', kind: 'TITLE' }, { name: 'Date', kind: 'DATE' }, { name: 'Pièces', kind: 'OBJECT_REF', targetObjectFormatId: part.id, multiple: true, referenceMode: 'CURRENT', variableName: 'pieces' },
      { name: 'Pièce principale', kind: 'OBJECT_REF', targetObjectFormatId: part.id, referenceMode: 'SNAPSHOT', variableName: 'principale' }, { name: 'Quantité', kind: 'NUMBER' },
    ] } })).addCollectionFormat;
    const order = formatOf(collection, 'Commande de pièces');
    const names = Object.keys(parts).slice(1);
    for (let index = 0; index < 30; index++) {
      const chosen = [...new Set(Array.from({ length: Math.ceil(between(1, 4)) }, () => pick(names)))];
      await addEntry(collection, order, { Titre: `Commande C-${String(index + 1).padStart(3, '0')}`, Date: iso(-Math.round(between(0, 90))), Pièces: JSON.stringify(chosen.map((name) => parts[name])), 'Pièce principale': JSON.stringify([parts[chosen[0]]]), Quantité: Math.ceil(between(1, 10)) });
      r.entries++;
    }
    await addView(collection, order, 'Commandes', ['Titre', 'Date', 'Pièces', 'Quantité']);
    const o = ids(order), p = ids(part);
    await addFormulas(collection, order, [
      ['Coût des pièces (somme)', () => ({ kind: 'sumRelated', referenceFieldId: o.Pièces, propertyFieldId: p.Coût })],
      ['Coût moyen d’une pièce', () => ({ kind: 'avgRelated', referenceFieldId: o.Pièces, propertyFieldId: p.Coût })],
      ['Pièce la moins chère', () => ({ kind: 'minRelated', referenceFieldId: o.Pièces, propertyFieldId: p.Coût })],
      ['Pièce la plus lourde', () => ({ kind: 'maxRelated', referenceFieldId: o.Pièces, propertyFieldId: p.Masse })],
      ['Nombre de pièces', () => ({ kind: 'countRelated', referenceFieldId: o.Pièces })],
      ['Montant de la commande', () => F.op('MULTIPLY', F.field(o.Quantité), { kind: 'sumRelated', referenceFieldId: o.Pièces, propertyFieldId: p.Coût })],
      ['Coût de la pièce principale (propriété)', () => ({ kind: 'property', referenceFieldId: o['Pièce principale'], propertyFieldId: p.Coût })],
      ['Fournisseur principal', () => ({ kind: 'textProperty', referenceFieldId: o['Pièce principale'], propertyFieldId: p.Fournisseur })],
    ], r);
  });

  // 7. Workflows: tasks and approval requests in different states.
  await seed('Calculs · Flux de travail', async (r) => {
    let collection = await createCollection('Calculs · Flux de travail', [{ name: 'Note', color: '#EEF5FF', fields: [{ name: 'Titre', kind: 'TITLE' }, { name: 'Texte', kind: 'LONG_TEXT' }] }]);
    collection = (await gql(`mutation($id:String!) { addCollectionWorkflowTemplate(collectionId:$id,templateId:"TASK",color:"#FFF5EB",language:"fr") { ${SHAPE} } }`, { id: collection.id })).addCollectionWorkflowTemplate;
    collection = (await gql(`mutation($id:String!) { addCollectionWorkflowTemplate(collectionId:$id,templateId:"APPROVAL",color:"#EDF9F3",language:"fr") { ${SHAPE} } }`, { id: collection.id })).addCollectionWorkflowTemplate;
    const transition = async (entry, to) => (await gql('mutation($id:String!,$to:String!,$at:String!) { transitionWorkflowEntry(entryId:$id,to:$to,expectedUpdatedAt:$at) { id updatedAt } }', { id: entry.id, to, at: entry.updatedAt })).transitionWorkflowEntry;
    const seedFlow = async (format, titles, paths) => {
      const title = format.fields.find((item) => item.kind === 'TITLE');
      for (const [index, name] of titles.entries()) {
        let entry = (await gql('mutation($id:String!,$input:SaveEntryInput!) { createEntry(collectionId:$id,input:$input) { id updatedAt } }', { id: collection.id, input: { formatId: format.id, values: [{ fieldId: title.id, value: name }] } })).createEntry;
        r.entries++;
        for (const to of paths[index % paths.length]) entry = await transition(entry, to);
      }
    };
    const task = collection.formats.find((item) => item.workflow && item.name === 'Tâche');
    const approval = collection.formats.find((item) => item.workflow && item.name === 'Demande à valider');
    assert.ok(task && approval, 'Workflow templates missing');
    await seedFlow(task, ['Préparer le budget', 'Appeler le fournisseur', 'Mettre à jour le site', 'Ranger la réserve', 'Former le stagiaire', 'Inventaire de fin de mois', 'Relancer les impayés', 'Commander les cartons'], [[], ['En cours'], ['En cours', 'Fait'], ['En cours', 'Fait']]);
    await seedFlow(approval, ['Achat d’un ordinateur', 'Congé du 2 au 6 décembre', 'Remboursement taxi', 'Nouvelle imprimante', 'Formation Excel', 'Prime de fin d’année'], [[], ['En examen'], ['En examen', 'Validée'], ['En examen', 'Refusée']]);
    r.notes.push('Compter par état (Regrouper : Catégorie sur le champ d’état) ; voir les transitions et le tableau de bord du flux.');
  });

  // 8. Cash ledger: append-only writings, a correction and a verifiable balance.
  await seed('Calculs · Caisse (registre)', async (r) => {
    const collection = await createCollection('Calculs · Caisse (registre)', [{ name: 'Écriture de caisse', color: '#F8F0FA', fields: [
      { name: 'Libellé', kind: 'TITLE' }, { name: 'Date', kind: 'DATE' }, { name: 'Montant', kind: 'NUMBER', unit: 'FCFA' }, { name: 'Sens', kind: 'SELECT', options: ['Entrée', 'Sortie'] }, { name: 'Client', kind: 'TEXT' },
    ] }]);
    const format = collection.formats[0];
    await gql('mutation($c:String!,$f:String!) { enableLedger(collectionId:$c,formatId:$f) { id } }', { c: collection.id, f: format.id });
    let mistake;
    for (let offset = -45; offset <= 0; offset++) {
      if (!chance(0.8)) continue;
      const incoming = chance(0.7);
      const amount = round(between(2000, 60000), 100) * (incoming ? 1 : -1);
      const entry = await addEntry(collection, format, { Libellé: `${incoming ? 'Vente' : 'Achat'} du ${iso(offset)}`, Date: iso(offset), Montant: amount, Sens: incoming ? 'Entrée' : 'Sortie', Client: incoming ? pick(['Comptoir', 'M. Kouassi', 'Mme Bamba']) : 'Fournisseur' });
      if (offset === -20 || (!mistake && offset > -20)) mistake = mistake ?? { entry, amount };
      r.entries++;
    }
    if (mistake) {
      // A ledger never rewrites a line: the error is cancelled by a counter-writing, then entered again correctly.
      const f = ids(format);
      await gql('mutation($o:String!,$input:SaveEntryInput!) { correctLedgerEntry(originalId:$o,input:$input) { id } }', { o: mistake.entry.id, input: { formatId: format.id, values: [{ fieldId: f.Libellé, value: 'Annulation : erreur de saisie' }, { fieldId: f.Date, value: iso(0) }, { fieldId: f.Montant, value: String(-mistake.amount) }, { fieldId: f.Sens, value: -mistake.amount >= 0 ? 'Entrée' : 'Sortie' }] } });
      const corrected = mistake.amount + 1000;
      await addEntry(collection, format, { Libellé: 'Saisie corrigée', Date: iso(0), Montant: corrected, Sens: corrected >= 0 ? 'Entrée' : 'Sortie', Client: 'Comptoir' });
      r.entries += 2;
    }
    const balance = (await gql('query($c:String!,$f:String!,$field:String!) { ledgerBalance(collectionId:$c,formatId:$f,fieldId:$field) }', { c: collection.id, f: format.id, field: ids(format).Montant })).ledgerBalance;
    r.notes.push(`Solde du registre : ${balance} FCFA ; une écriture corrigée (l’originale reste visible).`);
  });

  // 9. Survey: sensitive fields and a minimum group size for aggregates.
  await seed('Calculs · Enquête (données sensibles)', async (r) => {
    let collection = await createCollection('Calculs · Enquête (données sensibles)', [{ name: 'Réponse', color: '#F1F8ED', fields: [
      { name: 'Titre', kind: 'TITLE' }, { name: 'Date', kind: 'DATE' }, { name: 'Âge', kind: 'NUMBER' }, { name: 'Quartier', kind: 'SELECT', options: ['Cocody', 'Yopougon', 'Plateau', 'Marcory', 'Treichville'] },
      { name: 'Revenu mensuel', kind: 'NUMBER', unit: 'FCFA' }, { name: 'Satisfaction (1 à 5)', kind: 'NUMBER' }, { name: 'Téléphone', kind: 'TEXT' },
    ] }]);
    const format = collection.formats[0];
    for (let index = 0; index < 60; index++) {
      // Treichville gets only 3 answers, so its averages stay hidden below the minimum group size.
      const district = index < 3 ? 'Treichville' : pick(['Cocody', 'Yopougon', 'Plateau', 'Marcory']);
      await addEntry(collection, format, { Titre: `Réponse ${String(index + 1).padStart(3, '0')}`, Date: iso(-Math.round(between(0, 40))), Âge: Math.round(between(18, 70)), Quartier: district, 'Revenu mensuel': round(between(60000, 900000), 5000), 'Satisfaction (1 à 5)': Math.ceil(between(1, 5)), Téléphone: `+225 07 ${Math.round(between(10, 99))} ${Math.round(between(10, 99))} ${Math.round(between(10, 99))} ${Math.round(between(10, 99))}` });
      r.entries++;
    }
    const f = ids(format);
    for (const [fieldName, level] of [['Revenu mensuel', 'SENSITIVE'], ['Téléphone', 'PERSONAL']]) {
      const version = collection.formats[0].version;
      collection = (await gql(`mutation($c:String!,$f:String!,$field:String!,$l:SensitivityLevel!,$v:Int!) { setFieldSensitivity(collectionId:$c,formatId:$f,fieldId:$field,level:$l,expectedVersion:$v) { ${SHAPE} } }`, { c: collection.id, f: format.id, field: f[fieldName], l: level, v: version })).setFieldSensitivity;
    }
    await gql('mutation($c:String!,$m:Int!) { setMinimumAggregateSize(collectionId:$c,minimum:$m) { id } }', { c: collection.id, m: 5 });
    await addView(collection, format, 'Réponses', ['Titre', 'Quartier', 'Âge', 'Satisfaction (1 à 5)']);
    r.notes.push('Revenu = sensible, Téléphone = personnel ; groupes de moins de 5 réponses masqués (Treichville).');
  });

  // 10. Rates and meters: attendance rates per class and an electricity meter with a reset.
  await seed('Calculs · Taux et compteurs', async (r) => {
    const collection = await createCollection('Calculs · Taux et compteurs', [
      { name: 'Appel en classe', color: '#F4F0FF', fields: [
        { name: 'Titre', kind: 'TITLE' }, { name: 'Date', kind: 'DATE' }, { name: 'Classe', kind: 'SELECT', options: ['6e A', '5e B', '4e C', '3e A'] },
        { name: 'Inscrits', kind: 'NUMBER' }, { name: 'Présents', kind: 'NUMBER' }, { name: 'Retards', kind: 'NUMBER' }, { name: 'Moyenne de la classe', kind: 'NUMBER' },
      ] },
      { name: 'Relevé de compteur', color: '#FFF7F1', fields: [
        { name: 'Titre', kind: 'TITLE' }, { name: 'Date', kind: 'DATE' }, { name: 'Index', kind: 'NUMBER', unit: 'kWh' }, { name: 'Compteur remplacé', kind: 'BOOLEAN' },
      ] },
    ]);
    const attendance = formatOf(collection, 'Appel en classe');
    const sizes = { '6e A': 48, '5e B': 45, '4e C': 52, '3e A': 40 };
    for (let offset = -60; offset <= 0; offset++) {
      if ([0, 6].includes(dateAt(offset).getUTCDay())) continue;
      for (const [group, size] of Object.entries(sizes)) {
        const present = size - Math.round(between(0, 7));
        await addEntry(collection, attendance, { Titre: `${group} · ${iso(offset)}`, Date: iso(offset), Classe: group, Inscrits: size, Présents: present, Retards: Math.round(between(0, 5)), 'Moyenne de la classe': fixed(between(9, 14.5), 2) });
        r.entries++;
      }
    }
    const meter = formatOf(collection, 'Relevé de compteur');
    let index = 18450;
    for (let offset = -120; offset <= 0; offset += 7) {
      const replaced = offset === -57;
      index = replaced ? Math.round(between(5, 40)) : index + Math.round(between(55, 95));
      await addEntry(collection, meter, { Titre: `Relevé ${iso(offset)}`, Date: iso(offset), Index: index, 'Compteur remplacé': replaced ? 'true' : 'false' });
      r.entries++;
    }
    await addView(collection, attendance, 'Appels', ['Titre', 'Classe', 'Inscrits', 'Présents']);
    const a = ids(attendance);
    await addFormulas(collection, attendance, [
      ['Taux de présence', () => ({ kind: 'round', digits: 1, mode: 'HALF_EVEN', value: F.op('MULTIPLY', F.op('DIVIDE', F.field(a.Présents), F.field(a.Inscrits)), F.num(100)) })],
      ['Absents', () => F.op('SUBTRACT', F.field(a.Inscrits), F.field(a.Présents))],
    ], r);
    r.notes.push('Taux pour N avec dénominateur Inscrits ; moyenne pondérée par Inscrits ; écart successif du compteur avec remise à zéro.');
  });

  console.log(JSON.stringify({ account: users[0].email.replace(/^(.).*@/, '$1***@'), report }, null, 2));
} finally {
  await mongoose.disconnect();
}
