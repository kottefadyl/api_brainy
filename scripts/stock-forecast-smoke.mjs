import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

const url = `http://localhost:${process.env.PORT ?? 3000}/graphql`;
assert.ok(process.env.MONGODB_URI, 'Set MONGODB_URI for cleanup');
await mongoose.connect(process.env.MONGODB_URI);
const email = `stock-${randomUUID()}@example.test`;
let ownerId;
const graphql = async (query, variables = {}, token) => (await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ query, variables }) })).json());
const data = (result) => { assert.equal(result.errors, undefined, JSON.stringify(result.errors)); return result.data; };

try {
  const auth = data(await graphql('mutation($input:RegisterInput!) { register(input:$input) { token user { id } } }', { input: { name: 'Stock Smoke', email, password: 'test-password-123' } })).register;
  ownerId = auth.user.id;
  const token = auth.token;
  const createTemplate = 'mutation($templateId:String!,$name:String!) { createCollectionFromTemplate(templateId:$templateId,name:$name) { id stockRules { id kind formatId } formats { id name fields { id name kind } } } }';
  const shop = data(await graphql(createTemplate, { templateId: 'shop', name: 'Shop smoke' }, token)).createCollectionFromTemplate;
  assert.equal(shop.stockRules.length, 3, JSON.stringify(shop.stockRules));
  const productFormat = shop.formats.find((format) => format.name === 'Product');
  const product = data(await graphql('mutation($id:String!,$input:SaveEntryInput!) { createEntry(collectionId:$id,input:$input) { id } }', { id: shop.id, input: { formatId: productFormat.id, values: [{ fieldId: productFormat.fields[0].id, value: 'Notebook' }] } }, token)).createEntry;
  const input = (kind, key, quantity, fromLocation = '', toLocation = '') => ({ kind, productId: product.id, quantity, fromLocation, toLocation, occurredAt: '2026-10-20T12:00:00Z', idempotencyKey: key });
  const movement = 'mutation($collectionId:String!,$input:StockMovementInput!) { commitStockMovement(collectionId:$collectionId,input:$input) { id kind } }';
  const stock = (value) => graphql(movement, { collectionId: shop.id, input: value }, token);
  const opening = input('IN', `open:${randomUUID()}`, '10', '', 'Shelf');
  data(await stock(opening));
  const outgoing = input('OUT', `sale:${randomUUID()}`, '3', 'Shelf', '');
  const salePreview = data(await graphql('query($collectionId:String!,$input:StockMovementInput!) { previewStockMovement(collectionId:$collectionId,input:$input) { allowed beforeFrom afterFrom } }', { collectionId: shop.id, input: outgoing }, token)).previewStockMovement;
  assert.deepEqual([salePreview.allowed, salePreview.beforeFrom, salePreview.afterFrom], [true, '10', '7']);
  const sold = data(await stock(outgoing)).commitStockMovement;
  assert.equal(data(await stock(outgoing)).commitStockMovement.id, sold.id, 'sale is idempotent');
  const transfer = input('TRANSFER', `transfer:${randomUUID()}`, '2', 'Shelf', 'Backroom');
  data(await stock(transfer));
  const positions = data(await graphql('query($collectionId:String!) { stockPositions(collectionId:$collectionId) { location quantity } }', { collectionId: shop.id }, token)).stockPositions;
  assert.equal(positions.find((item) => item.location === 'Shelf').quantity, '5');
  assert.equal(positions.find((item) => item.location === 'Backroom').quantity, '2');
  assert.equal(positions.reduce((sum, item) => sum + Number(item.quantity), 0), 7, 'transfer preserves the total');
  assert.ok((await stock(input('OUT', `overdraw:${randomUUID()}`, '8', 'Shelf', ''))).errors?.length, 'negative stock is blocked');
  const returned = { ...input('RETURN', `return:${randomUUID()}`, '1', '', 'Shelf'), reversalOf: sold.id };
  data(await stock(returned));
  assert.ok((await stock({ ...returned, idempotencyKey: `excess:${randomUUID()}`, quantity: '3' })).errors?.length, 'return cannot exceed original sale');
  const report = data(await graphql('query($collectionId:String!,$productId:String!,$from:String!,$to:String!,$timeZone:String!) { stockDailyReport(collectionId:$collectionId,productId:$productId,from:$from,to:$to,timeZone:$timeZone) { date opening incoming outgoing closing movements { id } } }', { collectionId: shop.id, productId: product.id, from: '2026-10-20', to: '2026-10-20', timeZone: 'UTC' }, token)).stockDailyReport;
  assert.equal(report[0].closing, '8');
  assert.equal(report[0].movements.length, 4);

  const saleFormat = shop.formats.find((format) => format.name === 'Sale or outgoing');
  const saleFields = Object.fromEntries(saleFormat.fields.map((field) => [field.name, field.id]));
  const saleEntry = data(await graphql('mutation($id:String!,$input:SaveEntryInput!) { createEntry(collectionId:$id,input:$input) { id updatedAt } }', { id: shop.id, input: { formatId: saleFormat.id, values: [{ fieldId: saleFields.Title, value: 'Sale' }, { fieldId: saleFields.Product, value: JSON.stringify([product.id]) }, { fieldId: saleFields.Quantity, value: '1' }, { fieldId: saleFields['From location'], value: 'Shelf' }] } }, token)).createEntry;
  const rule = shop.stockRules.find((item) => item.formatId === saleFormat.id);
  const confirm = 'mutation($collectionId:String!,$entryId:String!,$ruleId:String!,$expectedUpdatedAt:String!) { commitEntryStockEffect(collectionId:$collectionId,entryId:$entryId,ruleId:$ruleId,expectedUpdatedAt:$expectedUpdatedAt) { id } }';
  const args = { collectionId: shop.id, entryId: saleEntry.id, ruleId: rule.id, expectedUpdatedAt: saleEntry.updatedAt };
  const firstEffect = data(await graphql(confirm, args, token)).commitEntryStockEffect;
  assert.equal(data(await graphql(confirm, args, token)).commitEntryStockEffect.id, firstEffect.id, 'entry effect remains once after retry');

  const science = data(await graphql(createTemplate, { templateId: 'science', name: 'Science smoke' }, token)).createCollectionFromTemplate;
  const measurement = science.formats.find((format) => format.name === 'Measurement');
  const fields = Object.fromEntries(measurement.fields.map((field) => [field.name, field.id]));
  for (let month = 1; month <= 8; month++) data(await graphql('mutation($id:String!,$input:SaveEntryInput!) { createEntry(collectionId:$id,input:$input) { id } }', { id: science.id, input: { formatId: measurement.id, values: [{ fieldId: fields.Value, value: String(month * 2) }, { fieldId: fields['Occurred at'], value: `2026-${String(month).padStart(2, '0')}-15T12:00:00Z` }] } }, token));
  const forecast = data(await graphql('query($collectionId:String!,$input:ForecastInput!) { forecastCollection(collectionId:$collectionId,input:$input) { sourceFrom sourceTo trainingCount holdoutCount holdoutMae forecast { date estimate lower upper } } }', { collectionId: science.id, input: { formatId: measurement.id, fieldId: fields.Value, dateFieldId: fields['Occurred at'], frequency: 'MONTH', method: 'LINEAR', measureKind: 'SNAPSHOT', horizon: 2, holdout: 2 } }, token)).forecastCollection;
  assert.equal(forecast.forecast[0].date, '2026-09');
  assert.equal(forecast.forecast[0].estimate, '18');
  assert.equal(forecast.holdoutMae, '0');
  const weather = data(await graphql(createTemplate, { templateId: 'weather', name: 'Weather smoke' }, token)).createCollectionFromTemplate;
  const weatherFormat = weather.formats.find((format) => format.name === 'Measurement');
  const weatherFields = Object.fromEntries(weatherFormat.fields.map((field) => [field.name, field.id]));
  const forecastQuery = 'query($collectionId:String!,$input:ForecastInput!) { forecastCollection(collectionId:$collectionId,input:$input) { unit dimension trainingCount holdoutCount validation { observed estimate } forecast { date estimate } } }';
  const weatherInput = { formatId: weatherFormat.id, fieldId: weatherFields.Value, dateFieldId: weatherFields['Occurred at'], frequency: 'MONTH', method: 'MEAN', measureKind: 'SNAPSHOT', horizon: 1, holdout: 2 };
  assert.ok((await graphql(forecastQuery, { collectionId: weather.id, input: weatherInput }, token)).errors?.length, 'insufficient periods are rejected');
  for (let month = 1; month <= 6; month++) data(await graphql('mutation($id:String!,$input:SaveEntryInput!) { createEntry(collectionId:$id,input:$input) { id } }', { id: weather.id, input: { formatId: weatherFormat.id, values: [{ fieldId: weatherFields.Value, value: String(10 + month) }, { fieldId: weatherFields['Occurred at'], value: `2026-${String(month).padStart(2, '0')}-15T12:00:00Z` }] } }, token));
  const weatherForecast = data(await graphql(forecastQuery, { collectionId: weather.id, input: weatherInput }, token)).forecastCollection;
  assert.equal(weatherForecast.unit, '°C');
  assert.equal(weatherForecast.trainingCount, 4);
  assert.equal(weatherForecast.holdoutCount, 2);
  assert.equal(weatherForecast.validation[0].observed, '15');
  assert.equal(weatherForecast.forecast[0].date, '2026-07');
  console.log('T26/T27: stock preview, idempotence, transfer, return, daily sources, two measurement domains and held-out forecasts passed.');
} finally {
  try {
    if (ownerId) {
      const ids = (await mongoose.connection.collection('collections').find({ ownerId }, { projection: { _id: 1 } }).toArray()).map((item) => item._id.toString());
      await mongoose.connection.collection('stockmovements').deleteMany({ ownerId });
      await mongoose.connection.collection('stocklocks').deleteMany({ ownerId });
      await mongoose.connection.collection('entries').deleteMany({ collectionId: { $in: ids } });
      await mongoose.connection.collection('collections').deleteMany({ ownerId });
      await mongoose.connection.collection('users').deleteMany({ _id: new mongoose.Types.ObjectId(ownerId) });
    }
  } finally { await mongoose.disconnect(); }
}
