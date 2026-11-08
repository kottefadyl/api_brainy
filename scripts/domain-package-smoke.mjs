// T45 smoke: domain packages (pilots, export without user data, preview, install, update, detach, signature, refusals).
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';

const url = process.env.API_URL || `http://localhost:${process.env.PORT ?? 3000}/graphql`;

async function gql(query, variables, token) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) });
  const body = await response.json();
  if (body.errors?.length) throw new Error(body.errors[0].message);
  return body.data;
}
async function rejects(promise, pattern, label) {
  try { await promise; } catch (error) { assert.match(error.message, pattern, label); return; }
  assert.fail(`${label}: expected a refusal`);
}
async function account(name) {
  const data = await gql('mutation($input:RegisterInput!) { register(input:$input) { token } }', { input: { name, email: `pkg-${randomUUID()}@example.test`, password: 'temporary-test-password' } });
  return data.register.token;
}

const PREVIEW = 'query($json:String!,$c:String,$l:String) { previewDomainPackage(packageJson:$json, collectionId:$c, language:$l) { packageId version name mode installedVersion signatureStatus keyFingerprint dataFormats addedFields units codeLists views formulas stockRules exampleObjects dependencies adjustments conflicts allowed } }';
const INSTALL = 'mutation($json:String!,$c:String,$n:String,$l:String) { installDomainPackage(packageJson:$json, collectionId:$c, collectionName:$n, language:$l) { collectionId installId mode version addedDataFormats addedFields exampleObjects } }';
const COLLECTIONS = '{ collectionsList { id name formats { id name color objectModel fields { id name kind unit codeListId targetObjectFormatId options } } units { id symbol } codeLists { id name codes { code labelFr parentCode } } savedViews { id name } formulas { id name } stockRules { id name kind } } }';
const ENTRIES = 'query($id:String!) { collectionEntries(collectionId:$id) { id formatId values { fieldId value } } }';
const CREATE_ENTRY = 'mutation($id:String!,$input:SaveEntryInput!) { createEntry(collectionId:$id, input:$input) { id } }';
const INSTALLS = 'query($id:String!) { domainPackageInstalls(collectionId:$id) { id packageId version name author license signatureStatus dataFormatCount } }';
const EXPORT = 'query($id:String!,$input:DomainPackageExportInput!,$l:String) { exportDomainPackage(collectionId:$id, input:$input, language:$l) { packageJson fileName warnings dataFormats } }';

const collection = async (token, id) => (await gql(COLLECTIONS, {}, token)).collectionsList.find((item) => item.id === id);
const field = (format, name) => format.fields.find((item) => item.name === name);

