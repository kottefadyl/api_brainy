import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

assert.ok(process.env.MONGODB_URI);
await mongoose.connect(process.env.MONGODB_URI);
const endpoint = `http://localhost:${process.env.PORT || 3000}/graphql`;
const ids = [];
let ownerId, token, otherOwnerId;
async function gql(query, variables = {}, authorization = token, errorExpected = false) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorization ? { authorization: `Bearer ${authorization}` } : {}) }, body: JSON.stringify({ query, variables }) });
  const body = await response.json();
  if (errorExpected) { assert.ok(body.errors?.length, 'expected GraphQL rejection'); return body.errors[0].message; }
  assert.equal(body.errors, undefined, JSON.stringify(body.errors));
  return body.data;
}
try {
  const registered = await gql('mutation($input:RegisterInput!) { register(input:$input) { token user { id } } }', { input: { name: 'Analysis Tester', email: `analysis-${randomUUID()}@example.test`, password: 'temporary-test-password' } }, undefined);
  ownerId = registered.register.user.id;
  token = registered.register.token;
  const info = await gql('query { starterTemplates(language:"fr") { id name } }');
  assert.ok(info.starterTemplates.some((item) => item.id === 'book'));
  const bookTemplate = await gql('mutation { createCollectionFromTemplate(templateId:"book",name:"Manuscript",language:"en") { id formats { id name fields { id name kind } } savedViews { id sort manualOrderFieldIds } } }');
  const book = bookTemplate.createCollectionFromTemplate;
  ids.push(book.id);
  const orderView = book.savedViews.find((view) => view.sort === 'MANUAL');
  assert.equal(orderView.manualOrderFieldIds.length, 2);
  const bookEntry = async (formatName, title, order) => {
    const definition = book.formats.find((item) => item.name === formatName);
    return (await gql('mutation($id:String!,$input:SaveEntryInput!) { createEntry(collectionId:$id,input:$input) { id } }', { id: book.id, input: { formatId: definition.id, values: [{ fieldId: definition.fields.find((field) => field.kind === 'TITLE').id, value: title }, { fieldId: definition.fields.find((field) => field.kind === 'NUMBER').id, value: order }] } })).createEntry.id;
  };
  const secondChapter = await bookEntry('Chapter', 'Chapter two', '2');
  const firstScene = await bookEntry('Scene', 'Scene one', '1.1');
  const firstChapter = await bookEntry('Chapter', 'Chapter one', '1');
  const manualPage = async (after) => (await gql('query($id:String!,$viewId:String!,$after:String) { collectionEntriesPage(collectionId:$id,first:1,viewId:$viewId,after:$after) { entries { id } nextCursor hasMore } }', { id: book.id, viewId: orderView.id, after })).collectionEntriesPage;
  const firstPage = await manualPage(null);
  const secondPage = await manualPage(firstPage.nextCursor);
  const thirdPage = await manualPage(secondPage.nextCursor);
  assert.deepEqual([firstPage.entries[0].id, secondPage.entries[0].id, thirdPage.entries[0].id], [firstChapter, firstScene, secondChapter]);
  const restoredBook = (await gql('mutation { createCollectionFromTemplate(templateId:"book",name:"Restored manuscript",language:"en") { id formats { id name fields { id name kind } } savedViews { id sort } } }')).createCollectionFromTemplate;
  ids.push(restoredBook.id);
  const restoredChapter = restoredBook.formats.find((item) => item.name === 'Chapter');
  const restoredScene = restoredBook.formats.find((item) => item.name === 'Scene');
  const restoredImportKey = `book-${randomUUID()}`;
  const stamp = new Date().toISOString();
  const restoreRows = async (format, rows) => gql('mutation($id:String!,$input:ImportEntriesInput!) { importEntriesBatch(collectionId:$id,input:$input) { createdCount errors { message } } }', { id: restoredBook.id, input: { formatId: format.id, importKey: restoredImportKey, dryRun: false, rows: rows.map(([sourceId, title, order]) => ({ sourceId, createdAt: stamp, updatedAt: stamp, values: [{ fieldId: format.fields.find((field) => field.kind === 'TITLE').id, value: title }, { fieldId: format.fields.find((field) => field.kind === 'NUMBER').id, value: order }] })) } });
  assert.equal((await restoreRows(restoredChapter, [['chapter-2', 'Chapter two', '2'], ['chapter-1', 'Chapter one', '1']])).importEntriesBatch.createdCount, 2);
  assert.equal((await restoreRows(restoredScene, [['scene-1', 'Scene one', '1.1']])).importEntriesBatch.createdCount, 1);
  const restoredLink = await gql('mutation($id:String!,$key:String!,$links:[ImportedEntryLinkInput!]!) { linkImportedEntries(collectionId:$id,importKey:$key,links:$links) }', { id: restoredBook.id, key: restoredImportKey, links: [{ fromSourceId: 'chapter-1', toSourceId: 'scene-1', label: 'contains' }] });
  assert.equal(restoredLink.linkImportedEntries, true);
  assert.equal((await gql('mutation($id:String!,$key:String!,$links:[ImportedEntryLinkInput!]!) { linkImportedEntries(collectionId:$id,importKey:$key,links:$links) }', { id: restoredBook.id, key: restoredImportKey, links: [{ fromSourceId: 'chapter-1', toSourceId: 'scene-1', label: 'contains' }] })).linkImportedEntries, true, 'link import resumes safely');
  const restoredEntries = await mongoose.connection.collection('entries').find({ ownerId, collectionId: restoredBook.id, importKey: restoredImportKey }).toArray();
  const sourceId = (id) => String(restoredEntries.find((entry) => entry.sourceId === id)._id);
  const restoredPage = await gql('query($id:String!,$viewId:String!) { collectionEntriesPage(collectionId:$id,first:10,viewId:$viewId) { entries { id } } }', { id: restoredBook.id, viewId: restoredBook.savedViews.find((view) => view.sort === 'MANUAL').id });
  assert.deepEqual(restoredPage.collectionEntriesPage.entries.map((entry) => entry.id), [sourceId('chapter-1'), sourceId('scene-1'), sourceId('chapter-2')]);
  const verifiedLink = await gql('query($id:String!,$entryId:String!) { collectionEntryLinks(collectionId:$id,entryId:$entryId) { toEntryId label } }', { id: restoredBook.id, entryId: sourceId('chapter-1') });
  assert.deepEqual(verifiedLink.collectionEntryLinks.map((link) => [link.toEntryId, link.label]), [[sourceId('scene-1'), 'contains']]);
  const prepared = await gql('mutation($name:String!) { createCollectionFromTemplate(templateId:"expenses",name:$name,language:"fr") { id formats { id fields { id name } } } }', { name: 'Analyses' });
  ids.push(prepared.createCollectionFromTemplate.id);
  const linkTemplate = await gql('mutation { createCollectionFromTemplate(templateId:"links",name:"Bookmarks",language:"en") { id formats { id fields { id name kind } } } }');
  const bookmarkCollection = linkTemplate.createCollectionFromTemplate;
  ids.push(bookmarkCollection.id);
  const bookmarkFormat = bookmarkCollection.formats[0];
  const urlField = bookmarkFormat.fields.find((item) => item.kind === 'LINK');
  const bookmark = await gql('mutation($id:String!,$input:SaveEntryInput!) { createEntry(collectionId:$id,input:$input) { id } }', { id: bookmarkCollection.id, input: { formatId: bookmarkFormat.id, values: [{ fieldId: urlField.id, value: 'https://example.com/articles' }] } });
  const duplicates = await gql('query($id:String!,$formatId:String!,$fieldId:String!,$url:String!) { collectionDuplicateLinks(collectionId:$id,formatId:$formatId,fieldId:$fieldId,url:$url) { id } }', { id: bookmarkCollection.id, formatId: bookmarkFormat.id, fieldId: urlField.id, url: 'https://example.com/articles' });
  assert.equal(duplicates.collectionDuplicateLinks[0].id, bookmark.createEntry.id);
  const created = await gql('mutation($input:CreateCollectionInput!) { createCollection(input:$input) { id formats { id name fields { id name } } } }', { input: { name: 'Sales', formats: [{ name: 'Product', color: '#EEF5FF', objectModel: true, fields: [{ name: 'Name', kind: 'TITLE' }, { name: 'Price', kind: 'NUMBER', unit: 'EUR' }, { name: 'Weight', kind: 'NUMBER', unit: 'kg' }] }] } });
  const collection = created.createCollection;
  ids.push(collection.id);
  const product = collection.formats[0];
  const idOf = (format, name) => format.fields.find((field) => field.name === name).id;
  const object = await gql('mutation($id:String!,$input:SaveEntryInput!) { createEntry(collectionId:$id,input:$input) { id } }', { id: collection.id, input: { formatId: product.id, values: [{ fieldId: idOf(product, 'Name'), value: 'Water' }, { fieldId: idOf(product, 'Price'), value: '2' }, { fieldId: idOf(product, 'Weight'), value: '0.5' }] } });
  const added = await gql('mutation($id:String!,$input:CollectionFormatInput!) { addCollectionFormat(collectionId:$id,input:$input) { formats { id name version fields { id name } } } }', { id: collection.id, input: { name: 'Sale', color: '#EDF9F3', fields: [{ name: 'Title', kind: 'TITLE' }, { name: 'Product', kind: 'OBJECT_REF', targetObjectFormatId: product.id, referenceMode: 'SNAPSHOT' }, { name: 'Quantity', kind: 'NUMBER' }, { name: 'Date', kind: 'DATE' }, { name: 'Distance', kind: 'NUMBER', unit: 'km' }] } });
  const saleFormat = added.addCollectionFormat.formats.find((item) => item.name === 'Sale');
  const sale = async (title, quantity) => (await gql('mutation($id:String!,$input:SaveEntryInput!) { createEntry(collectionId:$id,input:$input) { id } }', { id: collection.id, input: { formatId: saleFormat.id, values: [{ fieldId: idOf(saleFormat, 'Title'), value: title }, { fieldId: idOf(saleFormat, 'Product'), value: JSON.stringify([object.createEntry.id]) }, { fieldId: idOf(saleFormat, 'Quantity'), value: quantity }, { fieldId: idOf(saleFormat, 'Date'), value: '2026-10-24' }, { fieldId: idOf(saleFormat, 'Distance'), value: '3' }] } })).createEntry.id;
  const first = await sale('One', '3'), second = await sale('Two', '4');
  const expression = { kind: 'operation', operator: 'MULTIPLY', args: [{ kind: 'field', fieldId: idOf(saleFormat, 'Quantity') }, { kind: 'property', referenceFieldId: idOf(saleFormat, 'Product'), propertyFieldId: idOf(product, 'Price') }] };
  const saved = await gql('mutation($id:String!,$input:FormulaInput!) { saveCollectionFormula(collectionId:$id,input:$input) { formulas { id name version } } }', { id: collection.id, input: { name: 'Total', formatId: saleFormat.id, expression: JSON.stringify(expression) } });
  const formulaId = saved.saveCollectionFormula.formulas[0].id;
  const result = await gql('query($id:String!,$formulaId:String!,$entryId:String!) { calculateCollectionFormula(collectionId:$id,formulaId:$formulaId,entryId:$entryId) { value unit } }', { id: collection.id, formulaId, entryId: first });
  assert.equal(result.calculateCollectionFormula.value, '6');
  assert.equal(result.calculateCollectionFormula.unit, 'EUR');
  const weightFormula = await gql('mutation($id:String!,$input:FormulaInput!) { saveCollectionFormula(collectionId:$id,input:$input) { formulas { id name } } }', { id: collection.id, input: { name: 'Sold weight', formatId: saleFormat.id, expression: JSON.stringify({ kind: 'operation', operator: 'MULTIPLY', args: [{ kind: 'field', fieldId: idOf(saleFormat, 'Quantity') }, { kind: 'property', referenceFieldId: idOf(saleFormat, 'Product'), propertyFieldId: idOf(product, 'Weight') }] }) } });
  const weightId = weightFormula.saveCollectionFormula.formulas.find((item) => item.name === 'Sold weight').id;
  const soldWeight = await gql('query($id:String!,$formulaId:String!,$entryId:String!) { calculateCollectionFormula(collectionId:$id,formulaId:$formulaId,entryId:$entryId) { value unit } }', { id: collection.id, formulaId: weightId, entryId: first });
  assert.equal(soldWeight.calculateCollectionFormula.value, '1.5');
  assert.equal(soldWeight.calculateCollectionFormula.unit, 'kg');
  const groupedWeight = await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { unit rows { group label value count } } }', { id: collection.id, input: { formatId: saleFormat.id, formulaId: weightId, groupBy: 'OBJECT', groupFieldId: idOf(saleFormat, 'Product'), operation: 'SUM', measureKind: 'EVENT' } });
  assert.equal(groupedWeight.analyseCollection.unit, 'kg');
  assert.deepEqual(groupedWeight.analyseCollection.rows.map((row) => [row.group, row.label, row.value, row.count]), [[object.createEntry.id, 'Water', '3.5', 2]]);
  const rounded = await gql('mutation($id:String!,$input:FormulaInput!) { saveCollectionFormula(collectionId:$id,input:$input) { formulas { id name } } }', { id: collection.id, input: { name: 'Rounded quotient', formatId: saleFormat.id, expression: JSON.stringify({ kind: 'round', digits: 2, mode: 'HALF_EVEN', value: { kind: 'operation', operator: 'DIVIDE', args: [{ kind: 'number', value: '1' }, { kind: 'number', value: '8' }] } }) } });
  const roundedId = rounded.saveCollectionFormula.formulas.find((item) => item.name === 'Rounded quotient').id;
  const roundedResult = await gql('query($id:String!,$formulaId:String!,$entryId:String!) { calculateCollectionFormula(collectionId:$id,formulaId:$formulaId,entryId:$entryId) { value } }', { id: collection.id, formulaId: roundedId, entryId: first });
  assert.equal(roundedResult.calculateCollectionFormula.value, '0.12');
  const dated = await gql('mutation($id:String!,$input:CollectionFormatInput!) { addCollectionFormat(collectionId:$id,input:$input) { formats { id name fields { id name } } } }', { id: collection.id, input: { name: 'Trip', color: '#FFF5EB', fields: [{ name: 'Title', kind: 'TITLE' }, { name: 'Start', kind: 'DATE' }, { name: 'End', kind: 'DATE' }] } });
  const tripFormat = dated.addCollectionFormat.formats.find((item) => item.name === 'Trip');
  const trip = await gql('mutation($id:String!,$input:SaveEntryInput!) { createEntry(collectionId:$id,input:$input) { id } }', { id: collection.id, input: { formatId: tripFormat.id, values: [{ fieldId: idOf(tripFormat, 'Title'), value: 'Four days' }, { fieldId: idOf(tripFormat, 'Start'), value: '2026-10-20' }, { fieldId: idOf(tripFormat, 'End'), value: '2026-10-24' }] } });
  const dateFormula = await gql('mutation($id:String!,$input:FormulaInput!) { saveCollectionFormula(collectionId:$id,input:$input) { formulas { id name } } }', { id: collection.id, input: { name: 'Trip duration', formatId: tripFormat.id, expression: JSON.stringify({ kind: 'dateDifference', fromFieldId: idOf(tripFormat, 'Start'), toFieldId: idOf(tripFormat, 'End'), unit: 'd' }) } });
  const dateId = dateFormula.saveCollectionFormula.formulas.find((item) => item.name === 'Trip duration').id;
  const dateResult = await gql('query($id:String!,$formulaId:String!,$entryId:String!) { calculateCollectionFormula(collectionId:$id,formulaId:$formulaId,entryId:$entryId) { value unit } }', { id: collection.id, formulaId: dateId, entryId: trip.createEntry.id });
  assert.equal(dateResult.calculateCollectionFormula.value, '4');
  assert.equal(dateResult.calculateCollectionFormula.unit, 'd');
  const copyTarget = await gql('mutation($input:CreateCollectionInput!) { createCollection(input:$input) { id } }', { input: { name: 'Copied sales', formats: [{ name: 'General', color: '#F4F0FF', fields: [{ name: 'Title', kind: 'TITLE' }] }] } });
  ids.push(copyTarget.createCollection.id);
  const targetId = copyTarget.createCollection.id;
  const copyPreview = await gql('query($formatId:String!,$targetCollectionId:String!) { dataFormatCopyPreview(formatId:$formatId,targetCollectionId:$targetCollectionId,withEntries:true) { allowed formulas } }', { formatId: saleFormat.id, targetCollectionId: targetId });
  assert.equal(copyPreview.dataFormatCopyPreview.allowed, true);
  assert.ok(copyPreview.dataFormatCopyPreview.formulas.includes('Total'));
  await gql('mutation($formatId:String!,$targetCollectionId:String!) { copyCollectionDataFormat(formatId:$formatId,targetCollectionId:$targetCollectionId,withEntries:true) { copiedEntries } }', { formatId: saleFormat.id, targetCollectionId: targetId });
  const copiedCollection = await gql('query { collectionsList { id formulas { id name formatId } formats { id name } } }');
  const copied = copiedCollection.collectionsList.find((item) => item.id === targetId);
  const copiedSale = copied.formats.find((item) => item.name === 'Sale');
  const copiedFormula = copied.formulas.find((item) => item.name === 'Total' && item.formatId === copiedSale.id);
  assert.ok(copiedFormula);
  const copiedEntries = await gql('query($id:String!) { collectionEntries(collectionId:$id) { id formatId } }', { id: targetId });
  const copiedEntry = copiedEntries.collectionEntries.find((item) => item.formatId === copiedSale.id);
  const copiedResult = await gql('query($id:String!,$formulaId:String!,$entryId:String!) { calculateCollectionFormula(collectionId:$id,formulaId:$formulaId,entryId:$entryId) { value unit } }', { id: targetId, formulaId: copiedFormula.id, entryId: copiedEntry.id });
  assert.ok(['6', '8'].includes(copiedResult.calculateCollectionFormula.value));
  assert.equal(copiedResult.calculateCollectionFormula.unit, 'EUR');
  const analysis = await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { rows { group value count sources { entryId } } } }', { id: collection.id, input: { formatId: saleFormat.id, formulaId, dateFieldId: idOf(saleFormat, 'Date'), groupBy: 'DAY', operation: 'SUM', measureKind: 'EVENT' } });
  assert.equal(analysis.analyseCollection.rows[0].value, '14');
  assert.equal(analysis.analyseCollection.rows[0].sources.length, 2);
  const filtered = await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { rows { value count } } }', { id: collection.id, input: { formatId: saleFormat.id, formulaId, groupBy: 'NONE', operation: 'SUM', measureKind: 'EVENT', filters: [{ fieldId: idOf(saleFormat, 'Quantity'), operator: 'GT', value: '3' }] } });
  assert.equal(filtered.analyseCollection.rows[0].value, '8');
  assert.equal(filtered.analyseCollection.rows[0].count, 1);
  const combinedFilters = await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { rows { value count } } }', { id: collection.id, input: { formatId: saleFormat.id, formulaId, groupBy: 'NONE', operation: 'SUM', measureKind: 'EVENT', filters: [{ fieldId: idOf(saleFormat, 'Quantity'), operator: 'GT', value: '2' }, { fieldId: idOf(saleFormat, 'Title'), operator: 'CONTAINS', value: 'two' }] } });
  assert.equal(combinedFilters.analyseCollection.rows[0].value, '8');
  assert.equal(combinedFilters.analyseCollection.rows[0].count, 1);
  const comparison = await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { rows { value } comparisonRows { value } } }', { id: collection.id, input: { formatId: saleFormat.id, formulaId, dateFieldId: idOf(saleFormat, 'Date'), groupBy: 'NONE', operation: 'SUM', measureKind: 'EVENT', from: '2026-10-24', to: '2026-10-24', comparisonFrom: '2026-10-23', comparisonTo: '2026-10-23' } });
  assert.equal(comparison.analyseCollection.rows[0].value, '14');
  assert.equal(comparison.analyseCollection.comparisonRows.length, 0);
  for (const [operation, expected] of [['AVERAGE', '7'], ['MIN', '6'], ['MAX', '8']]) {
    const checked = await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { rows { value } } }', { id: collection.id, input: { formatId: saleFormat.id, formulaId, groupBy: 'NONE', operation, measureKind: 'EVENT' } });
    assert.equal(checked.analyseCollection.rows[0].value, expected);
  }
  const incompatible = { kind: 'operation', operator: 'ADD', args: [{ kind: 'property', referenceFieldId: idOf(saleFormat, 'Product'), propertyFieldId: idOf(product, 'Price') }, { kind: 'field', fieldId: idOf(saleFormat, 'Distance') }] };
  const badSaved = await gql('mutation($id:String!,$input:FormulaInput!) { saveCollectionFormula(collectionId:$id,input:$input) { formulas { id name } } }', { id: collection.id, input: { name: 'Bad unit', formatId: saleFormat.id, expression: JSON.stringify(incompatible) } });
  const badId = badSaved.saveCollectionFormula.formulas.find((item) => item.name === 'Bad unit').id;
  await gql('query($id:String!,$formulaId:String!,$entryId:String!) { calculateCollectionFormula(collectionId:$id,formulaId:$formulaId,entryId:$entryId) { value } }', { id: collection.id, formulaId: badId, entryId: first }, token, true);
  const follow = await gql('mutation($id:String!,$input:FormulaInput!) { saveCollectionFormula(collectionId:$id,input:$input) { formulas { id name } } }', { id: collection.id, input: { name: 'Follow', formatId: saleFormat.id, expression: JSON.stringify({ kind: 'formula', formulaId }) } });
  const followId = follow.saveCollectionFormula.formulas.find((item) => item.name === 'Follow').id;
  await gql('mutation($id:String!,$formulaId:String!,$input:FormulaInput!) { saveCollectionFormula(collectionId:$id,formulaId:$formulaId,input:$input) { id } }', { id: collection.id, formulaId, input: { name: 'Total', formatId: saleFormat.id, expectedVersion: 1, expression: JSON.stringify({ kind: 'formula', formulaId: followId }) } }, token, true);
  const division = await gql('mutation($id:String!,$input:FormulaInput!) { saveCollectionFormula(collectionId:$id,input:$input) { formulas { id name } } }', { id: collection.id, input: { name: 'Zero denominator', formatId: saleFormat.id, expression: JSON.stringify({ kind: 'operation', operator: 'DIVIDE', args: [{ kind: 'field', fieldId: idOf(saleFormat, 'Quantity') }, { kind: 'number', value: '0' }] }) } });
  await gql('query($id:String!,$formulaId:String!,$entryId:String!) { calculateCollectionFormula(collectionId:$id,formulaId:$formulaId,entryId:$entryId) { value } }', { id: collection.id, formulaId: division.saveCollectionFormula.formulas.find((item) => item.name === 'Zero denominator').id, entryId: first }, token, true);
  const secondUser = await gql('mutation($input:RegisterInput!) { register(input:$input) { token user { id } } }', { input: { name: 'Outside Tester', email: `outside-${randomUUID()}@example.test`, password: 'temporary-test-password' } }, undefined);
  otherOwnerId = secondUser.register.user.id;
  const sourceEntry = await gql('query($collectionId:String!,$entryId:String!) { collectionEntry(collectionId:$collectionId,entryId:$entryId) { id } }', { collectionId: collection.id, entryId: first });
  assert.equal(sourceEntry.collectionEntry.id, first);
  await gql('query($collectionId:String!,$entryId:String!) { collectionEntry(collectionId:$collectionId,entryId:$entryId) { id } }', { collectionId: collection.id, entryId: first }, secondUser.register.token, true);
  await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { operation } }', { id: collection.id, input: { formatId: saleFormat.id, formulaId, groupBy: 'NONE', operation: 'SUM', measureKind: 'EVENT' } }, secondUser.register.token, true);
  const linked = await gql('mutation($id:String!,$from:String!,$to:String!) { createCollectionEntryLink(collectionId:$id,fromEntryId:$from,toEntryId:$to) { id deletedAt } }', { id: collection.id, from: first, to: second });
  const linkId = linked.createCollectionEntryLink.id;
  const removed = await gql('mutation($id:String!,$link:String!) { setCollectionEntryLinkActive(collectionId:$id,linkId:$link,active:false) { deletedAt } }', { id: collection.id, link: linkId });
  assert.ok(removed.setCollectionEntryLinkActive.deletedAt);
  const restored = await gql('mutation($id:String!,$link:String!) { setCollectionEntryLinkActive(collectionId:$id,linkId:$link,active:true) { deletedAt } }', { id: collection.id, link: linkId });
  assert.equal(restored.setCollectionEntryLinkActive.deletedAt, null);
  const importKey = `links-${randomUUID()}`;
  const now = new Date().toISOString();
  const imported = await gql('mutation($id:String!,$input:ImportEntriesInput!) { importEntriesBatch(collectionId:$id,input:$input) { createdCount errors { message } } }', { id: collection.id, input: { formatId: saleFormat.id, importKey, dryRun: false, rows: ['chapter', 'scene'].map((sourceId) => ({ sourceId, createdAt: now, updatedAt: now, values: [{ fieldId: idOf(saleFormat, 'Title'), value: sourceId }] })) } });
  assert.equal(imported.importEntriesBatch.createdCount, 2, JSON.stringify(imported.importEntriesBatch.errors));
  const linkedImport = await gql('mutation($id:String!,$key:String!,$links:[ImportedEntryLinkInput!]!) { linkImportedEntries(collectionId:$id,importKey:$key,links:$links) }', { id: collection.id, key: importKey, links: [{ fromSourceId: 'chapter', toSourceId: 'scene', label: 'contains' }] });
  assert.equal(linkedImport.linkImportedEntries, true);
  const importedEntries = await mongoose.connection.collection('entries').find({ ownerId, collectionId: collection.id, importKey }).toArray();
  const importedLinks = await gql('query($id:String!,$entryId:String!) { collectionEntryLinks(collectionId:$id,entryId:$entryId) { label toEntryId } }', { id: collection.id, entryId: String(importedEntries.find((item) => item.sourceId === 'chapter')._id) });
  assert.equal(importedLinks.collectionEntryLinks[0].label, 'contains');
  await gql('mutation($id:String!,$input:SaveEntryInput!) { updateEntry(id:$id,input:$input) { id } }', { id: first, input: { formatId: saleFormat.id, values: [{ fieldId: idOf(saleFormat, 'Title'), value: 'One corrected' }, { fieldId: idOf(saleFormat, 'Product'), value: JSON.stringify([object.createEntry.id]) }, { fieldId: idOf(saleFormat, 'Quantity'), value: '5' }, { fieldId: idOf(saleFormat, 'Date'), value: '2026-10-24' }, { fieldId: idOf(saleFormat, 'Distance'), value: '3' }] } });
  const corrected = await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { rows { value } } }', { id: collection.id, input: { formatId: saleFormat.id, formulaId, groupBy: 'NONE', operation: 'SUM', measureKind: 'EVENT' } });
  assert.equal(corrected.analyseCollection.rows[0].value, '18');
  const formulaUpdate = await gql('mutation($id:String!,$formulaId:String!,$input:FormulaInput!) { saveCollectionFormula(collectionId:$id,formulaId:$formulaId,input:$input) { formulas { id version } } }', { id: collection.id, formulaId, input: { name: 'Total', formatId: saleFormat.id, expectedVersion: 1, expression: JSON.stringify(expression) } });
  assert.equal(formulaUpdate.saveCollectionFormula.formulas.find((item) => item.id === formulaId).version, 2);
  const updatedFormulaResult = await gql('query($id:String!,$formulaId:String!,$entryId:String!) { calculateCollectionFormula(collectionId:$id,formulaId:$formulaId,entryId:$entryId) { value } }', { id: collection.id, formulaId, entryId: first });
  assert.equal(updatedFormulaResult.calculateCollectionFormula.value, '10');
  await gql('mutation($collectionId:String!,$formatId:String!,$input:UpdateCollectionFormatInput!) { updateCollectionFormat(collectionId:$collectionId,formatId:$formatId,input:$input) { id } }', { collectionId: collection.id, formatId: saleFormat.id, input: { name: 'Sale', expectedVersion: saleFormat.version, fields: [{ id: idOf(saleFormat, 'Title'), name: 'Title', kind: 'TITLE' }, { id: idOf(saleFormat, 'Product'), name: 'Product', kind: 'OBJECT_REF', targetObjectFormatId: product.id, referenceMode: 'SNAPSHOT' }, { id: idOf(saleFormat, 'Quantity'), name: 'Units sold', kind: 'NUMBER' }, { id: idOf(saleFormat, 'Date'), name: 'Date', kind: 'DATE' }, { id: idOf(saleFormat, 'Distance'), name: 'Distance', kind: 'NUMBER', unit: 'km' }] } });
  const renamedFieldResult = await gql('query($id:String!,$formulaId:String!,$entryId:String!) { calculateCollectionFormula(collectionId:$id,formulaId:$formulaId,entryId:$entryId) { value unit } }', { id: collection.id, formulaId, entryId: first });
  assert.equal(renamedFieldResult.calculateCollectionFormula.value, '10');
  assert.equal(renamedFieldResult.calculateCollectionFormula.unit, 'EUR');
  const synthetic = Array.from({ length: 10001 }, (_, index) => ({ _id: new mongoose.Types.ObjectId(), ownerId, collectionId: collection.id, formatId: saleFormat.id, formatVersion: 1, values: [{ fieldId: idOf(saleFormat, 'Title'), value: `Load ${index}` }], createdAt: new Date(), updatedAt: new Date() }));
  await mongoose.connection.collection('entries').insertMany(synthetic, { ordered: false });
  const largeCount = await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { rows { value } } }', { id: collection.id, input: { formatId: saleFormat.id, groupBy: 'NONE', operation: 'COUNT', measureKind: 'EVENT' } });
  assert.equal(largeCount.analyseCollection.rows[0].value, '10005');
  const sourceInput = { formatId: saleFormat.id, groupBy: 'NONE', operation: 'COUNT', measureKind: 'EVENT' };
  const firstSources = await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { rows { count sourcesHasMore sources { entryId } } } }', { id: collection.id, input: sourceInput });
  assert.equal(firstSources.analyseCollection.rows[0].sources.length, 100);
  assert.equal(firstSources.analyseCollection.rows[0].sourcesHasMore, true);
  const nextSources = await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { rows { sourcesHasMore sources { entryId } } } }', { id: collection.id, input: { ...sourceInput, sourceGroup: 'All', sourceOffset: 100 } });
  assert.equal(nextSources.analyseCollection.rows[0].sources.length, 100);
  assert.ok(!firstSources.analyseCollection.rows[0].sources.some((source) => nextSources.analyseCollection.rows[0].sources.some((next) => next.entryId === source.entryId)));
  await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { rows { count } } }', { id: collection.id, input: { ...sourceInput, sourceGroup: 'All', sourceOffset: -1 } }, token, true);

  // T35 — Registered extensible analysis operations (R2, R9, R10, stats, sequences, rates, crosstab)
  const opsMeta = await gql('query { analysisOperations { id version requiresNumeric requiresDateOrder minObservations } }');
  assert.ok(opsMeta.analysisOperations.length >= 17);
  assert.equal(opsMeta.analysisOperations.find((item) => item.id === 'SUCCESSIVE_DIFF').version, 1);

  const t35Created = await gql('mutation($input:CreateCollectionInput!) { createCollection(input:$input) { id formats { id name fields { id name } } } }', {
    input: {
      name: 'T35 Benchmarks',
      formats: [
        {
          name: 'WaterMeter',
          color: '#EEF5FF',
          fields: [
            { name: 'Label', kind: 'TITLE' },
            { name: 'Date', kind: 'DATE' },
            { name: 'Index', kind: 'NUMBER', unit: 'L' },
            { name: 'Reset', kind: 'BOOLEAN' },
          ],
        },
        {
          name: 'Latency',
          color: '#EDF9F3',
          fields: [
            { name: 'Endpoint', kind: 'TITLE' },
            { name: 'DurationMs', kind: 'NUMBER' },
            { name: 'Requests', kind: 'NUMBER' },
          ],
        },
        {
          name: 'Demography',
          color: '#FFF5EB',
          fields: [
            { name: 'District', kind: 'TITLE' },
            { name: 'Births', kind: 'NUMBER' },
            { name: 'Population', kind: 'NUMBER' },
          ],
        },
        {
          name: 'Ledger',
          color: '#F4F0FF',
          fields: [
            { name: 'Label', kind: 'TITLE' },
            { name: 'Date', kind: 'DATE' },
            { name: 'Category', kind: 'SELECT', options: ['Food', 'Transport'] },
            { name: 'Amount', kind: 'NUMBER', unit: 'EUR' },
          ],
        },
      ],
    },
  });
  const t35Col = t35Created.createCollection;
  ids.push(t35Col.id);
  const meterFmt = t35Col.formats.find((item) => item.name === 'WaterMeter');
  const latencyFmt = t35Col.formats.find((item) => item.name === 'Latency');
  const demoFmt = t35Col.formats.find((item) => item.name === 'Demography');
  const ledgerFmt = t35Col.formats.find((item) => item.name === 'Ledger');

  // R10: Water meter readings + declared reset + missing value skipped
  const addMeter = async (label, date, indexVal, resetVal) => (await gql('mutation($id:String!,$input:SaveEntryInput!) { createEntry(collectionId:$id,input:$input) { id } }', {
    id: t35Col.id,
    input: {
      formatId: meterFmt.id,
      values: [
        { fieldId: idOf(meterFmt, 'Label'), value: label },
        { fieldId: idOf(meterFmt, 'Date'), value: date },
        ...(indexVal !== null ? [{ fieldId: idOf(meterFmt, 'Index'), value: indexVal }] : []),
        ...(resetVal !== undefined ? [{ fieldId: idOf(meterFmt, 'Reset'), value: resetVal }] : []),
      ],
    },
  })).createEntry.id;
  await addMeter('Jan', '2026-01-01', '1000', 'false');
  await addMeter('Feb', '2026-02-01', '1120', 'false');
  const marMeterId = await addMeter('Mar', '2026-03-01', '1250', 'false');
  await addMeter('Mar missing', '2026-03-15', null, 'false');
  await addMeter('Apr reset', '2026-04-01', '45', 'true');

  // Undeclared drop must be rejected when counterResetFieldId is omitted
  await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { rows { value } } }', {
    id: t35Col.id,
    input: { formatId: meterFmt.id, fieldId: idOf(meterFmt, 'Index'), dateFieldId: idOf(meterFmt, 'Date'), groupBy: 'MONTH', operation: 'SUCCESSIVE_DIFF', measureKind: 'SNAPSHOT' },
  }, token, true);

  // Declared reset via counterResetFieldId succeeds and skips missing reading
  const meterDiff = await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { operationVersion skippedMissingCount unit rows { group value count } } }', {
    id: t35Col.id,
    input: { formatId: meterFmt.id, fieldId: idOf(meterFmt, 'Index'), dateFieldId: idOf(meterFmt, 'Date'), counterResetFieldId: idOf(meterFmt, 'Reset'), groupBy: 'MONTH', operation: 'SUCCESSIVE_DIFF', measureKind: 'SNAPSHOT' },
  });
  assert.equal(meterDiff.analyseCollection.operationVersion, 1);
  assert.equal(meterDiff.analyseCollection.skippedMissingCount, 1);
  assert.equal(meterDiff.analyseCollection.unit, 'L');
  assert.deepEqual(meterDiff.analyseCollection.rows.map((row) => [row.group, row.value]), [['2026-02', '120'], ['2026-03', '130'], ['2026-04', '45']]);

  // Correcting an entry updates subsequent analysis
  await gql('mutation($id:String!,$input:SaveEntryInput!) { updateEntry(id:$id,input:$input) { id } }', {
    id: marMeterId,
    input: {
      formatId: meterFmt.id,
      values: [
        { fieldId: idOf(meterFmt, 'Label'), value: 'Mar corrected' },
        { fieldId: idOf(meterFmt, 'Date'), value: '2026-03-01' },
        { fieldId: idOf(meterFmt, 'Index'), value: '1260' },
        { fieldId: idOf(meterFmt, 'Reset'), value: 'false' },
      ],
    },
  });
  const meterDiffAfterUpdate = await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { rows { group value } } }', {
    id: t35Col.id,
    input: { formatId: meterFmt.id, fieldId: idOf(meterFmt, 'Index'), dateFieldId: idOf(meterFmt, 'Date'), counterResetFieldId: idOf(meterFmt, 'Reset'), groupBy: 'MONTH', operation: 'SUCCESSIVE_DIFF', measureKind: 'SNAPSHOT' },
  });
  assert.deepEqual(meterDiffAfterUpdate.analyseCollection.rows.map((row) => [row.group, row.value]), [['2026-02', '120'], ['2026-03', '140'], ['2026-04', '45']]);

  // Response time series: MEDIAN, PERCENTILE (95), VARIANCE, STDDEV, RANGE, weighted AVERAGE
  for (const [ep, ms, reqs] of [['A', '10', '30'], ['B', '20', '30'], ['C', '30', '20'], ['D', '40', '10'], ['E', '200', '10']]) {
    await gql('mutation($id:String!,$input:SaveEntryInput!) { createEntry(collectionId:$id,input:$input) { id } }', {
      id: t35Col.id,
      input: { formatId: latencyFmt.id, values: [{ fieldId: idOf(latencyFmt, 'Endpoint'), value: ep }, { fieldId: idOf(latencyFmt, 'DurationMs'), value: ms }, { fieldId: idOf(latencyFmt, 'Requests'), value: reqs }] },
    });
  }
  const medianRes = await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { rows { value } } }', {
    id: t35Col.id,
    input: { formatId: latencyFmt.id, fieldId: idOf(latencyFmt, 'DurationMs'), groupBy: 'NONE', operation: 'MEDIAN', measureKind: 'SNAPSHOT' },
  });
  assert.equal(medianRes.analyseCollection.rows[0].value, '30');

  const p95Res = await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { rows { value } } }', {
    id: t35Col.id,
    input: { formatId: latencyFmt.id, fieldId: idOf(latencyFmt, 'DurationMs'), groupBy: 'NONE', operation: 'PERCENTILE', percentile: 95, measureKind: 'SNAPSHOT' },
  });
  assert.equal(p95Res.analyseCollection.rows[0].value, '200');

  const rangeRes = await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { rows { value } } }', {
    id: t35Col.id,
    input: { formatId: latencyFmt.id, fieldId: idOf(latencyFmt, 'DurationMs'), groupBy: 'NONE', operation: 'RANGE', measureKind: 'SNAPSHOT' },
  });
  assert.equal(rangeRes.analyseCollection.rows[0].value, '190');

  const varRes = await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { rows { value } } }', {
    id: t35Col.id,
    input: { formatId: latencyFmt.id, fieldId: idOf(latencyFmt, 'DurationMs'), groupBy: 'NONE', operation: 'VARIANCE', measureKind: 'SNAPSHOT' },
  });
  assert.equal(varRes.analyseCollection.rows[0].value, '5000');

  const stdRes = await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { rows { value } } }', {
    id: t35Col.id,
    input: { formatId: latencyFmt.id, fieldId: idOf(latencyFmt, 'DurationMs'), groupBy: 'NONE', operation: 'STDDEV', measureKind: 'SNAPSHOT' },
  });
  assert.equal(stdRes.analyseCollection.rows[0].value, '70.710678');

  const weightedAvg = await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { rows { value } } }', {
    id: t35Col.id,
    input: { formatId: latencyFmt.id, fieldId: idOf(latencyFmt, 'DurationMs'), weightFieldId: idOf(latencyFmt, 'Requests'), groupBy: 'NONE', operation: 'AVERAGE', measureKind: 'SNAPSHOT' },
  });
  assert.equal(weightedAvg.analyseCollection.rows[0].value, '39');

  // R9: Demographic rate per 1,000 inhabitants with explicit denominator
  for (const [d, b, p] of [['North', '45', '3000'], ['South', '30', '2000']]) {
    await gql('mutation($id:String!,$input:SaveEntryInput!) { createEntry(collectionId:$id,input:$input) { id } }', {
      id: t35Col.id,
      input: { formatId: demoFmt.id, values: [{ fieldId: idOf(demoFmt, 'District'), value: d }, { fieldId: idOf(demoFmt, 'Births'), value: b }, { fieldId: idOf(demoFmt, 'Population'), value: p }] },
    });
  }
  const rateRes = await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { rows { value } explanation } }', {
    id: t35Col.id,
    input: { formatId: demoFmt.id, fieldId: idOf(demoFmt, 'Births'), denominatorFieldId: idOf(demoFmt, 'Population'), rateBase: 1000, groupBy: 'NONE', operation: 'RATE_PER_N', measureKind: 'RATE' },
  });
  assert.equal(rateRes.analyseCollection.rows[0].value, '15');
  // Missing denominator must be rejected
  await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { rows { value } } }', {
    id: t35Col.id,
    input: { formatId: demoFmt.id, fieldId: idOf(demoFmt, 'Births'), rateBase: 1000, groupBy: 'NONE', operation: 'RATE_PER_N', measureKind: 'RATE' },
  }, token, true);

  // R2: Category x Month CROSSTAB + CUMULATIVE + MOVING_AVERAGE + SUCCESSIVE_VARIATION + LINEAR_TREND
  for (const [label, date, cat, amount] of [
    ['G1', '2026-01-10', 'Food', '100'],
    ['G2', '2026-01-20', 'Transport', '50'],
    ['G3', '2026-02-10', 'Food', '150'],
    ['G4', '2026-03-10', 'Food', '225'],
  ]) {
    await gql('mutation($id:String!,$input:SaveEntryInput!) { createEntry(collectionId:$id,input:$input) { id } }', {
      id: t35Col.id,
      input: {
        formatId: ledgerFmt.id,
        values: [
          { fieldId: idOf(ledgerFmt, 'Label'), value: label },
          { fieldId: idOf(ledgerFmt, 'Date'), value: date },
          { fieldId: idOf(ledgerFmt, 'Category'), value: cat },
          { fieldId: idOf(ledgerFmt, 'Amount'), value: amount },
        ],
      },
    });
  }
  const crosstabRes = await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { secondaryGroupBy rows { rowKey columnKey value count } } }', {
    id: t35Col.id,
    input: {
      formatId: ledgerFmt.id,
      fieldId: idOf(ledgerFmt, 'Amount'),
      dateFieldId: idOf(ledgerFmt, 'Date'),
      groupBy: 'CATEGORY',
      groupFieldId: idOf(ledgerFmt, 'Category'),
      secondaryGroupBy: 'MONTH',
      operation: 'CROSSTAB',
      measureKind: 'EVENT',
    },
  });
  assert.equal(crosstabRes.analyseCollection.secondaryGroupBy, 'MONTH');
  assert.deepEqual(
    crosstabRes.analyseCollection.rows.map((row) => [row.rowKey, row.columnKey, row.value, row.count]),
    [['Food', '2026-01', '100', 1], ['Food', '2026-02', '150', 1], ['Food', '2026-03', '225', 1], ['Transport', '2026-01', '50', 1]],
  );

  const cumRes = await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { rows { group value } } }', {
    id: t35Col.id,
    input: { formatId: ledgerFmt.id, fieldId: idOf(ledgerFmt, 'Amount'), dateFieldId: idOf(ledgerFmt, 'Date'), groupBy: 'MONTH', operation: 'CUMULATIVE', measureKind: 'EVENT' },
  });
  assert.deepEqual(cumRes.analyseCollection.rows.map((row) => [row.group, row.value]), [['2026-01', '150'], ['2026-02', '300'], ['2026-03', '525']]);

  const movAvgRes = await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { rows { group value } } }', {
    id: t35Col.id,
    input: { formatId: ledgerFmt.id, fieldId: idOf(ledgerFmt, 'Amount'), dateFieldId: idOf(ledgerFmt, 'Date'), groupBy: 'MONTH', operation: 'MOVING_AVERAGE', windowSize: 2, measureKind: 'EVENT' },
  });
  assert.deepEqual(movAvgRes.analyseCollection.rows.map((row) => [row.group, row.value]), [['2026-01', '150'], ['2026-02', '150'], ['2026-03', '187.5']]);

  const varPctRes = await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { unit rows { group value } } }', {
    id: t35Col.id,
    input: { formatId: ledgerFmt.id, fieldId: idOf(ledgerFmt, 'Amount'), dateFieldId: idOf(ledgerFmt, 'Date'), groupBy: 'MONTH', operation: 'SUCCESSIVE_VARIATION', measureKind: 'EVENT' },
  });
  assert.equal(varPctRes.analyseCollection.unit, '%');
  assert.deepEqual(varPctRes.analyseCollection.rows.map((row) => [row.group, row.value]), [['2026-01', '-50'], ['2026-02', '200'], ['2026-03', '50']]);

  const trendRes = await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { slope rows { group value } } }', {
    id: t35Col.id,
    input: { formatId: ledgerFmt.id, fieldId: idOf(ledgerFmt, 'Amount'), dateFieldId: idOf(ledgerFmt, 'Date'), groupBy: 'MONTH', operation: 'LINEAR_TREND', measureKind: 'EVENT' },
  });
  assert.equal(trendRes.analyseCollection.slope, '37.5');
  assert.equal(trendRes.analyseCollection.rows.length, 3);

  // Too few observations (< 2 for STDDEV) must be explicitly rejected
  await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { rows { value } } }', {
    id: t35Col.id,
    input: { formatId: latencyFmt.id, fieldId: idOf(latencyFmt, 'DurationMs'), groupBy: 'NONE', operation: 'STDDEV', measureKind: 'SNAPSHOT', filters: [{ fieldId: idOf(latencyFmt, 'Endpoint'), operator: 'EQ', value: 'A' }] },
  }, token, true);

  // T21/1 — Conditions, comparisons, logic and numeric functions
  const t21Formats = [{ name: 'Order', color: '#EEF5FF', fields: [{ name: 'Label', kind: 'TITLE' }, { name: 'Quantity', kind: 'NUMBER' }, { name: 'Price', kind: 'NUMBER', unit: 'EUR' }] }];
  const t21Col = (await gql('mutation($input:CreateCollectionInput!) { createCollection(input:$input) { id formats { id name fields { id name } } } }', { input: { name: 'T21 Conditions', formats: t21Formats } })).createCollection;
  ids.push(t21Col.id);
  const orderFmt = t21Col.formats[0];
  const t21Field = (name) => ({ kind: 'field', fieldId: idOf(orderFmt, name) });
  const num = (value, unit) => ({ kind: 'number', value, ...(unit ? { unit } : {}) });
  const cmp = (operator, left, right) => ({ kind: 'comparison', operator, left, right });
  const iif = (condition, thenBranch, elseBranch) => ({ kind: 'conditional', condition, then: thenBranch, else: elseBranch });
  const yesNo = (condition) => iif(condition, num('1'), num('0'));
  const yes = { kind: 'boolean', value: true }, no = { kind: 'boolean', value: false };
  const logical = (operator, ...args) => ({ kind: 'logical', operator, args });
  const createOrder = async (collectionId, format, fieldId, label, quantity) => (await gql('mutation($id:String!,$input:SaveEntryInput!) { createEntry(collectionId:$id,input:$input) { id } }', { id: collectionId, input: { formatId: format.id, values: [{ fieldId: fieldId(format, 'Label'), value: label }, ...(quantity === null ? [] : [{ fieldId: fieldId(format, 'Quantity'), value: quantity }]), { fieldId: fieldId(format, 'Price'), value: '100' }] } })).createEntry.id;
  const highOrder = await createOrder(t21Col.id, orderFmt, idOf, 'High', '6');
  const lowOrder = await createOrder(t21Col.id, orderFmt, idOf, 'Boundary', '5');
  const blankOrder = await createOrder(t21Col.id, orderFmt, idOf, 'No quantity', null);
  let t21Count = 0;
  const SAVE_FORMULA = 'mutation($id:String!,$input:FormulaInput!) { saveCollectionFormula(collectionId:$id,input:$input) { formulas { id name } } }';
  const CALCULATE = 'query($id:String!,$formulaId:String!,$entryId:String!) { calculateCollectionFormula(collectionId:$id,formulaId:$formulaId,entryId:$entryId) { value unit missing } }';
  const saveT21 = async (expression) => { const name = `T21 ${++t21Count}`; return (await gql(SAVE_FORMULA, { id: t21Col.id, input: { name, formatId: orderFmt.id, expression: JSON.stringify(expression) } })).saveCollectionFormula.formulas.find((item) => item.name === name).id; };
  const refusedT21 = (expression) => gql(SAVE_FORMULA, { id: t21Col.id, input: { name: `T21 refused ${++t21Count}`, formatId: orderFmt.id, expression: JSON.stringify(expression) } }, token, true);
  const evalT21 = async (expression, entryId = highOrder) => (await gql(CALCULATE, { id: t21Col.id, formulaId: await saveT21(expression), entryId })).calculateCollectionFormula;
  const failsT21 = async (expression, entryId = highOrder) => gql(CALCULATE, { id: t21Col.id, formulaId: await saveT21(expression), entryId }, token, true);
  const multiplyBy = (left, right) => ({ kind: 'operation', operator: 'MULTIPLY', args: [left, right] });

  // IF(quantity > 5; price * 0.8; price), boundary excluded, missing stays missing
  const discount = await saveT21(iif(cmp('GT', t21Field('Quantity'), num('5')), multiplyBy(t21Field('Price'), num('0.8')), t21Field('Price')));
  const discountOn = async (entryId) => (await gql(CALCULATE, { id: t21Col.id, formulaId: discount, entryId })).calculateCollectionFormula;
  assert.deepEqual({ ...(await discountOn(highOrder)) }, { value: '80', unit: 'EUR', missing: null });
  assert.deepEqual({ ...(await discountOn(lowOrder)) }, { value: '100', unit: 'EUR', missing: null });
  const blankDiscount = await discountOn(blankOrder);
  assert.equal(blankDiscount.value, null);
  assert.ok(blankDiscount.missing);

  // The branch not taken is never evaluated
  const guarded = iif(cmp('GT', t21Field('Quantity'), num('5')), num('1'), { kind: 'operation', operator: 'DIVIDE', args: [num('1'), num('0')] });
  assert.equal((await evalT21(guarded)).value, '1');
  assert.match(await failsT21(guarded, lowOrder), /divide by zero/i);

  // Comparison operators, including conversion between compatible units
  for (const [operator, left, right, expected] of [['EQ', '2', '2.0', '1'], ['EQ', '2', '3', '0'], ['NEQ', '2', '3', '1'], ['NEQ', '2', '2', '0'], ['LT', '1.5', '2', '1'], ['LT', '2', '2', '0'], ['LTE', '2', '2', '1'], ['LTE', '3', '2', '0'], ['GT', '-1', '-2', '1'], ['GT', '2', '2', '0'], ['GTE', '2', '2', '1'], ['GTE', '1', '2', '0']]) {
    assert.equal((await evalT21(yesNo(cmp(operator, num(left), num(right))))).value, expected, `${left} ${operator} ${right}`);
  }
  assert.equal((await evalT21(yesNo(cmp('EQ', num('1', 'km'), num('1000', 'm'))))).value, '1');
  assert.equal((await evalT21(yesNo(cmp('GT', num('1', 'km'), num('999', 'm'))))).value, '1');

  // Incompatible units: refused on save when declared, during evaluation otherwise
  assert.match(await refusedT21(yesNo(cmp('GT', num('1', 'EUR'), num('1', 'km')))), /incompatible units/);
  assert.match(await refusedT21(yesNo(cmp('EQ', num('1', 'EUR'), num('1', 'USD')))), /dated rate/);
  assert.match(await refusedT21(yesNo(cmp('GT', t21Field('Price'), num('5')))), /incompatible units/);
  assert.match(await failsT21(yesNo(cmp('GT', { kind: 'abs', value: t21Field('Price') }, { kind: 'abs', value: num('1', 'km') }))), /incompatible units/);

  // Logic, short-circuit and three-valued handling of missing values
  const missingTest = cmp('GT', t21Field('Quantity'), num('0'));
  for (const [condition, expected] of [[logical('AND', yes, yes), '1'], [logical('AND', yes, no), '0'], [logical('OR', no, yes), '1'], [logical('OR', no, no), '0'], [{ kind: 'not', arg: no }, '1'], [{ kind: 'not', arg: yes }, '0'], [logical('AND', no, missingTest), '0'], [logical('OR', yes, missingTest), '1']]) {
    assert.equal((await evalT21(yesNo(condition), blankOrder)).value, expected, JSON.stringify(condition));
  }
  for (const condition of [logical('AND', yes, missingTest), logical('OR', no, missingTest), { kind: 'not', arg: missingTest }]) {
    assert.ok((await evalT21(yesNo(condition), blankOrder)).missing, JSON.stringify(condition));
  }
  assert.equal((await evalT21(yesNo(logical('OR', yes, cmp('GT', { kind: 'abs', value: num('1', 'EUR') }, { kind: 'abs', value: num('1', 'km') }))))).value, '1', 'OR stops at the first true condition');

  // MIN and MAX keep the unit of the selected quantity
  const euros = [num('10', 'EUR'), num('4', 'EUR'), num('15', 'EUR')];
  assert.deepEqual({ ...(await evalT21({ kind: 'min', args: euros })) }, { value: '4', unit: 'EUR', missing: null });
  assert.deepEqual({ ...(await evalT21({ kind: 'max', args: euros })) }, { value: '15', unit: 'EUR', missing: null });
  assert.deepEqual({ ...(await evalT21({ kind: 'min', args: [num('1', 'km'), num('500', 'm')] })) }, { value: '500', unit: 'm', missing: null });
  assert.deepEqual({ ...(await evalT21({ kind: 'max', args: [num('1', 'km'), num('500', 'm')] })) }, { value: '1', unit: 'km', missing: null });
  assert.ok((await evalT21({ kind: 'min', args: [t21Field('Quantity'), num('1')] }, blankOrder)).missing);
  await refusedT21({ kind: 'min', args: [num('1')] });
  assert.match(await refusedT21({ kind: 'max', args: [num('1', 'EUR'), num('1', 'km')] }), /incompatible units/);

  // ABS, FLOOR, CEIL
  assert.equal((await evalT21({ kind: 'abs', value: num('-12.5') })).value, '12.5');
  assert.equal((await evalT21({ kind: 'abs', value: num('12.5') })).value, '12.5');
  for (const [kind, input, expected] of [['floor', '3.7', '3'], ['ceil', '3.2', '4'], ['floor', '-3.2', '-4'], ['ceil', '-3.7', '-3'], ['floor', '5', '5'], ['ceil', '5', '5'], ['floor', '-5', '-5'], ['ceil', '-5', '-5'], ['ceil', '0.5', '1'], ['floor', '-0.5', '-1'], ['ceil', '-0.5', '0']]) {
    assert.equal((await evalT21({ kind, value: num(input) })).value, expected, `${kind}(${input})`);
  }
  assert.deepEqual({ ...(await evalT21({ kind: 'floor', value: num('3.7', 'kg') })) }, { value: '3', unit: 'kg', missing: null });

  // MODULO: exact on decimals, sign of the divisor, converted to the dividend unit
  for (const [left, right, expected] of [['10', '3', '1'], ['7.5', '2', '1.5'], ['-7', '3', '2'], ['7', '-3', '-2'], ['-7', '-3', '-1'], ['9', '3', '0'], ['0.3', '0.1', '0']]) {
    assert.equal((await evalT21({ kind: 'modulo', left: num(left), right: num(right) })).value, expected, `${left} mod ${right}`);
  }
  assert.deepEqual({ ...(await evalT21({ kind: 'modulo', left: num('1.5', 'km'), right: num('400', 'm') })) }, { value: '0.3', unit: 'km', missing: null });
  assert.match(await failsT21({ kind: 'modulo', left: num('1'), right: num('0') }), /divide by zero/i);
  assert.match(await refusedT21({ kind: 'modulo', left: num('1', 'EUR'), right: num('1', 'km') }), /incompatible units/);

  // Static validation: unknown shapes, complexity and cycles through conditions
  assert.match(await refusedT21(iif({ kind: 'unknown' }, num('1'), num('0'))), /condition/i);
  assert.match(await refusedT21(yesNo(cmp('ALMOST', num('1'), num('1')))), /comparison/i);
  assert.match(await refusedT21(yesNo(logical('AND', ...Array.from({ length: 70 }, () => yes)))), /too complex/);
  const inner = await saveT21(num('1'));
  const outer = await saveT21(iif(cmp('GT', { kind: 'formula', formulaId: inner }, num('0')), num('1'), num('0')));
  assert.match(await gql('mutation($id:String!,$formulaId:String!,$input:FormulaInput!) { saveCollectionFormula(collectionId:$id,formulaId:$formulaId,input:$input) { id } }', { id: t21Col.id, formulaId: inner, input: { name: `T21 ${t21Count - 1}`, formatId: orderFmt.id, expectedVersion: 1, expression: JSON.stringify({ kind: 'formula', formulaId: outer }) } }, token, true), /cycle/i);

  // Copies and domain packages rewrite identifiers nested in conditions
  const nestedSource = (await gql('mutation($input:CreateCollectionInput!) { createCollection(input:$input) { id formats { id name fields { id name } } } }', { input: { name: 'T21 Source', formats: t21Formats } })).createCollection;
  ids.push(nestedSource.id);
  const sourceFmt = nestedSource.formats[0];
  const nested = iif(cmp('GT', { kind: 'field', fieldId: idOf(sourceFmt, 'Quantity') }, num('5')), multiplyBy({ kind: 'field', fieldId: idOf(sourceFmt, 'Price') }, num('0.8')), { kind: 'field', fieldId: idOf(sourceFmt, 'Price') });
  await gql(SAVE_FORMULA, { id: nestedSource.id, input: { name: 'Discount', formatId: sourceFmt.id, expression: JSON.stringify(nested) } });
  const calculateDiscountIn = async (collectionId) => {
    const installed = (await gql('query { collectionsList { id formulas { id name formatId } formats { id name fields { id name } } } }')).collectionsList.find((item) => item.id === collectionId);
    const format = installed.formats.find((item) => item.name === 'Order');
    const entryId = await createOrder(collectionId, format, idOf, 'Copied high', '6');
    return (await gql(CALCULATE, { id: collectionId, formulaId: installed.formulas.find((item) => item.name === 'Discount' && item.formatId === format.id).id, entryId })).calculateCollectionFormula;
  };
  const copyDestination = (await gql('mutation($input:CreateCollectionInput!) { createCollection(input:$input) { id } }', { input: { name: 'T21 Copy', formats: [{ name: 'General', color: '#F4F0FF', fields: [{ name: 'Title', kind: 'TITLE' }] }] } })).createCollection;
  ids.push(copyDestination.id);
  await gql('mutation($formatId:String!,$targetCollectionId:String!) { copyCollectionDataFormat(formatId:$formatId,targetCollectionId:$targetCollectionId,withEntries:false) { copiedEntries } }', { formatId: sourceFmt.id, targetCollectionId: copyDestination.id });
  assert.deepEqual({ ...(await calculateDiscountIn(copyDestination.id)) }, { value: '80', unit: 'EUR', missing: null });
  const packaged = (await gql('query($id:String!,$input:DomainPackageExportInput!) { exportDomainPackage(collectionId:$id,input:$input,language:"en") { packageJson warnings } }', { id: nestedSource.id, input: { packageId: 'smoke.t21', version: '1.0.0', name: 'T21', author: 'Smoke', license: 'CC-BY-4.0' } })).exportDomainPackage;
  assert.deepEqual(packaged.warnings, []);
  const packageInstall = (await gql('mutation($json:String!) { installDomainPackage(packageJson:$json,collectionName:"T21 Installed",language:"en") { collectionId } }', { json: packaged.packageJson })).installDomainPackage;
  ids.push(packageInstall.collectionId);
  assert.deepEqual({ ...(await calculateDiscountIn(packageInstall.collectionId)) }, { value: '80', unit: 'EUR', missing: null });

  // T21/2 — Date differences, shifts, components and duration conversion
  const eventFormats = [{ name: 'Event', color: '#FFF5EB', fields: [{ name: 'Label', kind: 'TITLE' }, { name: 'Start', kind: 'DATE' }, { name: 'End', kind: 'DATE' }, { name: 'At', kind: 'DATETIME' }, { name: 'Length', kind: 'DURATION' }, { name: 'Offset', kind: 'NUMBER' }, { name: 'Weight', kind: 'NUMBER', unit: 'kg' }] }];
  const CREATE_COLLECTION = 'mutation($input:CreateCollectionInput!) { createCollection(input:$input) { id formats { id name fields { id name } } } }';
  const CALCULATE_DATE = 'query($id:String!,$formulaId:String!,$entryId:String!) { calculateCollectionFormula(collectionId:$id,formulaId:$formulaId,entryId:$entryId) { value unit dimension missing } }';
  const datesCol = (await gql(CREATE_COLLECTION, { input: { name: 'T21 Dates', formats: eventFormats } })).createCollection;
  ids.push(datesCol.id);
  const eventFmt = datesCol.formats[0];
  const createEvent = async (collectionId, format, values) => (await gql('mutation($id:String!,$input:SaveEntryInput!) { createEntry(collectionId:$id,input:$input) { id } }', { id: collectionId, input: { formatId: format.id, values: Object.entries(values).map(([name, value]) => ({ fieldId: idOf(format, name), value })) } })).createEntry.id;
  const fullEvent = await createEvent(datesCol.id, eventFmt, { Label: 'Full', Start: '2026-01-31', End: '2026-03-01', At: '2026-03-15T10:30:00Z', Length: '2:30', Offset: '-31', Weight: '2' });
  const blankEvent = await createEvent(datesCol.id, eventFmt, { Label: 'Blank' });
  const dateField = (name) => ({ kind: 'dateField', fieldId: idOf(eventFmt, name) });
  const day = (value) => ({ kind: 'dateLiteral', value });
  const diff = (unit, end, start) => ({ kind: 'dateDiff', unit, end, start });
  const addDays = (date, days) => ({ kind: 'addDays', date, days });
  const part = (name, date) => ({ kind: 'datePart', part: name, date });
  const durationField = (name) => ({ kind: 'durationField', fieldId: idOf(eventFmt, name) });
  const durationIn = (unit, duration) => ({ kind: 'durationIn', unit, duration });
  let t22Count = 0;
  const saveDate = async (expression) => { const name = `T22 ${++t22Count}`; return (await gql(SAVE_FORMULA, { id: datesCol.id, input: { name, formatId: eventFmt.id, expression: JSON.stringify(expression) } })).saveCollectionFormula.formulas.find((item) => item.name === name).id; };
  const refusedDate = (expression) => gql(SAVE_FORMULA, { id: datesCol.id, input: { name: `T22 refused ${++t22Count}`, formatId: eventFmt.id, expression: JSON.stringify(expression) } }, token, true);
  const evalDate = async (expression, entryId = fullEvent) => ({ ...(await gql(CALCULATE_DATE, { id: datesCol.id, formulaId: await saveDate(expression), entryId })).calculateCollectionFormula });
  const quantityOf = (value, unit = null, dimension = null) => ({ value, unit, dimension, missing: null });
  const dateOf = (value) => ({ value, unit: null, dimension: 'DATE', missing: null });

  // DIFF_JOURS, DIFF_HEURES, DIFF_MOIS
  assert.deepEqual(await evalDate(diff('DAYS', dateField('End'), dateField('Start'))), quantityOf('29', 'd', 'TIME'));
  assert.deepEqual(await evalDate(diff('DAYS', dateField('Start'), dateField('End'))), quantityOf('-29', 'd', 'TIME'));
  assert.deepEqual(await evalDate(diff('HOURS', day('2026-03-15T12:00:00Z'), dateField('At'))), quantityOf('1.5', 'h', 'TIME'));
  assert.deepEqual(await evalDate(diff('HOURS', day('2026-03-15T12:00:00+02:00'), day('2026-03-15T10:00:00Z'))), quantityOf('0', 'h', 'TIME'));
  for (const [end, start, expected] of [['2026-03-01', '2026-01-31', '1'], ['2026-02-28', '2026-01-31', '0'], ['2026-03-31', '2026-01-31', '2'], ['2026-03-20', '2025-01-15', '14'], ['2025-01-15', '2026-03-20', '-14'], ['2026-01-01', '2026-01-01', '0'], ['2026-01-31', '2026-02-28', '0'], ['2026-02-15T09:00:00Z', '2026-01-15T10:00:00Z', '0'], ['2026-02-15T10:00:00Z', '2026-01-15T10:00:00Z', '1']]) {
    assert.deepEqual(await evalDate(diff('MONTHS', day(end), day(start))), quantityOf(expected), `months ${start} to ${end}`);
  }

  // AJOUTER_JOURS with negative shifts, field amounts, durations and date-time values
  assert.deepEqual(await evalDate(addDays(dateField('Start'), num('30'))), dateOf('2026-03-02'));
  assert.deepEqual(await evalDate(addDays(dateField('End'), { kind: 'field', fieldId: idOf(eventFmt, 'Offset') })), dateOf('2026-01-29'));
  assert.deepEqual(await evalDate(addDays(day('2028-02-28'), num('1'))), dateOf('2028-02-29'));
  assert.deepEqual(await evalDate(addDays(day('2026-01-01'), num('-1'))), dateOf('2025-12-31'));
  assert.deepEqual(await evalDate(addDays(day('2026-01-01'), num('48', 'h'))), dateOf('2026-01-03'));
  assert.deepEqual(await evalDate(addDays(dateField('At'), num('1'))), dateOf('2026-03-16T10:30:00.000Z'));
  assert.deepEqual(await evalDate(addDays(dateField('Start'), diff('DAYS', dateField('End'), dateField('Start')))), dateOf('2026-03-01'));

  // DEBUT_MOIS and FIN_MOIS, leap years and date-time input
  for (const [kind, input, expected] of [['startOfMonth', '2026-03-17', '2026-03-01'], ['endOfMonth', '2028-02-15', '2028-02-29'], ['endOfMonth', '2026-02-15', '2026-02-28'], ['endOfMonth', '2026-12-10', '2026-12-31'], ['startOfMonth', '2026-03-15T10:30:00Z', '2026-03-01'], ['endOfMonth', '2026-03-15T10:30:00Z', '2026-03-31']]) {
    assert.deepEqual(await evalDate({ kind, date: day(input) }), dateOf(expected), `${kind} ${input}`);
  }

  // ANNEE, MOIS, JOUR, JOUR_SEMAINE (ISO: Monday 1, Sunday 7)
  for (const [name, input, expected] of [['YEAR', '2026-03-01', '2026'], ['MONTH', '2026-03-01', '3'], ['DAY', '2026-03-01', '1'], ['WEEKDAY', '2026-03-01', '7'], ['WEEKDAY', '2026-03-02', '1'], ['WEEKDAY', '2026-01-01', '4'], ['MONTH', '2026-12-31', '12']]) {
    assert.deepEqual(await evalDate(part(name, day(input))), quantityOf(expected), `${name} ${input}`);
  }
  assert.equal((await evalDate(part('MONTH', addDays(dateField('End'), num('-1'))))).value, '2');
  assert.equal((await evalDate(part('YEAR', { kind: 'endOfMonth', date: dateField('At') }))).value, '2026');
  assert.equal((await evalDate(iif(cmp('EQ', part('WEEKDAY', dateField('End')), num('7')), num('1'), num('0')))).value, '1');
  assert.equal((await evalDate(iif(cmp('GT', diff('DAYS', dateField('End'), dateField('Start')), num('28', 'd')), num('1'), num('0')))).value, '1');

  // DUREE_EN_MINUTES, DUREE_EN_HEURES
  assert.deepEqual(await evalDate(durationIn('MINUTES', durationField('Length'))), quantityOf('150', 'min', 'TIME'));
  assert.deepEqual(await evalDate(durationIn('HOURS', durationField('Length'))), quantityOf('2.5', 'h', 'TIME'));
  assert.deepEqual(await evalDate(durationIn('MINUTES', num('2', 'h'))), quantityOf('120', 'min', 'TIME'));
  assert.deepEqual(await evalDate(durationIn('HOURS', diff('DAYS', dateField('End'), dateField('Start')))), quantityOf('696', 'h', 'TIME'));

  // Missing, unreadable or out-of-range dates give an absent result
  const absentCases = [diff('DAYS', dateField('End'), dateField('Start')), diff('HOURS', dateField('At'), day('2026-01-01')), diff('MONTHS', day('2026-01-01'), dateField('Start')), addDays(dateField('Start'), num('1')), { kind: 'startOfMonth', date: dateField('Start') }, { kind: 'endOfMonth', date: dateField('Start') }, part('YEAR', dateField('Start')), part('MONTH', dateField('Start')), part('DAY', dateField('Start')), part('WEEKDAY', dateField('Start')), durationIn('MINUTES', durationField('Length')), durationIn('HOURS', durationField('Length'))];
  for (const expression of absentCases) {
    const absent = await evalDate(expression, blankEvent);
    assert.equal(absent.value, null, JSON.stringify(expression));
    assert.ok(absent.missing, JSON.stringify(expression));
  }
  assert.ok((await evalDate(addDays(dateField('Start'), { kind: 'field', fieldId: idOf(eventFmt, 'Offset') }), await createEvent(datesCol.id, eventFmt, { Label: 'No shift', Start: '2026-01-01' }))).missing);
  assert.ok((await evalDate(addDays(day('9999-12-31'), num('1')))).missing);
  assert.ok((await evalDate(addDays(day('2026-01-01'), num('99999999999')))).missing);
  const rawEntries = mongoose.connection.collection('entries');
  const corrupt = async (entryId, fieldName, patch) => rawEntries.updateOne({ _id: new mongoose.Types.ObjectId(entryId), 'values.fieldId': idOf(eventFmt, fieldName) }, { $set: Object.fromEntries(Object.entries(patch).map(([key, value]) => [`values.$.${key}`, value])) });
  for (const stored of ['2026-02-31', 'not-a-date', '2026-13-01', '']) {
    const damaged = await createEvent(datesCol.id, eventFmt, { Label: `Damaged ${stored}`, Start: '2026-01-31' });
    await corrupt(damaged, 'Start', { value: stored });
    assert.ok((await evalDate(part('YEAR', dateField('Start')), damaged)).missing, stored);
    assert.ok((await evalDate(diff('DAYS', day('2026-03-01'), dateField('Start')), damaged)).missing, stored);
  }
  const damagedLength = await createEvent(datesCol.id, eventFmt, { Label: 'Damaged duration', Length: '1:00' });
  await corrupt(damagedLength, 'Length', { durationSeconds: 1.5 });
  assert.ok((await evalDate(durationIn('MINUTES', durationField('Length')), damagedLength)).missing);

  // Refused on save, or during evaluation when the value depends on the entry
  assert.match(await refusedDate(part('YEAR', { kind: 'dateField', fieldId: idOf(eventFmt, 'Offset') })), /date field/);
  assert.match(await refusedDate(part('YEAR', day('2026-02-31'))), /valid date/);
  assert.match(await refusedDate(part('CENTURY', day('2026-01-01'))), /weekday/);
  assert.match(await refusedDate(diff('YEARS', day('2026-01-01'), day('2026-01-02'))), /months/);
  assert.match(await refusedDate({ kind: 'nextMonday', date: day('2026-01-01') }), /Unknown formula operation/);
  assert.match(await refusedDate(addDays({ kind: 'number', value: '1' }, num('1'))), /Unknown date operation/);
  assert.match(await refusedDate(addDays(day('2026-01-01'), num('1.5'))), /whole number/);
  assert.match(await refusedDate(addDays(day('2026-01-01'), { kind: 'field', fieldId: idOf(eventFmt, 'Weight') })), /plain number or a duration/);
  assert.match(await refusedDate({ kind: 'durationField', fieldId: idOf(eventFmt, 'Offset') }), /duration field/);
  assert.match(await refusedDate(durationIn('MINUTES', num('90'))), /duration/);
  assert.match(await refusedDate(durationIn('DAYS', num('1', 'h'))), /minutes or hours/);
  assert.match(await refusedDate({ kind: 'operation', operator: 'ADD', args: [day('2026-01-01'), num('1')] }), /gives a date/);
  const fractionalShift = await createEvent(datesCol.id, eventFmt, { Label: 'Half day', Start: '2026-01-01', Offset: '1.5' });
  const shiftFormula = await saveDate(addDays(dateField('Start'), { kind: 'field', fieldId: idOf(eventFmt, 'Offset') }));
  assert.match(await gql(CALCULATE_DATE, { id: datesCol.id, formulaId: shiftFormula, entryId: fractionalShift }, token, true), /whole number/);
  const dateResultFormula = await saveDate(addDays(day('2026-01-01'), num('1')));
  assert.match(await refusedDate({ kind: 'formula', formulaId: dateResultFormula }), /gives a date/);
  assert.match(await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { rows { value } } }', { id: datesCol.id, input: { formatId: eventFmt.id, formulaId: dateResultFormula, groupBy: 'NONE', operation: 'SUM', measureKind: 'EVENT' } }, token, true), /gives a date/);
  const durationAnalysis = await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { unit skippedMissingCount rows { value } } }', { id: datesCol.id, input: { formatId: eventFmt.id, formulaId: await saveDate(durationIn('MINUTES', durationField('Length'))), groupBy: 'NONE', operation: 'SUM', measureKind: 'EVENT' } });
  assert.equal(durationAnalysis.analyseCollection.unit, 'min');
  assert.equal(durationAnalysis.analyseCollection.rows[0].value, '150');

  // Copies and domain packages rewrite identifiers nested in date expressions
  const datesSource = (await gql(CREATE_COLLECTION, { input: { name: 'T22 Source', formats: eventFormats } })).createCollection;
  ids.push(datesSource.id);
  const datesSourceFmt = datesSource.formats[0];
  const sourceDate = (name) => ({ kind: 'dateField', fieldId: idOf(datesSourceFmt, name) });
  for (const [name, expression] of [['Span', diff('DAYS', sourceDate('End'), addDays(sourceDate('Start'), num('1')))], ['Due', addDays({ kind: 'endOfMonth', date: sourceDate('Start') }, num('1'))], ['Minutes', durationIn('MINUTES', { kind: 'durationField', fieldId: idOf(datesSourceFmt, 'Length') })]]) {
    await gql(SAVE_FORMULA, { id: datesSource.id, input: { name, formatId: datesSourceFmt.id, expression: JSON.stringify(expression) } });
  }
  const assertDateFormulasIn = async (collectionId) => {
    const target = (await gql('query { collectionsList { id formulas { id name formatId } formats { id name fields { id name } } } }')).collectionsList.find((item) => item.id === collectionId);
    const format = target.formats.find((item) => item.name === 'Event');
    const entryId = await createEvent(collectionId, format, { Label: 'Copied', Start: '2026-01-31', End: '2026-03-01', Length: '1:15' });
    const resultOf = async (name) => ({ ...(await gql(CALCULATE_DATE, { id: collectionId, formulaId: target.formulas.find((item) => item.name === name && item.formatId === format.id).id, entryId })).calculateCollectionFormula });
    assert.deepEqual(await resultOf('Span'), quantityOf('28', 'd', 'TIME'));
    assert.deepEqual(await resultOf('Due'), dateOf('2026-02-01'));
    assert.deepEqual(await resultOf('Minutes'), quantityOf('75', 'min', 'TIME'));
  };
  const datesCopy = (await gql(CREATE_COLLECTION, { input: { name: 'T22 Copy', formats: [{ name: 'General', color: '#F4F0FF', fields: [{ name: 'Title', kind: 'TITLE' }] }] } })).createCollection;
  ids.push(datesCopy.id);
  await gql('mutation($formatId:String!,$targetCollectionId:String!) { copyCollectionDataFormat(formatId:$formatId,targetCollectionId:$targetCollectionId,withEntries:false) { copiedEntries } }', { formatId: datesSourceFmt.id, targetCollectionId: datesCopy.id });
  await assertDateFormulasIn(datesCopy.id);
  const datesPackage = (await gql('query($id:String!,$input:DomainPackageExportInput!) { exportDomainPackage(collectionId:$id,input:$input,language:"en") { packageJson warnings } }', { id: datesSource.id, input: { packageId: 'smoke.t22', version: '1.0.0', name: 'T22', author: 'Smoke', license: 'CC-BY-4.0' } })).exportDomainPackage;
  assert.deepEqual(datesPackage.warnings, []);
  const datesInstall = (await gql('mutation($json:String!) { installDomainPackage(packageJson:$json,collectionName:"T22 Installed",language:"en") { collectionId } }', { json: datesPackage.packageJson })).installDomainPackage;
  ids.push(datesInstall.collectionId);
  await assertDateFormulasIn(datesInstall.collectionId);

  // T21/3 — Text functions
  const noteFormats = [{ name: 'Note', color: '#EDF9F3', fields: [{ name: 'Label', kind: 'TITLE' }, { name: 'Body', kind: 'TEXT' }, { name: 'Other', kind: 'TEXT' }, { name: 'Site', kind: 'LINK' }, { name: 'Count', kind: 'NUMBER' }, { name: 'Amount', kind: 'NUMBER', unit: 'EUR' }, { name: 'When', kind: 'DATE' }] }];
  const textCol = (await gql(CREATE_COLLECTION, { input: { name: 'T21 Texts', formats: noteFormats } })).createCollection;
  ids.push(textCol.id);
  const noteFmt = textCol.formats[0];
  const fullNote = await createEvent(textCol.id, noteFmt, { Label: 'Bonjour', Body: 'jean-pierre', Other: 'Martin', Site: 'https://example.com/page', Count: '3', Amount: '19.9', When: '2026-03-01' });
  const blankNote = await createEvent(textCol.id, noteFmt, { Label: 'Only a label' });
  const textField = (name) => ({ kind: 'textField', fieldId: idOf(noteFmt, name) });
  const lit = (value) => ({ kind: 'textLiteral', value });
  const concat = (...args) => ({ kind: 'concat', args });
  const substring = (text, start, length) => ({ kind: 'substring', text, start, length });
  const formatted = (value, pattern, locale) => ({ kind: 'formatText', value, pattern, ...(locale ? { locale } : {}) });
  const noteNumber = (name) => ({ kind: 'field', fieldId: idOf(noteFmt, name) });
  const noteDate = (name) => ({ kind: 'dateField', fieldId: idOf(noteFmt, name) });
  let t23Count = 0;
  const saveText = async (expression) => { const name = `T23 ${++t23Count}`; return (await gql(SAVE_FORMULA, { id: textCol.id, input: { name, formatId: noteFmt.id, expression: JSON.stringify(expression) } })).saveCollectionFormula.formulas.find((item) => item.name === name).id; };
  const refusedText = (expression) => gql(SAVE_FORMULA, { id: textCol.id, input: { name: `T23 refused ${++t23Count}`, formatId: noteFmt.id, expression: JSON.stringify(expression) } }, token, true);
  const evalText = async (expression, entryId = fullNote) => ({ ...(await gql(CALCULATE_DATE, { id: textCol.id, formulaId: await saveText(expression), entryId })).calculateCollectionFormula });
  const textOf = (value) => ({ value, unit: null, dimension: 'TEXT', missing: null });
  const plainNumber = (value) => ({ value, unit: null, dimension: null, missing: null });

  // MAJUSCULE, MINUSCULE, PROPRE, on every accepted source
  assert.deepEqual(await evalText({ kind: 'upper', text: lit('hello école') }), textOf('HELLO ÉCOLE'));
  assert.deepEqual(await evalText({ kind: 'lower', text: lit('HELLO ÉCOLE') }), textOf('hello école'));
  assert.deepEqual(await evalText({ kind: 'upper', text: textField('Label') }), textOf('BONJOUR'));
  assert.deepEqual(await evalText({ kind: 'upper', text: textField('Site') }), textOf('HTTPS://EXAMPLE.COM/PAGE'));
  for (const [input, expected] of [['hELLO wORLD', 'Hello World'], ['jean-pierre', 'Jean-Pierre'], ["l'école don't", "L'école Don't"], ['été à paris', 'Été À Paris'], ['3 petits chats', '3 Petits Chats'], ['', '']]) {
    assert.deepEqual(await evalText({ kind: 'proper', text: lit(input) }), textOf(expected), `proper ${input}`);
  }

  // CONCATENER, keeping separators and propagating a missing part
  assert.deepEqual(await evalText(concat(textField('Body'), lit(' '), textField('Other'))), textOf('jean-pierre Martin'));
  assert.deepEqual(await evalText(concat(lit(''), lit(''))), textOf(''));
  const missingJoin = await evalText(concat(textField('Label'), textField('Body')), blankNote);
  assert.equal(missingJoin.value, null);
  assert.ok(missingJoin.missing);
  assert.match(await refusedText(concat(lit('alone'))), /at least two/);

  // LONGUEUR is a plain integer counted in visible characters
  for (const [input, expected] of [['École', '5'], ['', '0'], ['a b', '3'], ['👍🏽a', '2'], ['é', '1']]) {
    assert.deepEqual(await evalText({ kind: 'textLength', text: lit(input) }), plainNumber(expected), `length ${input}`);
  }
  assert.ok((await evalText({ kind: 'textLength', text: textField('Body') }, blankNote)).missing);
  assert.equal((await evalText(iif(cmp('GT', { kind: 'textLength', text: textField('Body') }, num('5')), num('1'), num('0')))).value, '1');
  const lengthAnalysis = await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { unit skippedMissingCount rows { value } } }', { id: textCol.id, input: { formatId: noteFmt.id, formulaId: await saveText({ kind: 'textLength', text: textField('Body') }), groupBy: 'NONE', operation: 'SUM', measureKind: 'EVENT' } });
  assert.equal(lengthAnalysis.analyseCollection.rows[0].value, '11');

  // SOUS_CHAINE counts from 1 and never splits a character
  for (const [text, start, length, expected] of [['Bonjour', '1', '3', 'Bon'], ['Bonjour', '4', '100', 'jour'], ['Bonjour', '7', '1', 'r'], ['Bonjour', '8', '2', ''], ['Bonjour', '99999999999', '1', ''], ['Bonjour', '2', '0', ''], ['Bonjour', '1', '99999999999999', 'Bonjour'], ['👍🏽ab', '1', '1', '👍🏽'], ['éa', '2', '1', 'a']]) {
    assert.deepEqual(await evalText(substring(lit(text), num(start), num(length))), textOf(expected), `substring ${text} ${start} ${length}`);
  }
  assert.deepEqual(await evalText(substring(textField('Label'), noteNumber('Count'), num('2'))), textOf('nj'));
  assert.ok((await evalText(substring(textField('Label'), noteNumber('Count'), num('2')), blankNote)).missing);
  assert.ok((await evalText(substring(textField('Body'), num('1'), num('2')), blankNote)).missing);
  for (const [start, length] of [[num('0'), num('1')], [num('1'), num('-1')], [num('1.5'), num('1')], [num('1', 'kg'), num('1')], [noteNumber('Amount'), num('1')]]) {
    assert.match(await refusedText(substring(lit('abc'), start, length)), /whole numbers/);
  }
  const zeroStart = await createEvent(textCol.id, noteFmt, { Label: 'Bonjour', Count: '0' });
  assert.match(await gql(CALCULATE_DATE, { id: textCol.id, formulaId: await saveText(substring(textField('Label'), noteNumber('Count'), num('1'))), entryId: zeroStart }, token, true), /whole numbers/);

  // TEXTE formats numbers and dates without running any user-supplied format code
  for (const [value, pattern, locale, expected] of [['1234.5', '#,##0.00', undefined, '1,234.50'], ['1234.5', '#,##0.00', 'fr', '1 234,50'], ['1234.5', '0.00', 'fr', '1234,50'], ['1234567', '#,##0', undefined, '1,234,567'], ['2.5', '0', undefined, '3'], ['-2.5', '0', undefined, '-3'], ['-0.004', '0.00', undefined, '0.00'], ['0.125', '0.00', undefined, '0.13'], ['7', '0.000', undefined, '7.000']]) {
    assert.deepEqual(await evalText(formatted(num(value), pattern, locale)), textOf(expected), `format ${value} ${pattern}`);
  }
  assert.deepEqual(await evalText(formatted(noteNumber('Amount'), '0.00')), textOf('19.90 EUR'));
  assert.deepEqual(await evalText(formatted(noteDate('When'), 'DD/MM/YYYY')), textOf('01/03/2026'));
  assert.deepEqual(await evalText(formatted({ kind: 'dateLiteral', value: '2026-03-15T10:30:05Z' }, 'YYYY-MM-DD HH:mm:ss')), textOf('2026-03-15 10:30:05'));
  assert.deepEqual(await evalText(formatted({ kind: 'endOfMonth', date: noteDate('When') }, 'DD.MM')), textOf('31.03'));
  assert.ok((await evalText(formatted(noteNumber('Amount'), '0.00'), blankNote)).missing);
  assert.ok((await evalText(formatted(noteDate('When'), 'YYYY'), blankNote)).missing);
  assert.match(await refusedText(formatted(num('1'), 'DD/MM/YYYY')), /number format/);
  assert.match(await refusedText(formatted(noteDate('When'), '0.00')), /date format/);
  assert.match(await refusedText(formatted(noteDate('When'), '<YYYY>')), /date format/);
  assert.match(await refusedText(formatted(noteDate('When'), '--')), /date format/);
  assert.match(await refusedText(formatted(num('1'), '0.00', 'de')), /English or French/);

  // A classification code is readable as text
  const expensesPilot = (await gql('query { domainPackagePilots(language:"en") { id packageJson } }')).domainPackagePilots.find((item) => item.id === 'brainy.expenses');
  const codedId = (await gql('mutation($json:String!) { installDomainPackage(packageJson:$json,collectionName:"T23 Codes",language:"en") { collectionId } }', { json: expensesPilot.packageJson })).installDomainPackage.collectionId;
  ids.push(codedId);
  const coded = (await gql('query { collectionsList { id formats { id fields { id kind } } codeLists { id codes { code active } } } }')).collectionsList.find((item) => item.id === codedId);
  const codedFormat = coded.formats.find((item) => item.fields.some((field) => field.kind === 'CODE'));
  const codeField = codedFormat.fields.find((field) => field.kind === 'CODE');
  const codeValue = coded.codeLists[0].codes.find((item) => item.active).code;
  const codedEntry = (await gql('mutation($id:String!,$input:SaveEntryInput!) { createEntry(collectionId:$id,input:$input) { id } }', { id: codedId, input: { formatId: codedFormat.id, values: [{ fieldId: codeField.id, value: codeValue }] } })).createEntry.id;
  const codedFormula = (await gql(SAVE_FORMULA, { id: codedId, input: { name: 'Code label', formatId: codedFormat.id, expression: JSON.stringify(concat(lit('#'), { kind: 'textField', fieldId: codeField.id })) } })).saveCollectionFormula.formulas.find((item) => item.name === 'Code label').id;
  assert.deepEqual({ ...(await gql(CALCULATE_DATE, { id: codedId, formulaId: codedFormula, entryId: codedEntry })).calculateCollectionFormula }, textOf(`#${codeValue}`));

  // Functions compose and types stay separate
  assert.deepEqual(await evalText({ kind: 'upper', text: concat(lit('total: '), formatted(num('2'), '0.0')) }), textOf('TOTAL: 2.0'));
  assert.deepEqual(await evalText({ kind: 'proper', text: substring(textField('Body'), num('1'), num('4')) }), textOf('Jean'));
  assert.match(await refusedText({ kind: 'upper', text: { kind: 'textField', fieldId: idOf(noteFmt, 'Count') } }), /text, title, code or link/);
  assert.match(await refusedText({ kind: 'upper', text: num('1') }), /Unknown text operation/);
  assert.match(await refusedText({ kind: 'operation', operator: 'ADD', args: [lit('1'), num('1')] }), /gives text/);
  assert.match(await refusedText(lit('x'.repeat(1001))), /at most 1000/);
  const textFormula = await saveText(lit('x'));
  assert.match(await refusedText({ kind: 'formula', formulaId: textFormula }), /gives text/);
  assert.match(await gql('query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { rows { value } } }', { id: textCol.id, input: { formatId: noteFmt.id, formulaId: textFormula, groupBy: 'NONE', operation: 'SUM', measureKind: 'EVENT' } }, token, true), /gives text/);

  // Copies and domain packages rewrite identifiers nested in text expressions and keep separators
  const textSource = (await gql(CREATE_COLLECTION, { input: { name: 'T23 Source', formats: noteFormats } })).createCollection;
  ids.push(textSource.id);
  const textSourceFmt = textSource.formats[0];
  const sourceText = (name) => ({ kind: 'textField', fieldId: idOf(textSourceFmt, name) });
  for (const [name, expression] of [['Full name', { kind: 'upper', text: concat(sourceText('Body'), lit(' '), sourceText('Other')) }], ['Slice', substring(sourceText('Label'), { kind: 'field', fieldId: idOf(textSourceFmt, 'Count') }, num('2'))], ['Stamp', formatted({ kind: 'dateField', fieldId: idOf(textSourceFmt, 'When') }, 'DD/MM/YYYY')], ['Size', { kind: 'textLength', text: sourceText('Other') }]]) {
    await gql(SAVE_FORMULA, { id: textSource.id, input: { name, formatId: textSourceFmt.id, expression: JSON.stringify(expression) } });
  }
  const assertTextFormulasIn = async (collectionId) => {
    const target = (await gql('query { collectionsList { id formulas { id name formatId } formats { id name fields { id name } } } }')).collectionsList.find((item) => item.id === collectionId);
    const format = target.formats.find((item) => item.name === 'Note');
    const entryId = await createEvent(collectionId, format, { Label: 'Bonjour', Body: 'ada', Other: 'lovelace', Count: '2', When: '2026-03-01' });
    const resultOf = async (name) => ({ ...(await gql(CALCULATE_DATE, { id: collectionId, formulaId: target.formulas.find((item) => item.name === name && item.formatId === format.id).id, entryId })).calculateCollectionFormula });
    assert.deepEqual(await resultOf('Full name'), textOf('ADA LOVELACE'));
    assert.deepEqual(await resultOf('Slice'), textOf('on'));
    assert.deepEqual(await resultOf('Stamp'), textOf('01/03/2026'));
    assert.deepEqual(await resultOf('Size'), plainNumber('8'));
  };
  const textCopy = (await gql(CREATE_COLLECTION, { input: { name: 'T23 Copy', formats: [{ name: 'General', color: '#F4F0FF', fields: [{ name: 'Title', kind: 'TITLE' }] }] } })).createCollection;
  ids.push(textCopy.id);
  await gql('mutation($formatId:String!,$targetCollectionId:String!) { copyCollectionDataFormat(formatId:$formatId,targetCollectionId:$targetCollectionId,withEntries:false) { copiedEntries } }', { formatId: textSourceFmt.id, targetCollectionId: textCopy.id });
  await assertTextFormulasIn(textCopy.id);
  const textPackage = (await gql('query($id:String!,$input:DomainPackageExportInput!) { exportDomainPackage(collectionId:$id,input:$input,language:"en") { packageJson warnings } }', { id: textSource.id, input: { packageId: 'smoke.t23', version: '1.0.0', name: 'T23', author: 'Smoke', license: 'CC-BY-4.0' } })).exportDomainPackage;
  assert.deepEqual(textPackage.warnings, []);
  const textInstall = (await gql('mutation($json:String!) { installDomainPackage(packageJson:$json,collectionName:"T23 Installed",language:"en") { collectionId } }', { json: textPackage.packageJson })).installDomainPackage;
  ids.push(textInstall.collectionId);
  await assertTextFormulasIn(textInstall.collectionId);

  console.log('analysis smoke passed: formulas, date differences, rounding, formula transfer, units, cycles, zero division, aggregate, filters, period comparison, access, book manual order, templates, links, URL duplicates, link import and 10005-entry analysis');
} finally {
  if (ownerId) {
    await mongoose.connection.collection('domainpackageinstalls').deleteMany({ ownerId });
    await mongoose.connection.collection('entrylinks').deleteMany({ ownerId });
    await mongoose.connection.collection('entries').deleteMany({ ownerId });
    await mongoose.connection.collection('collections').deleteMany({ ownerId });
    await mongoose.connection.collection('users').deleteOne({ _id: new mongoose.Types.ObjectId(ownerId) });
  }
  if (otherOwnerId) await mongoose.connection.collection('users').deleteOne({ _id: new mongoose.Types.ObjectId(otherOwnerId) });
  await mongoose.disconnect();
}
