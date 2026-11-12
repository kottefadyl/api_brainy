import { FieldKind } from './collection.schema.js';
import { PACKAGE_FORMAT, PACKAGE_SCHEMA_VERSION } from './domain-package.format.js';

// Pilot domain packages shipped with Brainy. They are plain data in package format 1:
// domain experts can author new ones the same way, without touching Brainy's core.
const t = (en: string, fr: string) => ({ en, fr });
const provenance = { author: 'Brainy', license: 'CC0-1.0', publishedAt: '2026-11-07' };
const base = (id: string, name: ReturnType<typeof t>, description: ReturnType<typeof t>, notice: ReturnType<typeof t>) => ({ format: PACKAGE_FORMAT, schemaVersion: PACKAGE_SCHEMA_VERSION, id, version: '1.0.0', name, description, notice, provenance });
const title = (key = 'title') => ({ key, name: t('Title', 'Titre'), kind: FieldKind.TITLE });
const named = (key = 'name') => ({ key, name: t('Name', 'Nom'), kind: FieldKind.TITLE });
const columns = (format: string, keys: string[]) => keys.map((item) => `${format}.${item}`);

const notesLinks = {
  ...base('brainy.notes-links', t('Notes and links', 'Notes et liens'), t('Dated notes and saved links with a comment and a category.', 'Notes datées et liens conservés avec commentaire et catégorie.'), t('Start with a note: only the title is needed. Links keep their address, a comment and a category you can change.', 'Commencez par une note : seul le titre est nécessaire. Les liens gardent leur adresse, un commentaire et une catégorie modifiable.')),
  content: {
    dataFormats: [
      { key: 'note', name: t('Note', 'Note'), color: '#EEF5FF', fields: [title(), { key: 'content', name: t('Content', 'Contenu'), kind: FieldKind.LONG_TEXT }, { key: 'date', name: t('Date', 'Date'), kind: FieldKind.DATE }] },
      { key: 'link', name: t('Link', 'Lien'), color: '#EDF9F3', fields: [title(), { key: 'url', name: 'URL', kind: FieldKind.LINK }, { key: 'comment', name: t('Comment', 'Commentaire'), kind: FieldKind.LONG_TEXT }, { key: 'category', name: t('Category', 'Catégorie'), kind: FieldKind.SELECT, options: [t('Read later', 'À lire'), t('Reference', 'Référence'), t('Tool', 'Outil'), t('Other', 'Autre')] }] },
    ],
    views: [{ key: 'links-table', name: t('Saved links', 'Liens conservés'), layout: 'TABLE', dataFormats: ['link'], columns: columns('link', ['title', 'url', 'category']), sort: 'NEWEST' }],
  },
};

const expenses = {
  ...base('brainy.expenses', t('Expenses', 'Dépenses'), t('Amounts in euros with a two-level category list and a payment method.', 'Montants en euros avec catégories sur deux niveaux et moyen de paiement.'), t('Categories are a local code list: rename labels freely, codes stay stable. Group the analysis by main category or subcategory.', 'Les catégories forment une liste de codes locale : renommez les libellés librement, les codes restent stables. Regroupez l’analyse par catégorie ou sous-catégorie.')),
  content: {
    codeLists: [{ key: 'expense-category', name: t('Expense categories', 'Catégories de dépenses'), codes: [
      { code: 'FOOD', label: t('Food', 'Alimentation') }, { code: 'FOOD.GROCERIES', label: t('Groceries', 'Courses'), parent: 'FOOD' }, { code: 'FOOD.RESTAURANT', label: t('Restaurant', 'Restaurant'), parent: 'FOOD' },
      { code: 'HOME', label: t('Home', 'Logement') }, { code: 'HOME.RENT', label: t('Rent', 'Loyer'), parent: 'HOME' }, { code: 'HOME.ENERGY', label: t('Energy', 'Énergie'), parent: 'HOME' },
      { code: 'TRANSPORT', label: t('Transport', 'Transport') }, { code: 'LEISURE', label: t('Leisure', 'Loisirs') }, { code: 'HEALTH', label: t('Health', 'Santé') }, { code: 'OTHER', label: t('Other', 'Autre') },
    ] }],
    dataFormats: [{ key: 'expense', name: t('Expense', 'Dépense'), color: '#FFF0F4', fields: [title(), { key: 'amount', name: t('Amount', 'Montant'), kind: FieldKind.NUMBER, unit: 'EUR' }, { key: 'category', name: t('Category', 'Catégorie'), kind: FieldKind.CODE, codeList: 'expense-category' }, { key: 'date', name: t('Date', 'Date'), kind: FieldKind.DATE }, { key: 'payment', name: t('Payment', 'Paiement'), kind: FieldKind.SELECT, options: [t('Card', 'Carte'), t('Cash', 'Espèces'), t('Transfer', 'Virement')] }, { key: 'note', name: t('Note', 'Note'), kind: FieldKind.LONG_TEXT }] }],
    views: [{ key: 'expenses-table', name: t('Expenses table', 'Tableau des dépenses'), layout: 'TABLE', dataFormats: ['expense'], columns: columns('expense', ['title', 'amount', 'category', 'date']), sort: 'NEWEST' }],
  },
};