try {
  const alice = await account('Package Author');
  const bob = await account('Package User');
  const pilots = (await gql('query { domainPackagePilots(language:"fr") { id version name description packageJson } }')).domainPackagePilots;
  assert.deepEqual(pilots.map((item) => item.id), ['brainy.notes-links', 'brainy.expenses', 'brainy.simple-sales', 'brainy.local-weather', 'brainy.shop', 'brainy.measurements']);
  const pilot = (id) => pilots.find((item) => item.id === id).packageJson;

  // 1. Reference scenarios of the six pilots, each installed with a preview into a new collection.
  const installed = {};
  for (const item of pilots) {
    const preview = (await gql(PREVIEW, { json: item.packageJson, l: 'fr' }, bob)).previewDomainPackage;
    assert.equal(preview.mode, 'NEW_COLLECTION');
    assert.equal(preview.allowed, true, `${item.id}: ${preview.conflicts.join(', ')}`);
    assert.equal(preview.signatureStatus, 'NONE');
    const result = (await gql(INSTALL, { json: item.packageJson, l: 'fr' }, bob)).installDomainPackage;
    assert.equal(result.addedDataFormats, preview.dataFormats.length);
    installed[item.id] = await collection(bob, result.collectionId);
    assert.equal(installed[item.id].name, item.name, 'collection takes the package name');
    assert.deepEqual(installed[item.id].formats.map((format) => format.name), preview.dataFormats);
  }
  const notes = installed['brainy.notes-links'];
  await gql(CREATE_ENTRY, { id: notes.id, input: { formatId: notes.formats[0].id, values: [{ fieldId: field(notes.formats[0], 'Titre').id, value: 'Une note à un seul champ' }] } }, bob);
  assert.equal(notes.savedViews[0].name, 'Liens conservés');

  const expenses = installed['brainy.expenses'];
  const expense = expenses.formats[0];
  assert.equal(expenses.codeLists[0].codes.find((code) => code.code === 'FOOD.GROCERIES').parentCode, 'FOOD');
  assert.equal(field(expense, 'Catégorie').codeListId, expenses.codeLists[0].id);
  await gql(CREATE_ENTRY, { id: expenses.id, input: { formatId: expense.id, values: [{ fieldId: field(expense, 'Titre').id, value: 'Marché' }, { fieldId: field(expense, 'Montant').id, value: '12.50' }, { fieldId: field(expense, 'Catégorie').id, value: 'FOOD.GROCERIES' }] } }, bob);

  const sales = installed['brainy.simple-sales'];
  const [product, sale] = sales.formats;
  assert.equal(product.objectModel, true);
  assert.equal(field(sale, 'Produit').targetObjectFormatId, product.id);
  const exampleProduct = (await gql(ENTRIES, { id: sales.id }, bob)).collectionEntries.find((entry) => entry.formatId === product.id);
  assert.ok(exampleProduct, 'example object installed');
  const saleEntry = (await gql(CREATE_ENTRY, { id: sales.id, input: { formatId: sale.id, values: [{ fieldId: field(sale, 'Titre').id, value: 'Vente 1' }, { fieldId: field(sale, 'Quantité').id, value: '3' }, { fieldId: field(sale, 'Prix unitaire').id, value: '2.5' }] } }, bob)).createEntry;
  const total = (await gql('query($c:String!,$f:String!,$e:String!) { calculateCollectionFormula(collectionId:$c, formulaId:$f, entryId:$e) { value unit } }', { c: sales.id, f: sales.formulas[0].id, e: saleEntry.id }, bob)).calculateCollectionFormula;
  assert.equal(Number(total.value), 7.5, 'sale total formula');

  const weather = installed['brainy.local-weather'];
  const observation = weather.formats[1];
  assert.equal(field(observation, 'Température').unit, '°C');
  await gql(CREATE_ENTRY, { id: weather.id, input: { formatId: observation.id, values: [{ fieldId: field(observation, 'Titre').id, value: 'Matin' }, { fieldId: field(observation, 'Température').id, value: '14.2' }, { fieldId: field(observation, 'Ciel').id, value: 'Nuageux' }] } }, bob);

  const shop = installed['brainy.shop'];
  assert.equal(shop.formats.length, 6);
  assert.deepEqual(shop.stockRules.map((rule) => rule.kind).sort(), ['IN', 'OUT', 'TRANSFER']);
  assert.equal(shop.units[0].symbol, 'ctn12');
  assert.equal(field(shop.formats.find((format) => format.name === 'Livraison fournisseur'), 'Cartons').unit, `local:${shop.units[0].id}`);

  const measurements = installed['brainy.measurements'];
  assert.equal(field(measurements.formats[1], 'Valeur').kind, 'MEASURE');
  assert.equal(measurements.savedViews[0].name, 'Tableau des mesures');

  // 2. Export from one account, install in another; no user data leaves the account.
  const aliceExpenses = (await gql(INSTALL, { json: pilot('brainy.expenses'), n: 'Mes comptes', l: 'fr' }, alice)).installDomainPackage;
  const aliceCollection = await collection(alice, aliceExpenses.collectionId);
  const aliceFormat = aliceCollection.formats[0];
  await gql(CREATE_ENTRY, { id: aliceCollection.id, input: { formatId: aliceFormat.id, values: [{ fieldId: field(aliceFormat, 'Titre').id, value: 'SECRET-ENTRY-TITLE' }, { fieldId: field(aliceFormat, 'Note').id, value: 'SECRET-NOTE' }] } }, alice);
  const exported = (await gql(EXPORT, { id: aliceCollection.id, l: 'fr', input: { packageId: 'alice.comptes', version: '1.0.0', name: 'Comptes d’Alice', author: 'Alice', license: 'CC-BY-4.0' } }, alice)).exportDomainPackage;
  assert.equal(exported.fileName, 'alice.comptes-1.0.0.brainy-package.json');
  assert.ok(!exported.packageJson.includes('SECRET'), 'export contains no entry value');
  assert.ok(!/"entries"|"ownerId"|"members"/.test(exported.packageJson), 'export contains no user data keys');
  await rejects(gql(EXPORT, { id: aliceCollection.id, input: { packageId: 'bob.steal', version: '1.0.0', name: 'x', author: 'x', license: 'x' } }, bob), /not found/i, 'export needs access');
  const bobPreview = (await gql(PREVIEW, { json: exported.packageJson, l: 'fr' }, bob)).previewDomainPackage;
  assert.equal(bobPreview.allowed, true);
  assert.deepEqual(bobPreview.dataFormats, ['Dépense']);
  assert.ok(bobPreview.dependencies.some((item) => item.includes('€')), 'built-in unit dependency listed');
  const bobCopy = (await gql(INSTALL, { json: exported.packageJson, l: 'en' }, bob)).installDomainPackage;
  assert.equal((await gql(ENTRIES, { id: bobCopy.collectionId }, bob)).collectionEntries.length, 0, 'no entries copied');
  const bobCopyCollection = await collection(bob, bobCopy.collectionId);
  assert.equal(bobCopyCollection.codeLists[0].codes.length, 10);

  // 3. Conflicts are shown before installing into an existing collection.
  const conflict = (await gql(PREVIEW, { json: pilot('brainy.expenses'), c: expenses.id, l: 'en' }, bob)).previewDomainPackage;
  assert.equal(conflict.mode, 'UPDATE');
  assert.equal(conflict.allowed, false, 'same version already installed');
  const intoNotes = (await gql(PREVIEW, { json: pilot('brainy.expenses'), c: notes.id, l: 'en' }, bob)).previewDomainPackage;
  assert.equal(intoNotes.mode, 'INSTALL');
  assert.equal(intoNotes.allowed, true);
  assert.ok(intoNotes.adjustments.length === 0 || intoNotes.adjustments.every((item) => item.includes('colour')));
  const intoShop = (await gql(PREVIEW, { json: pilot('brainy.simple-sales'), c: shop.id, l: 'fr' }, bob)).previewDomainPackage;
  assert.equal(intoShop.allowed, false);
  assert.ok(intoShop.conflicts.some((item) => item.includes('Produit')), 'format name conflict reported');
  await rejects(gql(INSTALL, { json: pilot('brainy.simple-sales'), c: shop.id, l: 'fr' }, bob), /Produit/, 'conflicting install refused');

  // 4. Updates are proposed and only add elements; local entries stay.
  const v2 = JSON.parse(pilot('brainy.expenses'));
  v2.version = '1.1.0';
  v2.content.dataFormats[0].fields.push({ key: 'receipt', name: { en: 'Receipt number', fr: 'Numéro de ticket' }, kind: 'TEXT' });
  v2.content.dataFormats.push({ key: 'budget', name: { en: 'Budget', fr: 'Budget' }, color: '#EAF8FA', fields: [{ key: 'title', name: 'Titre', kind: 'TITLE' }, { key: 'limit', name: { en: 'Limit', fr: 'Plafond' }, kind: 'NUMBER', unit: 'EUR' }] });
  v2.content.codeLists[0].codes.push({ code: 'EDUCATION', label: { en: 'Education', fr: 'Éducation' } });
  const update = (await gql(PREVIEW, { json: JSON.stringify(v2), c: expenses.id, l: 'fr' }, bob)).previewDomainPackage;
  assert.equal(update.mode, 'UPDATE');
  assert.equal(update.installedVersion, '1.0.0');
  assert.deepEqual(update.dataFormats, ['Budget']);
  assert.deepEqual(update.addedFields, ['Dépense → Numéro de ticket']);
  assert.equal(update.exampleObjects, 0);
  assert.equal(update.allowed, true);
  const before = (await gql(ENTRIES, { id: expenses.id }, bob)).collectionEntries.length;
  const updated = (await gql(INSTALL, { json: JSON.stringify(v2), c: expenses.id, l: 'fr' }, bob)).installDomainPackage;
  assert.equal(updated.mode, 'UPDATE');
  const afterUpdate = await collection(bob, expenses.id);
  assert.equal(afterUpdate.formats.length, 2);
  assert.ok(field(afterUpdate.formats[0], 'Numéro de ticket'));
  assert.ok(afterUpdate.codeLists[0].codes.some((code) => code.code === 'EDUCATION'));
  assert.equal((await gql(ENTRIES, { id: expenses.id }, bob)).collectionEntries.length, before);
  const older = (await gql(PREVIEW, { json: pilot('brainy.expenses'), c: expenses.id, l: 'en' }, bob)).previewDomainPackage;
  assert.ok(older.conflicts.some((item) => item.includes('older')), 'older version refused');

  // 5. Detaching keeps every entry.
  const installs = (await gql(INSTALLS, { id: expenses.id }, bob)).domainPackageInstalls;
  assert.equal(installs.length, 1);
  assert.equal(installs[0].version, '1.1.0');
  assert.equal(installs[0].dataFormatCount, 2);
  await gql('mutation($id:String!) { detachDomainPackage(installId:$id) }', { id: installs[0].id }, bob);
  assert.equal((await gql(INSTALLS, { id: expenses.id }, bob)).domainPackageInstalls.length, 0);
  assert.equal((await gql(ENTRIES, { id: expenses.id }, bob)).collectionEntries.length, before, 'entries kept after detaching');
  assert.equal((await collection(bob, expenses.id)).formats.length, 2, 'data formats kept after detaching');

  // 6. Incompatible, unsafe or tampered packages are refused clearly.
  const future = { ...JSON.parse(pilot('brainy.notes-links')), schemaVersion: 2 };
  await rejects(gql(PREVIEW, { json: JSON.stringify(future) }, bob), /package format 2.*format 1/, 'newer package format');
  const unknownKind = JSON.parse(pilot('brainy.notes-links'));
  unknownKind.content.dataFormats[0].fields[0].kind = 'HOLOGRAM';
  await rejects(gql(PREVIEW, { json: JSON.stringify(unknownKind) }, bob), /HOLOGRAM is not supported/, 'unknown field kind');
  const withScript = JSON.parse(pilot('brainy.notes-links'));
  withScript.content.dataFormats[0].script = 'fetch("https://example.test")';
  await rejects(gql(PREVIEW, { json: JSON.stringify(withScript) }, bob), /executable code/, 'executable code refused');
  const withEntries = JSON.parse(pilot('brainy.notes-links'));
  withEntries.content.entries = [{ title: 'x' }];
  await rejects(gql(PREVIEW, { json: JSON.stringify(withEntries) }, bob), /user entries/, 'user data refused');
  await rejects(gql(PREVIEW, { json: '{"format":"other"}' }, bob), /not a Brainy domain package/, 'foreign file');

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const signed = JSON.parse(pilot('brainy.local-weather'));
  signed.id = 'example.signed-weather';
  const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
  signed.provenance.signature = { algorithm: 'ed25519', publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'), value: sign(null, Buffer.from(canonical(signed)), privateKey).toString('base64') };
  const signedPreview = (await gql(PREVIEW, { json: JSON.stringify(signed) }, bob)).previewDomainPackage;
  assert.equal(signedPreview.signatureStatus, 'VALID');
  assert.match(signedPreview.keyFingerprint, /^[0-9a-f]{16}$/);
  signed.content.dataFormats[0].name = 'Tampered';
  const tampered = (await gql(PREVIEW, { json: JSON.stringify(signed) }, bob)).previewDomainPackage;
  assert.equal(tampered.signatureStatus, 'INVALID');
  assert.equal(tampered.allowed, false);
  await rejects(gql(INSTALL, { json: JSON.stringify(signed) }, bob), /signature/, 'tampered package refused');

  // T39. A package with a five-level nomenclature installs, and its deepest code can be assigned and grouped.
  const levels = JSON.parse(pilot('brainy.expenses'));
  levels.id = 'example.five-levels';
  levels.name = { en: 'Five levels', fr: 'Cinq niveaux' };
  levels.content.codeLists = [{ key: 'expense-category', name: { en: 'Activities', fr: 'Activités' }, codes: [
    { code: 'G', label: { en: 'Trade', fr: 'Commerce' } },
    { code: '47', label: { en: 'Retail', fr: 'Vente de détail' }, parent: 'G' },
    { code: '47.1', label: { en: 'Non-specialised stores', fr: 'Magasins non spécialisés' }, parent: '47' },
    { code: '47.11', label: { en: 'Mostly food', fr: 'À prédominance alimentaire' }, parent: '47.1' },
    { code: '47.11B', label: { en: 'General food stores', fr: "Commerce d'alimentation générale" }, parent: '47.11' },
  ] }];
  const levelsPreview = (await gql(PREVIEW, { json: JSON.stringify(levels), l: 'fr' }, bob)).previewDomainPackage;
  assert.equal(levelsPreview.allowed, true);
  const levelsResult = (await gql(INSTALL, { json: JSON.stringify(levels), l: 'fr' }, bob)).installDomainPackage;
  const levelsCollection = await collection(bob, levelsResult.collectionId);
  const levelsList = levelsCollection.codeLists[0];
  assert.equal(levelsList.codes.length, 5);
  const paths = (await gql('query($c:String!,$l:String!) { classificationCodePaths(collectionId:$c, listId:$l, language:"fr") { code label path level active } }', { c: levelsCollection.id, l: levelsList.id }, bob)).classificationCodePaths;
  assert.deepEqual(paths.find((item) => item.code === '47.11B'), { code: '47.11B', label: "Commerce d'alimentation générale", path: ['Commerce', 'Vente de détail', 'Magasins non spécialisés', 'À prédominance alimentaire'], level: 5, active: true });
  await rejects(gql('query($c:String!,$l:String!) { classificationCodePaths(collectionId:$c, listId:$l) { code } }', { c: levelsCollection.id, l: levelsList.id }, await account('Outsider')), /./, 'another account cannot read the paths');
  const levelsFormat = levelsCollection.formats.find((format) => format.fields.some((item) => item.codeListId === levelsList.id));
  const codeField = levelsFormat.fields.find((item) => item.codeListId === levelsList.id);
  const titleField = levelsFormat.fields.find((item) => item.kind === 'TITLE');
  await gql('mutation($id:String!,$input:SaveEntryInput!) { createEntry(collectionId:$id,input:$input) { id } }', { id: levelsCollection.id, input: { formatId: levelsFormat.id, values: [{ fieldId: titleField.id, value: 'Deep' }, { fieldId: codeField.id, value: '47.11B' }] } }, bob);
  const grouped = (await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { rows { group count } } }', { id: levelsCollection.id, input: { formatId: levelsFormat.id, operation: 'COUNT', measureKind: 'EVENT', groupBy: 'CATEGORY', groupFieldId: codeField.id, groupDepth: 2 } }, bob)).analyseCollection.rows;
  assert.deepEqual(grouped.map((row) => [row.group, row.count]), [['47.1', 1]], 'an entry groups at a level of a deep hierarchy');
  const cyclic = JSON.parse(JSON.stringify(levels));
  cyclic.id = 'example.cyclic';
  cyclic.content.codeLists[0].codes[0].parent = '47.11B';
  await rejects(gql(PREVIEW, { json: JSON.stringify(cyclic), l: 'fr' }, bob), /cycle/, 'a cyclic package is refused from the preview');

  // 7. A failing install leaves nothing behind.
  const broken = JSON.parse(pilot('brainy.simple-sales'));
  broken.id = 'example.broken';
  broken.content.exampleObjects = [{ dataFormat: 'product', values: { name: 'Bad', price: 'not-a-number' } }];
  const count = (await gql(COLLECTIONS, {}, bob)).collectionsList.length;
  await rejects(gql(INSTALL, { json: JSON.stringify(broken) }, bob), /./, 'invalid example refused');
  assert.equal((await gql(COLLECTIONS, {}, bob)).collectionsList.length, count, 'new collection rolled back');

  console.log('Domain package smoke passed: six pilots, export without user data, cross-account install, update, detach, signature and refusals.');
} catch (error) {
  console.error(error);
  process.exit(1);
}