const sales = {
  ...base('brainy.simple-sales', t('Simple sales', 'Ventes simples'), t('Products with a price and sales with a computed total.', 'Produits avec prix et ventes avec total calculé.'), t('Each sale keeps its own unit price, so changing a product later does not rewrite past sales. The total is a formula: quantity × unit price.', 'Chaque vente garde son propre prix unitaire : modifier un produit ensuite ne réécrit pas les ventes passées. Le total est une formule : quantité × prix unitaire.')),
  content: {
    dataFormats: [
      { key: 'product', name: t('Product', 'Produit'), color: '#EDF9F3', objectModel: true, fields: [named(), { key: 'price', name: t('Price', 'Prix'), kind: FieldKind.NUMBER, unit: 'EUR' }] },
      { key: 'sale', name: t('Sale', 'Vente'), color: '#FFF5EB', fields: [title(), { key: 'product', name: t('Product', 'Produit'), kind: FieldKind.OBJECT_REF, target: 'product', referenceMode: 'SNAPSHOT' }, { key: 'quantity', name: t('Quantity', 'Quantité'), kind: FieldKind.NUMBER }, { key: 'unitPrice', name: t('Unit price', 'Prix unitaire'), kind: FieldKind.NUMBER, unit: 'EUR' }, { key: 'date', name: t('Date', 'Date'), kind: FieldKind.DATE }, { key: 'customer', name: t('Customer', 'Client'), kind: FieldKind.TEXT }] },
    ],
    exampleObjects: [
      { dataFormat: 'product', values: { name: t('Example product', 'Produit d’exemple'), price: '10' } },
    ],
    formulas: [{ key: 'total', name: t('Total', 'Total'), dataFormat: 'sale', expression: { kind: 'operation', operator: 'MULTIPLY', args: [{ kind: 'field', fieldId: 'quantity' }, { kind: 'field', fieldId: 'unitPrice' }] } }],
    views: [{ key: 'sales-table', name: t('Sales', 'Ventes'), layout: 'TABLE', dataFormats: ['sale'], columns: columns('sale', ['title', 'product', 'quantity', 'unitPrice', 'date']), sort: 'NEWEST' }],
  },
};

const weather = {
  ...base('brainy.local-weather', t('Local weather', 'Météo locale'), t('Weather stations and dated observations: temperature, rain, humidity and sky.', 'Stations et observations datées : température, pluie, humidité et ciel.'), t('Observations are facts you record. Brainy does not fetch any weather service. A forecast, if you add one later, stays separate from observations.', 'Les observations sont des faits que vous saisissez. Brainy n’interroge aucun service météo. Une prévision ajoutée plus tard reste séparée des observations.')),
  content: {
    dataFormats: [
      { key: 'station', name: t('Station', 'Station'), color: '#EAF8FA', objectModel: true, fields: [named(), { key: 'place', name: t('Place', 'Lieu'), kind: FieldKind.TEXT }] },
      { key: 'observation', name: t('Observation', 'Observation'), color: '#F4F0FF', fields: [title(), { key: 'station', name: t('Station', 'Station'), kind: FieldKind.OBJECT_REF, target: 'station' }, { key: 'observedAt', name: t('Observed at', 'Observé le'), kind: FieldKind.DATETIME }, { key: 'temperature', name: t('Temperature', 'Température'), kind: FieldKind.NUMBER, unit: '°C' }, { key: 'rain', name: t('Rain', 'Pluie'), kind: FieldKind.NUMBER, unit: 'mm' }, { key: 'humidity', name: t('Humidity', 'Humidité'), kind: FieldKind.NUMBER, unit: '%' }, { key: 'sky', name: t('Sky', 'Ciel'), kind: FieldKind.SELECT, options: [t('Sunny', 'Ensoleillé'), t('Cloudy', 'Nuageux'), t('Rain', 'Pluie'), t('Snow', 'Neige'), t('Fog', 'Brouillard')] }] },
    ],
    exampleObjects: [{ dataFormat: 'station', values: { name: t('Garden', 'Jardin'), place: t('Home', 'Maison') } }],
    views: [{ key: 'observations', name: t('Observations', 'Observations'), layout: 'TABLE', dataFormats: ['observation'], columns: columns('observation', ['title', 'station', 'observedAt', 'temperature', 'rain', 'sky']), sort: 'NEWEST' }],
  },
};

const movement = (key: string, name: ReturnType<typeof t>, color: string) => ({ key, name, color, fields: [
  title(), { key: 'product', name: t('Product', 'Produit'), kind: FieldKind.OBJECT_REF, target: 'product' }, { key: 'quantity', name: t('Quantity', 'Quantité'), kind: FieldKind.NUMBER, unit: 'item' },
  { key: 'occurredAt', name: t('Occurred at', 'Date du fait'), kind: FieldKind.DATETIME }, { key: 'from', name: t('From location', 'Lieu source'), kind: FieldKind.TEXT }, { key: 'to', name: t('To location', 'Lieu destination'), kind: FieldKind.TEXT },
  { key: 'lot', name: t('Lot', 'Lot'), kind: FieldKind.TEXT }, { key: 'reason', name: t('Reason', 'Motif'), kind: FieldKind.TEXT },
] });
const rule = (key: string, name: ReturnType<typeof t>, kind: string) => ({ key, name, dataFormat: key, kind, product: 'product', quantity: 'quantity', date: 'occurredAt', from: 'from', to: 'to', lot: 'lot', reason: 'reason' });
const shop = {
  ...base('brainy.shop', t('Shop', 'Boutique'), t('Products, suppliers, cartons of 12 and stock movements confirmed explicitly.', 'Produits, fournisseurs, cartons de 12 et mouvements de stock validés explicitement.'), t('Stock is derived from movements: receipts, sales and transfers each have their own rule, previewed before being applied.', 'Le stock découle des mouvements : réceptions, ventes et transferts ont chacun leur règle, prévisualisée avant application.')),
  content: {
    units: [{ key: 'carton', name: t('Carton of 12', 'Carton de 12'), symbol: 'ctn12', dimension: 'COUNT', base: 'item', factor: '12' }],
    dataFormats: [
      { key: 'product', name: t('Product', 'Produit'), color: '#EDF9F3', objectModel: true, fields: [named(), { key: 'sku', name: 'SKU', kind: FieldKind.TEXT }, { key: 'category', name: t('Category', 'Catégorie'), kind: FieldKind.TEXT }, { key: 'price', name: t('Price', 'Prix'), kind: FieldKind.NUMBER, unit: 'EUR' }] },
      { key: 'supplier', name: t('Supplier', 'Fournisseur'), color: '#EEF5FF', objectModel: true, fields: [named(), { key: 'contact', name: t('Contact', 'Contact'), kind: FieldKind.TEXT }] },
      movement('receipt', t('Stock receipt', 'Réception de stock'), '#FFF5EB'),
      movement('sale', t('Sale or outgoing', 'Vente ou sortie'), '#FFF0F4'),
      movement('transfer', t('Stock transfer', 'Transfert de stock'), '#F4F0FF'),
      { key: 'delivery', name: t('Supplier delivery', 'Livraison fournisseur'), color: '#FBF7E9', fields: [title(), { key: 'supplier', name: t('Supplier', 'Fournisseur'), kind: FieldKind.OBJECT_REF, target: 'supplier' }, { key: 'cartons', name: t('Cartons', 'Cartons'), kind: FieldKind.NUMBER, unit: 'local:carton' }, { key: 'date', name: t('Date', 'Date'), kind: FieldKind.DATE }] },
    ],
    stockRules: [rule('receipt', t('Stock receipt', 'Réception de stock'), 'IN'), rule('sale', t('Sale or outgoing', 'Vente ou sortie'), 'OUT'), rule('transfer', t('Stock transfer', 'Transfert de stock'), 'TRANSFER')],
    views: [{ key: 'products', name: t('Catalogue', 'Catalogue'), layout: 'TABLE', dataFormats: ['product'], columns: columns('product', ['name', 'sku', 'category', 'price']), sort: 'NEWEST' }],
  },
};

const measurements = {
  ...base('brainy.measurements', t('Measurement tracking', 'Suivi de mesures'), t('Measured subjects and dated measurements with status, quality and source.', 'Sujets mesurés et mesures datées avec statut, qualité et source.'), t('A missing value, a zero, an estimate and a measured value stay distinct. Quality and uncertainty are optional: never invent them.', 'Une valeur absente, un zéro, une estimation et une valeur mesurée restent distincts. Qualité et incertitude sont facultatives : ne les inventez jamais.')),
  content: {
    dataFormats: [
      { key: 'subject', name: t('Subject', 'Sujet'), color: '#F1F8ED', objectModel: true, fields: [named(), { key: 'description', name: t('Description', 'Description'), kind: FieldKind.LONG_TEXT }] },
      { key: 'measurement', name: t('Measurement', 'Mesure'), color: '#EFEFFD', fields: [title(), { key: 'subject', name: t('Measured subject', 'Sujet mesuré'), kind: FieldKind.OBJECT_REF, target: 'subject' }, { key: 'value', name: t('Value', 'Valeur'), kind: FieldKind.MEASURE, unit: 'kg' }, { key: 'occurredAt', name: t('Occurred at', 'Date du fait'), kind: FieldKind.DATETIME }, { key: 'source', name: t('Source', 'Source'), kind: FieldKind.TEXT }] },
    ],
    views: [{ key: 'measurements', name: t('Measurement dashboard', 'Tableau des mesures'), layout: 'TABLE', dataFormats: ['measurement'], columns: columns('measurement', ['title', 'subject', 'value', 'occurredAt']), sort: 'NEWEST' }],
  },
};

export const pilotPackages: Record<string, unknown>[] = [notesLinks, expenses, sales, weather, shop, measurements];
