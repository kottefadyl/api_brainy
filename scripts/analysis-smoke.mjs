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
  assert.equal(orderView.manualOrderFieldIds.length, 5);
  const bookEntry = async (formatName, title, order) => {
    const definition = book.formats.find((item) => item.name === formatName);
    return (await gql('mutation($id:String!,$input:SaveEntryInput!) { createEntry(collectionId:$id,input:$input) { id } }', { id: book.id, input: { formatId: definition.id, values: [{ fieldId: definition.fields.find((field) => field.kind === 'TITLE').id, value: title }, { fieldId: definition.fields.find((field) => field.kind === 'NUMBER').id, value: order }] } })).createEntry.id;
  };
  const secondChapter = await bookEntry('Chapter', 'Chapter two', '2');
  const firstScene = await bookEntry('Section', 'Scene one', '1.1');
  const firstChapter = await bookEntry('Chapter', 'Chapter one', '1');
  const manualPage = async (after) => (await gql('query($id:String!,$viewId:String!,$after:String) { collectionEntriesPage(collectionId:$id,first:1,viewId:$viewId,after:$after) { entries { id } nextCursor hasMore } }', { id: book.id, viewId: orderView.id, after })).collectionEntriesPage;
  const firstPage = await manualPage(null);
  const secondPage = await manualPage(firstPage.nextCursor);
  const thirdPage = await manualPage(secondPage.nextCursor);
  assert.deepEqual([firstPage.entries[0].id, secondPage.entries[0].id, thirdPage.entries[0].id], [firstChapter, firstScene, secondChapter]);
  const restoredBook = (await gql('mutation { createCollectionFromTemplate(templateId:"book",name:"Restored manuscript",language:"en") { id formats { id name fields { id name kind } } savedViews { id sort } } }')).createCollectionFromTemplate;
  ids.push(restoredBook.id);
  const restoredChapter = restoredBook.formats.find((item) => item.name === 'Chapter');
  const restoredScene = restoredBook.formats.find((item) => item.name === 'Section');
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
  assert.match(await gql('mutation($id:String!,$input:FormulaInput!) { saveCollectionFormula(collectionId:$id,input:$input) { formulas { id name } } }', { id: collection.id, input: { name: 'Bad unit', formatId: saleFormat.id, expression: JSON.stringify(incompatible) } }, token, true), /Cannot add incompatible units/);
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
  assert.match(await refusedT21(yesNo(cmp('GT', { kind: 'abs', value: t21Field('Price') }, { kind: 'abs', value: num('1', 'km') }))), /incompatible units/);

  // Logic, short-circuit and three-valued handling of missing values
  const missingTest = cmp('GT', t21Field('Quantity'), num('0'));
  for (const [condition, expected] of [[logical('AND', yes, yes), '1'], [logical('AND', yes, no), '0'], [logical('OR', no, yes), '1'], [logical('OR', no, no), '0'], [{ kind: 'not', arg: no }, '1'], [{ kind: 'not', arg: yes }, '0'], [logical('AND', no, missingTest), '0'], [logical('OR', yes, missingTest), '1']]) {
    assert.equal((await evalT21(yesNo(condition), blankOrder)).value, expected, JSON.stringify(condition));
  }
  for (const condition of [logical('AND', yes, missingTest), logical('OR', no, missingTest), { kind: 'not', arg: missingTest }]) {
    assert.ok((await evalT21(yesNo(condition), blankOrder)).missing, JSON.stringify(condition));
  }
  assert.equal((await evalT21(yesNo(logical('OR', yes, cmp('GT', { kind: 'operation', operator: 'DIVIDE', args: [num('1'), num('0')] }, num('1')))))).value, '1', 'OR stops at the first true condition');

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
  assert.match(await refusedDate(addDays({ kind: 'number', value: '1' }, num('1'))), /Expected a date but found a number/);
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
  assert.deepEqual(await evalText(formatted(noteNumber('Amount'), '0.00')), textOf('19.90'));
  assert.deepEqual(await evalText(concat(formatted(noteNumber('Amount'), '0.00'), lit(' €'))), textOf('19.90 €'));

  // UNITE gives the unit as text, and an empty text for a plain number
  assert.deepEqual(await evalText({ kind: 'unitOf', value: noteNumber('Amount') }), textOf('EUR'));
  assert.deepEqual(await evalText({ kind: 'unitOf', value: noteNumber('Count') }), textOf(''));
  assert.deepEqual(await evalText(concat(formatted(noteNumber('Amount'), '0.00'), lit(' '), { kind: 'unitOf', value: noteNumber('Amount') })), textOf('19.90 EUR'));
  assert.ok((await evalText({ kind: 'unitOf', value: noteNumber('Amount') }, blankNote)).missing);
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
  assert.match(await refusedText({ kind: 'upper', text: num('1') }), /Expected text but found a number/);
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

  // T21/4 — Multi-level relations, fallback values and aggregates over multiple references
  const ADD_FORMAT = 'mutation($id:String!,$input:CollectionFormatInput!) { addCollectionFormat(collectionId:$id,input:$input) { formats { id name fields { id name } } } }';
  const buildShop = async (name) => {
    const created = (await gql(CREATE_COLLECTION, { input: { name, formats: [{ name: 'Group', color: '#EEF5FF', objectModel: true, fields: [{ name: 'Name', kind: 'TITLE' }, { name: 'Rate', kind: 'NUMBER' }] }] } })).createCollection;
    ids.push(created.id);
    let formats = created.formats;
    const byName = (item) => formats.find((format) => format.name === item);
    const add = async (input) => { formats = (await gql(ADD_FORMAT, { id: created.id, input })).addCollectionFormat.formats; };
    const title = { name: 'Name', kind: 'TITLE' };
    const single = (fieldName, target, referenceMode = 'CURRENT') => ({ name: fieldName, kind: 'OBJECT_REF', targetObjectFormatId: byName(target).id, referenceMode });
    await add({ name: 'Category', color: '#EDF9F3', objectModel: true, fields: [title, single('Group', 'Group')] });
    await add({ name: 'Customer', color: '#FFF5EB', objectModel: true, fields: [title, { name: 'City', kind: 'TEXT' }] });
    await add({ name: 'Product', color: '#F4F0FF', objectModel: true, fields: [title, { name: 'Price', kind: 'NUMBER', unit: 'EUR' }, { name: 'Discount', kind: 'NUMBER', unit: 'EUR' }, single('Category', 'Category')] });
    await add({ name: 'Line', color: '#FFF0F4', objectModel: true, fields: [title, { name: 'Amount', kind: 'NUMBER', unit: 'EUR' }] });
    await add({ name: 'Order', color: '#EAF8FA', fields: [{ name: 'Title', kind: 'TITLE' }, single('Product', 'Product'), single('Frozen', 'Product', 'SNAPSHOT'), single('Customer', 'Customer'), { ...single('Lines', 'Line'), multiple: true }, { ...single('FrozenLines', 'Line', 'SNAPSHOT'), multiple: true }] });
    return { id: created.id, byName };
  };
  const refs = (...items) => JSON.stringify(items);
  const seedShop = async (collectionId, byName) => {
    const make = (name, values) => createEvent(collectionId, byName(name), values);
    const group = await make('Group', { Name: 'Standard', Rate: '20' });
    const category = await make('Category', { Name: 'Books', Group: refs(group) });
    const customer = await make('Customer', { Name: 'Ada', City: 'Paris' });
    const product = await make('Product', { Name: 'Novel', Price: '100', Category: refs(category) });
    const discounted = await make('Product', { Name: 'Atlas', Price: '100', Discount: '5', Category: refs(category) });
    const line1 = await make('Line', { Name: 'L1', Amount: '10' });
    const line2 = await make('Line', { Name: 'L2', Amount: '20.5' });
    const line3 = await make('Line', { Name: 'L3 without amount' });
    const order = await make('Order', { Title: 'Order', Product: refs(product), Frozen: refs(product), Customer: refs(customer), Lines: refs(line1, line2, line3), FrozenLines: refs(line1, line2) });
    return { group, category, customer, product, discounted, line1, line2, line3, order };
  };
  const shop = await buildShop('T21 Shop');
  const seeded = await seedShop(shop.id, shop.byName);
  const orderFormat = shop.byName('Order'), productFormat = shop.byName('Product'), categoryFormat = shop.byName('Category'), groupFormat = shop.byName('Group'), customerFormat = shop.byName('Customer'), lineFormat = shop.byName('Line');
  const blankOrderId = await createEvent(shop.id, orderFormat, { Title: 'No relations' });
  const discountedOrder = await createEvent(shop.id, orderFormat, { Title: 'Discounted', Product: refs(seeded.discounted) });
  const orderRef = (name) => idOf(orderFormat, name);
  const productPath = (name) => ({ kind: 'property', referenceFieldId: orderRef('Product'), propertyFieldId: idOf(productFormat, name) });
  const frozenPath = (name) => ({ kind: 'property', referenceFieldId: orderRef('Frozen'), propertyFieldId: idOf(productFormat, name) });
  const ratePath = { kind: 'property', referenceFieldId: orderRef('Product'), through: [idOf(productFormat, 'Category'), idOf(categoryFormat, 'Group')], propertyFieldId: idOf(groupFormat, 'Rate') };
  const cityPath = { kind: 'textProperty', referenceFieldId: orderRef('Customer'), propertyFieldId: idOf(customerFormat, 'City') };
  const related = (kind, field = 'Lines', property = 'Amount') => ({ kind, referenceFieldId: orderRef(field), ...(property ? { propertyFieldId: idOf(lineFormat, property) } : {}) });
  const coalesce = (...args) => ({ kind: 'coalesce', args });
  let t24Count = 0;
  const saveShop = async (expression) => { const name = `T24 ${++t24Count}`; return (await gql(SAVE_FORMULA, { id: shop.id, input: { name, formatId: orderFormat.id, expression: JSON.stringify(expression) } })).saveCollectionFormula.formulas.find((item) => item.name === name).id; };
  const refusedShop = (expression) => gql(SAVE_FORMULA, { id: shop.id, input: { name: `T24 refused ${++t24Count}`, formatId: orderFormat.id, expression: JSON.stringify(expression) } }, token, true);
  const calcShop = async (formulaId, entryId) => ({ ...(await gql(CALCULATE_DATE, { id: shop.id, formulaId, entryId })).calculateCollectionFormula });
  const evalShop = async (expression, entryId = seeded.order) => calcShop(await saveShop(expression), entryId);
  const euros2 = (value) => quantityOf(value, 'EUR', 'CURRENCY');

  // Navigation across several objects, in numbers and in text
  assert.deepEqual(await evalShop(ratePath), quantityOf('20'));
  assert.deepEqual(await evalShop(productPath('Price')), euros2('100'));
  assert.deepEqual(await evalShop(cityPath), textOf('Paris'));
  assert.deepEqual(await evalShop({ kind: 'upper', text: cityPath }), textOf('PARIS'));
  assert.deepEqual(await evalShop(multiplyBy(productPath('Price'), { kind: 'operation', operator: 'DIVIDE', args: [ratePath, num('100')] })), euros2('20'));
  assert.ok((await evalShop(ratePath, blankOrderId)).missing, 'an empty relation stays missing');

  // Fallback: a present value wins, an absent value or relation uses the fallback
  assert.deepEqual(await evalShop(coalesce(productPath('Discount'), num('0')), discountedOrder), euros2('5'));
  assert.deepEqual(await evalShop(coalesce(productPath('Discount'), num('0'))), euros2('0'));
  assert.deepEqual(await evalShop(coalesce(productPath('Discount'), num('0')), blankOrderId), euros2('0'));
  assert.deepEqual(await evalShop(coalesce(productPath('Discount'), num('7', 'EUR'))), euros2('7'));
  assert.deepEqual(await evalShop(coalesce(productPath('Discount'), frozenPath('Discount'), productPath('Price'))), euros2('100'));
  assert.deepEqual(await evalShop(coalesce(ratePath, num('0')), blankOrderId), quantityOf('0'));
  assert.deepEqual(await evalShop({ kind: 'operation', operator: 'SUBTRACT', args: [productPath('Price'), coalesce(productPath('Discount'), num('0'))] }), euros2('100'), 'the fallback zero takes the unit of the value it replaces');
  assert.deepEqual(await evalShop(coalesce(productPath('Price'), { kind: 'operation', operator: 'DIVIDE', args: [num('1', 'EUR'), num('0')] })), euros2('100'), 'a fallback that is not needed is not evaluated');
  assert.ok((await evalShop(coalesce(productPath('Discount'), productPath('Price')), blankOrderId)).missing);
  assert.deepEqual(await evalShop({ kind: 'coalesceText', args: [cityPath, lit('Unknown')] }), textOf('Paris'));
  assert.deepEqual(await evalShop({ kind: 'coalesceText', args: [cityPath, lit('Unknown')] }, blankOrderId), textOf('Unknown'));
  assert.match(await refusedShop(coalesce(productPath('Price'))), /at least one fallback/);
  assert.match(await refusedShop(coalesce(productPath('Price'), num('5'))), /incompatible units/);
  assert.match(await refusedShop(coalesce(productPath('Price'), num('5', 'km'))), /incompatible units/);

  // Aggregates over a multiple reference skip objects without the property
  assert.deepEqual(await evalShop(related('sumRelated')), euros2('30.5'));
  assert.deepEqual(await evalShop(related('avgRelated')), euros2('15.25'));
  assert.deepEqual(await evalShop(related('minRelated')), euros2('10'));
  assert.deepEqual(await evalShop(related('maxRelated')), euros2('20.5'));
  assert.deepEqual(await evalShop(related('countRelated', 'Lines', null)), quantityOf('3'));
  assert.deepEqual(await evalShop(related('countRelated')), quantityOf('2'));
  assert.deepEqual(await evalShop(related('countRelated', 'Lines', null), blankOrderId), quantityOf('0'));
  assert.ok((await evalShop(related('sumRelated'), blankOrderId)).missing, 'a total over nothing stays missing');
  assert.deepEqual(await evalShop(coalesce(related('sumRelated'), num('0')), blankOrderId), euros2('0'));
  assert.equal((await evalShop(iif(cmp('GT', related('sumRelated'), num('30', 'EUR')), num('1'), num('0')))).value, '1');
  assert.match(await refusedShop(iif(cmp('GT', related('sumRelated'), num('30', 'km')), num('1'), num('0'))), /incompatible units/);

  // The past stays intact: later changes reach CURRENT references only
  const frozenPrice = await saveShop(frozenPath('Price'));
  const currentPrice = await saveShop(productPath('Price'));
  const frozenDiscount = await saveShop(frozenPath('Discount'));
  const frozenDiscountOrZero = await saveShop(coalesce(frozenPath('Discount'), num('0')));
  const currentSum = await saveShop(related('sumRelated'));
  const frozenSum = await saveShop(related('sumRelated', 'FrozenLines'));
  const updateObject = (entryId, format, values) => gql('mutation($id:String!,$input:SaveEntryInput!) { updateEntry(id:$id,input:$input) { id } }', { id: entryId, input: { formatId: format.id, values: Object.entries(values).map(([name, value]) => ({ fieldId: idOf(format, name), value })) } });
  await updateObject(seeded.product, productFormat, { Name: 'Novel', Price: '200', Discount: '9', Category: refs(seeded.category) });
  await updateObject(seeded.line1, lineFormat, { Name: 'L1', Amount: '99' });
  assert.deepEqual(await calcShop(currentPrice, seeded.order), euros2('200'));
  assert.deepEqual(await calcShop(frozenPrice, seeded.order), euros2('100'));
  assert.ok((await calcShop(frozenDiscount, seeded.order)).missing, 'a value added later never appears in a snapshot');
  assert.deepEqual(await calcShop(frozenDiscountOrZero, seeded.order), euros2('0'));
  assert.deepEqual(await calcShop(currentSum, seeded.order), euros2('119.5'));
  assert.deepEqual(await calcShop(frozenSum, seeded.order), euros2('30.5'));
  const snapshotHop = { kind: 'property', referenceFieldId: orderRef('Frozen'), through: [idOf(productFormat, 'Category'), idOf(categoryFormat, 'Group')], propertyFieldId: idOf(groupFormat, 'Rate') };
  assert.match(await refusedShop(snapshotHop), /snapshot reference cannot be followed/);
  const smuggled = await saveShop(productPath('Price'));
  await mongoose.connection.collection('collections').updateOne({ _id: new mongoose.Types.ObjectId(shop.id) }, { $set: { 'formulas.$[item].expression': JSON.stringify(snapshotHop) } }, { arrayFilters: [{ 'item.id': smuggled }] });
  assert.ok((await calcShop(smuggled, seeded.order)).missing, 'even an unvalidated path never reads through a snapshot');

  // Static validation of paths and aggregates
  assert.match(await refusedShop({ kind: 'property', referenceFieldId: orderRef('Lines'), propertyFieldId: idOf(lineFormat, 'Amount') }), /single object reference/);
  assert.match(await refusedShop({ ...ratePath, through: Array.from({ length: 5 }, () => idOf(productFormat, 'Category')) }), /at most five/);
  assert.match(await refusedShop({ ...ratePath, through: [idOf(productFormat, 'Price')] }), /single object reference/);
  assert.match(await refusedShop({ kind: 'property', referenceFieldId: orderRef('Customer'), propertyFieldId: idOf(customerFormat, 'City') }), /numeric property/);
  assert.match(await refusedShop({ kind: 'textProperty', referenceFieldId: orderRef('Product'), propertyFieldId: idOf(productFormat, 'Price') }), /text, title, code or link/);
  assert.match(await refusedShop({ kind: 'sumRelated', referenceFieldId: orderRef('Customer'), propertyFieldId: idOf(customerFormat, 'City') }), /numeric property/);
  assert.match(await refusedShop({ kind: 'sumRelated', referenceFieldId: orderRef('Title'), propertyFieldId: idOf(lineFormat, 'Amount') }), /numeric property/);
  assert.match(await refusedShop({ kind: 'countRelated', referenceFieldId: orderRef('Lines'), propertyFieldId: 'nope' }), /object reference/);

  // Copies and domain packages rewrite every step of a path
  const relationSource = await buildShop('T24 Source');
  const relationOrder = relationSource.byName('Order');
  const sourceRef = (name) => idOf(relationOrder, name);
  const sourceProduct = relationSource.byName('Product'), sourceCategory = relationSource.byName('Category');
  for (const [name, expression] of [
    ['Rate', { kind: 'property', referenceFieldId: sourceRef('Product'), through: [idOf(sourceProduct, 'Category'), idOf(sourceCategory, 'Group')], propertyFieldId: idOf(relationSource.byName('Group'), 'Rate') }],
    ['City', { kind: 'coalesceText', args: [{ kind: 'textProperty', referenceFieldId: sourceRef('Customer'), propertyFieldId: idOf(relationSource.byName('Customer'), 'City') }, lit(' ')] }],
    ['Discount', coalesce({ kind: 'property', referenceFieldId: sourceRef('Product'), propertyFieldId: idOf(sourceProduct, 'Discount') }, num('0'))],
    ['Total', { kind: 'sumRelated', referenceFieldId: sourceRef('Lines'), propertyFieldId: idOf(relationSource.byName('Line'), 'Amount') }],
    ['Links', { kind: 'countRelated', referenceFieldId: sourceRef('Lines') }],
    ['Unit', { kind: 'unitOf', value: { kind: 'sumRelated', referenceFieldId: sourceRef('FrozenLines'), propertyFieldId: idOf(relationSource.byName('Line'), 'Amount') } }],
  ]) await gql(SAVE_FORMULA, { id: relationSource.id, input: { name, formatId: relationOrder.id, expression: JSON.stringify(expression) } });
  const assertRelationsIn = async (collectionId) => {
    const target = (await gql('query { collectionsList { id formulas { id name formatId } formats { id name fields { id name } } } }')).collectionsList.find((item) => item.id === collectionId);
    const byName = (item) => target.formats.find((format) => format.name === item);
    const entryId = (await seedShop(collectionId, byName)).order;
    const resultOf = async (name) => ({ ...(await gql(CALCULATE_DATE, { id: collectionId, formulaId: target.formulas.find((item) => item.name === name && item.formatId === byName('Order').id).id, entryId })).calculateCollectionFormula });
    assert.deepEqual(await resultOf('Rate'), quantityOf('20'));
    assert.deepEqual(await resultOf('City'), textOf('Paris'));
    assert.deepEqual(await resultOf('Discount'), euros2('0'));
    assert.deepEqual(await resultOf('Total'), euros2('30.5'));
    assert.deepEqual(await resultOf('Links'), quantityOf('3'));
    assert.deepEqual(await resultOf('Unit'), textOf('EUR'));
  };
  const relationCopy = (await gql(CREATE_COLLECTION, { input: { name: 'T24 Copy', formats: [{ name: 'General', color: '#F4F0FF', fields: [{ name: 'Title', kind: 'TITLE' }] }] } })).createCollection;
  ids.push(relationCopy.id);
  await gql('mutation($formatId:String!,$targetCollectionId:String!) { copyCollectionDataFormat(formatId:$formatId,targetCollectionId:$targetCollectionId,withEntries:false) { copiedEntries } }', { formatId: relationOrder.id, targetCollectionId: relationCopy.id });
  await assertRelationsIn(relationCopy.id);
  const relationPackage = (await gql('query($id:String!,$input:DomainPackageExportInput!) { exportDomainPackage(collectionId:$id,input:$input,language:"en") { packageJson warnings } }', { id: relationSource.id, input: { packageId: 'smoke.t24', version: '1.0.0', name: 'T24', author: 'Smoke', license: 'CC-BY-4.0' } })).exportDomainPackage;
  assert.deepEqual(relationPackage.warnings, []);
  const relationInstall = (await gql('mutation($json:String!) { installDomainPackage(packageJson:$json,collectionName:"T24 Installed",language:"en") { collectionId } }', { json: relationPackage.packageJson })).installDomainPackage;
  ids.push(relationInstall.collectionId);
  await assertRelationsIn(relationInstall.collectionId);

  // T21/5 — Everything below is refused or typed on save, before any entry exists
  const typesCol = (await gql(CREATE_COLLECTION, { input: { name: 'T25 Types', formats: [{ name: 'Sheet', color: '#EEF5FF', fields: [{ name: 'Label', kind: 'TITLE' }, { name: 'Note', kind: 'TEXT' }, { name: 'Price', kind: 'NUMBER', unit: 'EUR' }, { name: 'Cost', kind: 'NUMBER', unit: 'USD' }, { name: 'Weight', kind: 'NUMBER', unit: 'kg' }, { name: 'Distance', kind: 'NUMBER', unit: 'km' }, { name: 'Time', kind: 'NUMBER', unit: 'h' }, { name: 'Length', kind: 'NUMBER', unit: 'm' }, { name: 'Width', kind: 'NUMBER', unit: 'm' }, { name: 'Quantity', kind: 'NUMBER' }, { name: 'Day', kind: 'DATE' }, { name: 'At', kind: 'DATETIME' }] }] } })).createCollection;
  ids.push(typesCol.id);
  const sheetFmt = typesCol.formats[0];
  const sheetNumber = (name) => ({ kind: 'field', fieldId: idOf(sheetFmt, name) });
  const sheetDate = (name) => ({ kind: 'dateField', fieldId: idOf(sheetFmt, name) });
  const sheetText = (name) => ({ kind: 'textField', fieldId: idOf(sheetFmt, name) });
  const binary = (operator, left, right) => ({ kind: 'operation', operator, args: [left, right] });
  const SAVE_TYPED = 'mutation($id:String!,$input:FormulaInput!,$formulaId:String) { saveCollectionFormula(collectionId:$id,formulaId:$formulaId,input:$input) { formulas { id name version } } }';
  const saveTyped = async (name, expression) => (await gql(SAVE_TYPED, { id: typesCol.id, input: { name, formatId: sheetFmt.id, expression: JSON.stringify(expression) } })).saveCollectionFormula.formulas.find((item) => item.name === name).id;
  let t25Count = 0;
  const refusedTyped = (expression) => gql(SAVE_TYPED, { id: typesCol.id, input: { name: `T25 refused ${++t25Count}`, formatId: sheetFmt.id, expression: JSON.stringify(expression) } }, token, true);
  const inferred = async (expression) => ({ ...(await gql('query($id:String!,$formatId:String!,$expression:String!) { inferCollectionFormula(collectionId:$id,formatId:$formatId,expression:$expression) { type unit dimension unitOpen } }', { id: typesCol.id, formatId: sheetFmt.id, expression: JSON.stringify(expression) })).inferCollectionFormula });
  const staticNumber = (unit, dimension) => ({ type: 'NUMBER', unit, dimension, unitOpen: false });
  const staticOther = (type) => ({ type, unit: null, dimension: null, unitOpen: false });
  const price = sheetNumber('Price'), distance = sheetNumber('Distance'), weight = sheetNumber('Weight'), quantity = sheetNumber('Quantity');
  const abs = (value) => ({ kind: 'abs', value });
  const iifNumber = (thenBranch, elseBranch) => iif(cmp('GT', quantity, num('0')), thenBranch, elseBranch);
  const iifNumberOf = (condition) => iif(condition, num('1'), num('0'));

  // Incompatible dimensions, however deep they are
  assert.match(await refusedTyped(binary('ADD', price, distance)), /Cannot add incompatible units/);
  assert.match(await refusedTyped(binary('SUBTRACT', distance, price)), /Cannot add incompatible units/);
  assert.match(await refusedTyped(binary('ADD', price, quantity)), /Cannot add incompatible units/);
  assert.match(await refusedTyped(binary('ADD', price, sheetNumber('Cost'))), /dated rate/);
  assert.match(await refusedTyped(binary('ADD', binary('MULTIPLY', quantity, price), distance)), /Cannot add incompatible units/);
  assert.match(await refusedTyped(binary('ADD', { kind: 'round', digits: 2, mode: 'HALF_UP', value: abs(price) }, distance)), /Cannot add incompatible units/);
  assert.match(await refusedTyped(binary('ADD', { kind: 'min', args: [price, num('1', 'EUR')] }, distance)), /Cannot add incompatible units/);
  assert.match(await refusedTyped(binary('ADD', iifNumber(price, num('0')), distance)), /Cannot add incompatible units/);
  assert.match(await refusedTyped(binary('ADD', coalesce(price, num('0')), weight)), /Cannot add incompatible units/);
  assert.match(await refusedTyped(iifNumber(price, distance)), /incompatible units/);
  assert.match(await refusedTyped(iifNumber(price, num('5'))), /incompatible units/);
  const referenced = await saveTyped('Referenced', price);
  const secondLevel = await saveTyped('Second level', { kind: 'formula', formulaId: referenced });
  assert.match(await refusedTyped(binary('ADD', { kind: 'formula', formulaId: secondLevel }, distance)), /Cannot add incompatible units/);

  // A value of the wrong type in any slot
  assert.match(await refusedTyped(addDays(lit('texte'), num('5'))), /Expected a date but found text/);
  assert.match(await refusedTyped(part('YEAR', lit('2026'))), /Expected a date but found text/);
  assert.match(await refusedTyped(diff('DAYS', sheetDate('Day'), price)), /Expected a date but found a number/);
  assert.match(await refusedTyped({ kind: 'upper', text: sheetDate('Day') }), /Expected text but found a date/);
  assert.match(await refusedTyped(concat(lit('a'), price)), /Expected text but found a number/);
  assert.match(await refusedTyped(binary('ADD', lit('1'), num('1'))), /gives text, not a number/);
  assert.match(await refusedTyped(binary('ADD', sheetDate('Day'), num('1'))), /gives a date, not a number/);
  assert.match(await refusedTyped(binary('ADD', cmp('GT', num('1'), num('0')), num('1'))), /Expected a number but found a condition/);
  assert.match(await refusedTyped(iif(price, num('1'), num('0'))), /Expected a condition but found a number/);

  // Comparisons that can never work
  assert.match(await refusedTyped(iifNumberOf(cmp('EQ', sheetText('Note'), sheetDate('Day')))), /Cannot compare text with a date/);
  assert.match(await refusedTyped(iifNumberOf(cmp('LT', sheetDate('Day'), price))), /Cannot compare a date with a number/);
  assert.match(await refusedTyped(iifNumberOf(cmp('GT', abs(price), abs(weight)))), /incompatible units/);
  assert.match(await refusedTyped(iifNumberOf(cmp('EQ', binary('MULTIPLY', quantity, price), weight))), /incompatible units/);

  // Every step of a path, checked on save
  assert.match(await refusedShop({ ...ratePath, propertyFieldId: 'nope' }), /does not exist on the linked object/);
  assert.match(await refusedShop({ ...cityPath, propertyFieldId: 'nope' }), /does not exist on the linked object/);
  assert.match(await refusedShop({ ...ratePath, through: [idOf(productFormat, 'Category'), 'nope'] }), /single object reference/);
  assert.match(await refusedShop({ ...ratePath, referenceFieldId: 'nope' }), /single object reference/);
  assert.match(await refusedShop(binary('ADD', ratePath, productPath('Price'))), /Cannot add incompatible units/);

  // Result types and combined units, known without any entry
  assert.deepEqual(await inferred(binary('MULTIPLY', quantity, price)), staticNumber('EUR', 'CURRENCY'));
  assert.deepEqual(await inferred(binary('MULTIPLY', price, num('0.8'))), staticNumber('EUR', 'CURRENCY'));
  assert.deepEqual(await inferred(binary('MULTIPLY', sheetNumber('Length'), sheetNumber('Width'))), staticNumber('m²', 'DISTANCE·DISTANCE'));
  assert.deepEqual(await inferred(binary('MULTIPLY', price, weight)), staticNumber('EUR·kg', 'CURRENCY·MASS'));
  assert.deepEqual(await inferred(binary('DIVIDE', sheetNumber('Length'), sheetNumber('Width'))), staticNumber(null, null));
  assert.deepEqual(await inferred(binary('DIVIDE', price, quantity)), staticNumber('EUR', 'CURRENCY'));
  assert.deepEqual(await inferred(iifNumber(price, num('0'))), staticNumber('EUR', 'CURRENCY'));
  assert.deepEqual(await inferred({ kind: 'formula', formulaId: secondLevel }), staticNumber('EUR', 'CURRENCY'));
  assert.deepEqual(await inferred(quantity), staticNumber(null, null));
  assert.deepEqual(await inferred(sheetText('Note')), staticOther('TEXT'));
  assert.deepEqual(await inferred(sheetDate('Day')), staticOther('DATE'));
  assert.deepEqual(await inferred(sheetDate('At')), staticOther('DATETIME'));
  assert.deepEqual(await inferred(addDays(sheetDate('At'), num('1'))), staticOther('DATETIME'));
  assert.deepEqual(await inferred({ kind: 'endOfMonth', date: sheetDate('At') }), staticOther('DATE'));
  assert.match(await gql('query($id:String!,$formatId:String!,$expression:String!) { inferCollectionFormula(collectionId:$id,formatId:$formatId,expression:$expression) { type } }', { id: typesCol.id, formatId: sheetFmt.id, expression: JSON.stringify(binary('ADD', price, distance)) }, token, true), /Cannot add incompatible units/);

  // km/h and m² come from the units of the collection
  const speed = binary('DIVIDE', distance, sheetNumber('Time'));
  assert.match(await refusedTyped(speed), /Dividing by a unit requires compatible quantities, or the unit km\/h in this collection/);
  assert.match(await refusedTyped(binary('DIVIDE', num('1'), sheetNumber('Time'))), /Dividing by a unit/);
  const SAVE_UNIT = 'mutation($id:String!,$input:CollectionUnitInput!) { saveCollectionUnit(collectionId:$id,input:$input) { units { id symbol } } }';
  const unitIdOf = async (input) => (await gql(SAVE_UNIT, { id: typesCol.id, input })).saveCollectionUnit.units.find((item) => item.symbol === input.symbol).id;
  const speedUnit = await unitIdOf({ name: 'Kilometre per hour', symbol: 'km/h', dimension: 'SPEED', factor: '1' });
  const areaUnit = await unitIdOf({ name: 'Square metre', symbol: 'm²', dimension: 'AREA', factor: '1' });
  assert.deepEqual(await inferred(speed), staticNumber(speedUnit, 'SPEED'));
  assert.deepEqual(await inferred(binary('MULTIPLY', sheetNumber('Length'), sheetNumber('Width'))), staticNumber(areaUnit, 'AREA'));
  const speedFormula = await saveTyped('Speed', speed);
  const areaFormula = await saveTyped('Area', binary('MULTIPLY', sheetNumber('Length'), sheetNumber('Width')));
  const totalFormula = await saveTyped('Total', binary('ADD', price, iifNumber(num('0'), price)));
  const sheetEntry = await createEvent(typesCol.id, sheetFmt, { Label: 'One', Price: '10', Distance: '100', Time: '2', Length: '3', Width: '4', Quantity: '1' });
  const calcTyped = async (formulaId) => ({ ...(await gql(CALCULATE_DATE, { id: typesCol.id, formulaId, entryId: sheetEntry })).calculateCollectionFormula });
  assert.deepEqual(await calcTyped(speedFormula), quantityOf('50', speedUnit, 'SPEED'), 'the calculation gives the unit inferred on save');
  assert.deepEqual(await calcTyped(areaFormula), quantityOf('12', areaUnit, 'AREA'));
  assert.deepEqual(await calcTyped(totalFormula), euros2('10'), 'a chosen plain 0 takes the unit inferred for its branch');

  // Cycles are named, from the formula being saved
  const alpha = await saveTyped('Alpha', num('1'));
  const beta = await saveTyped('Beta', { kind: 'formula', formulaId: alpha });
  const gamma = await saveTyped('Gamma', { kind: 'formula', formulaId: beta });
  const updateAlpha = (expression) => gql(SAVE_TYPED, { id: typesCol.id, formulaId: alpha, input: { name: 'Alpha', formatId: sheetFmt.id, expectedVersion: 1, expression: JSON.stringify(expression) } }, token, true);
  assert.equal(await updateAlpha({ kind: 'formula', formulaId: gamma }), 'Formula cycle detected: Alpha -> Gamma -> Beta -> Alpha');
  assert.equal(await updateAlpha({ kind: 'formula', formulaId: alpha }), 'Formula cycle detected: Alpha -> Alpha');
  assert.equal(await updateAlpha(iif(cmp('GT', { kind: 'formula', formulaId: gamma }, num('0')), num('1'), num('0'))), 'Formula cycle detected: Alpha -> Gamma -> Beta -> Alpha', 'a cycle through a condition is found too');
  assert.equal(await updateAlpha(binary('ADD', num('1'), abs({ kind: 'formula', formulaId: gamma }))), 'Formula cycle detected: Alpha -> Gamma -> Beta -> Alpha');
  assert.equal((await calcTyped(gamma)).value, '1', 'a refused cycle leaves the formulas unchanged');
  assert.equal((await calcTyped(await saveTyped('Diamond', binary('ADD', { kind: 'formula', formulaId: beta }, { kind: 'formula', formulaId: gamma })))).value, '2', 'sharing a dependency is not a cycle');

  // T21/6 — Date and text comparisons, and previewing a formula that is not saved
  const dateCheck = (operator, left, right) => iifNumberOf(cmp(operator, left, right));
  const previewOf = async (expression) => (await gql('query($id:String!,$formatId:String!,$expression:String!) { previewCollectionFormula(collectionId:$id,formatId:$formatId,expression:$expression) { entryId entryLabel value unit dimension missing } }', { id: datesCol.id, formatId: eventFmt.id, expression: JSON.stringify(expression) })).previewCollectionFormula;
  for (const [operator, left, right, expected] of [['LT', '2026-01-01', '2026-01-02', '1'], ['LT', '2026-01-02', '2026-01-01', '0'], ['LTE', '2026-01-01', '2026-01-01', '1'], ['GT', '2026-02-01', '2026-01-31', '1'], ['GTE', '2026-01-01', '2026-01-02', '0'], ['EQ', '2026-01-01', '2026-01-01T00:00:00Z', '1'], ['NEQ', '2026-01-01', '2026-01-02', '1'], ['EQ', '2026-01-01T12:00:00+02:00', '2026-01-01T10:00:00Z', '1']]) {
    assert.equal((await evalDate(dateCheck(operator, day(left), day(right)))).value, expected, `${left} ${operator} ${right}`);
  }
  assert.equal((await evalDate(dateCheck('GTE', dateField('End'), dateField('Start')))).value, '1');
  assert.equal((await evalDate(dateCheck('LT', addDays(dateField('Start'), num('1')), dateField('End')))).value, '1');
  assert.ok((await evalDate(dateCheck('LT', dateField('Start'), day('2026-01-01')), blankEvent)).missing, 'a missing date leaves the condition unknown');
  for (const [operator, left, right, expected] of [['EQ', 'VALIDE', 'VALIDE', '1'], ['EQ', 'VALIDE', 'valide', '0'], ['NEQ', 'VALIDE', 'BROUILLON', '1'], ['NEQ', 'VALIDE', 'VALIDE', '0'], ['EQ', 'é', 'é', '1']]) {
    assert.equal((await evalText(iifNumberOf(cmp(operator, lit(left), lit(right))))).value, expected, `${left} ${operator} ${right}`);
  }
  assert.equal((await evalText(iifNumberOf(cmp('EQ', textField('Label'), lit('Bonjour'))))).value, '1');
  assert.ok((await evalText(iifNumberOf(cmp('EQ', textField('Body'), lit('x'))), blankNote)).missing);
  assert.match(await refusedTyped(iifNumberOf(cmp('LT', sheetText('Note'), lit('a')))), /equal or different/);
  assert.match(await refusedTyped(iifNumberOf(cmp('EQ', sheetText('Note'), price))), /Cannot compare text with a number/);
  assert.match(await refusedTyped(iifNumberOf(cmp('EQ', cmp('GT', num('1'), num('0')), cmp('GT', num('1'), num('0'))))), /Conditions cannot be compared/);
  assert.match(await refusedTyped(binary('ADD', price, distance)), /Cannot add incompatible units: EUR and km/);
  assert.match(await refusedTyped(binary('ADD', price, quantity)), /Cannot add incompatible units: EUR and no unit/);
  const firstEventPreview = { ...(await previewOf(diff('DAYS', dateField('End'), dateField('Start')))) };
  assert.deepEqual(firstEventPreview, { entryId: fullEvent, entryLabel: 'Full', value: '29', unit: 'd', dimension: 'TIME', missing: null });
  assert.equal((await previewOf(addDays(dateField('Start'), num('1')))).dimension, 'DATE');
  assert.equal((await previewOf(part('YEAR', dateField('Start')))).value, '2026');
  const countBefore = (await gql('query { collectionsList { id formulas { id } } }')).collectionsList.find((item) => item.id === datesCol.id).formulas.length;
  await previewOf(num('1'));
  assert.equal((await gql('query { collectionsList { id formulas { id } } }')).collectionsList.find((item) => item.id === datesCol.id).formulas.length, countBefore, 'a preview saves nothing');
  const emptyFormat = (await gql(ADD_FORMAT, { id: datesCol.id, input: { name: 'Empty', color: '#EDF9F3', fields: [{ name: 'Title', kind: 'TITLE' }] } })).addCollectionFormat.formats.find((item) => item.name === 'Empty');
  assert.equal((await gql('query($id:String!,$formatId:String!,$expression:String!) { previewCollectionFormula(collectionId:$id,formatId:$formatId,expression:$expression) { value } }', { id: datesCol.id, formatId: emptyFormat.id, expression: JSON.stringify(num('1')) })).previewCollectionFormula, null);
  await gql('query($id:String!,$formatId:String!,$expression:String!) { previewCollectionFormula(collectionId:$id,formatId:$formatId,expression:$expression) { value } }', { id: datesCol.id, formatId: eventFmt.id, expression: JSON.stringify(num('1')) }, (await gql('mutation($input:RegisterInput!) { register(input:$input) { token user { id } } }', { input: { name: 'Preview outsider', email: `preview-${randomUUID()}@example.test`, password: 'temporary-test-password' } }, undefined)).register.token, true);

  // T22 — Native aggregation gives the same answers as the entry-by-entry calculation, beyond the former limit
  const statsCol = (await gql(CREATE_COLLECTION, { input: { name: 'T22 Stats', formats: [{ name: 'Reading', color: '#EEF5FF', fields: [{ name: 'Label', kind: 'TITLE' }, { name: 'Amount', kind: 'NUMBER', unit: 'EUR' }, { name: 'Plain', kind: 'NUMBER' }, { name: 'Day', kind: 'DATE' }, { name: 'Team', kind: 'TEXT' }, { name: 'Note', kind: 'TEXT' }] }] } })).createCollection;
  ids.push(statsCol.id);
  const readingFmt = statsCol.formats[0];
  const statsField = (name) => idOf(readingFmt, name);
  const readings = [['r1', '10', '1', '2026-01-05', 'North', 'alpha $x'], ['r2', '20', '2', '2026-01-20', 'North', 'beta'], ['r3', '20', '2', '2026-02-02', 'South', 'ALPHA'], ['r4', '40.5', '4', '2026-02-10', 'South', 'gamma'], ['r5', '1000', '8', '2026-02-11', 'South', 'delta'], ['r6', '0.125', '16', '2026-03-01', 'East', 'alpha'], ['r7', '7', '32', '2026-03-02', 'East', 'x.y'], ['r8', '7', '64', '2026-03-03', 'East', 'xzy']];
  for (const [Label, Amount, Plain, Day, Team, Note] of readings) await createEvent(statsCol.id, readingFmt, { Label, Amount, Plain, Day, Team, Note });
  await createEvent(statsCol.id, readingFmt, { Label: 'no amount', Plain: '128', Day: '2026-03-04', Team: 'East', Note: 'empty' });
  await createEvent(statsCol.id, readingFmt, { Label: 'no team', Amount: '3', Plain: '256', Day: '2026-03-05', Note: 'loner' });
  const ANALYSE = 'query($id:String!,$input:AnalysisInput!) { analyseCollection(collectionId:$id,input:$input) { unit dimension skippedMissingCount explanation rows { group label value count sourcesHasMore sources { entryId value } } comparisonRows { group value count } } }';
  const analyseStats = async (input) => JSON.parse(JSON.stringify((await gql(ANALYSE, { id: statsCol.id, input: { formatId: readingFmt.id, measureKind: 'EVENT', ...input } })).analyseCollection));
  // A formula the database cannot translate takes the entry-by-entry path over the same values.
  const entryByEntry = (await gql(SAVE_FORMULA, { id: statsCol.id, input: { name: 'Same amount', formatId: readingFmt.id, expression: JSON.stringify({ kind: 'round', digits: 6, mode: 'HALF_UP', value: { kind: 'field', fieldId: statsField('Amount') } }) } })).saveCollectionFormula.formulas.find((item) => item.name === 'Same amount').id;
  const groupings = [{ groupBy: 'NONE' }, { groupBy: 'MONTH', dateFieldId: statsField('Day') }, { groupBy: 'DAY', dateFieldId: statsField('Day') }, { groupBy: 'CATEGORY', groupFieldId: statsField('Team') }];
  const filtersets = [[], [{ fieldId: statsField('Amount'), operator: 'GTE', value: '7' }], [{ fieldId: statsField('Note'), operator: 'CONTAINS', value: 'alpha' }], [{ fieldId: statsField('Team'), operator: 'EQ', value: 'East' }, { fieldId: statsField('Amount'), operator: 'LT', value: '10' }]];
  const nativeOperations = ['SUM', 'AVERAGE', 'MIN', 'MAX', 'RANGE', 'MEDIAN', 'PERCENTILE', 'PERCENTILE_25', 'PERCENTILE_75', 'PERCENTILE_95', 'MODE', 'VARIANCE', 'STDDEV', 'STDDEV_SAMPLE'];
  const comparableRows = (result) => result.rows.map((row) => ({ ...row, sources: [...row.sources].sort((a, b) => a.entryId.localeCompare(b.entryId)) }));
  let compared = 0;
  for (const operation of nativeOperations) for (const grouping of groupings) for (const filters of filtersets) {
    const shared = { operation, ...grouping, filters, ...(operation === 'PERCENTILE' ? { percentile: 90 } : {}) };
    const run = async (extra) => { try { return await analyseStats({ ...shared, ...extra }); } catch (error) { return { refused: error.message.match(/"message":"([^"]*)"/)?.[1] }; } };
    const [native, row] = [await run({ fieldId: statsField('Amount') }), await run({ formulaId: entryByEntry })];
    if (native.refused || row.refused) { assert.equal(native.refused, row.refused, JSON.stringify(shared)); compared += 1; continue; }
    assert.deepEqual(comparableRows(native), comparableRows(row), JSON.stringify(shared));
    assert.equal(native.unit, row.unit, operation);
    assert.equal(native.skippedMissingCount, row.skippedMissingCount, JSON.stringify(shared));
    compared += 1;
  }
  assert.equal(compared, nativeOperations.length * groupings.length * filtersets.length);

  // Exact values of the new statistics
  const statValue = async (operation, extra = {}) => (await analyseStats({ operation, fieldId: statsField('Amount'), groupBy: 'NONE', ...extra })).rows[0].value;
  for (const [operation, expected] of [['MEDIAN', '10'], ['PERCENTILE_25', '7'], ['PERCENTILE_75', '20'], ['PERCENTILE_95', '1000'], ['MODE', '7'], ['MIN', '0.125'], ['MAX', '1000'], ['SUM', '1107.625'], ['COUNT', '10']]) {
    assert.equal(await statValue(operation), expected, operation);
  }
  const pairStats = (await analyseStats({ operation: 'VARIANCE', fieldId: statsField('Plain'), groupBy: 'NONE', filters: [{ fieldId: statsField('Plain'), operator: 'LTE', value: '2' }] })).rows[0];
  assert.deepEqual([pairStats.value, pairStats.count], ['0.222222222222', 3]);
  const lowPlain = [{ fieldId: statsField('Plain'), operator: 'LTE', value: '2' }];
  assert.equal(await statValue('STDDEV', { fieldId: statsField('Plain'), filters: lowPlain }), '0.471405', 'population deviation');
  assert.equal(await statValue('STDDEV_SAMPLE', { fieldId: statsField('Plain'), filters: lowPlain }), '0.57735', 'sample deviation');
  const operationIds = (await gql('query { analysisOperations { id version requiresNumeric minObservations } }')).analysisOperations.map((item) => item.id);
  for (const id of ['MEDIAN', 'STDDEV', 'STDDEV_SAMPLE', 'PERCENTILE_25', 'PERCENTILE_75', 'PERCENTILE_95', 'MODE']) assert.ok(operationIds.includes(id), id);

  // Details kept by the native path: units, missing values, sources, comparison, formulas and text that looks like an operator
  const median = await analyseStats({ operation: 'MEDIAN', fieldId: statsField('Amount'), groupBy: 'NONE' });
  assert.equal(median.unit, 'EUR');
  assert.equal(median.dimension, 'CURRENCY');
  assert.equal(median.skippedMissingCount, 1);
  assert.equal((await analyseStats({ operation: 'VARIANCE', fieldId: statsField('Amount'), groupBy: 'NONE' })).unit, 'EUR²');
  const sparse = await analyseStats({ operation: 'COUNT', groupBy: 'CATEGORY', groupFieldId: statsField('Team') });
  assert.deepEqual(sparse.rows.map((row) => [row.group, row.count]), [['East', 4], ['Missing category', 1], ['North', 2], ['South', 3]]);
  assert.equal(sparse.rows[0].sources[0].value, '1');
  assert.equal((await analyseStats({ operation: 'SUM', fieldId: statsField('Amount'), groupBy: 'NONE', filters: [{ fieldId: statsField('Note'), operator: 'CONTAINS', value: '$x' }] })).rows[0].value, '10', 'a filter value is never read as a database operator');
  assert.deepEqual((await analyseStats({ operation: 'COUNT', groupBy: 'NONE', filters: [{ fieldId: statsField('Note'), operator: 'CONTAINS', value: 'x.y' }] })).rows.map((row) => row.count), [1], 'a dot in a filter is a dot');
  assert.equal((await analyseStats({ operation: 'SUM', fieldId: statsField('Amount'), groupBy: 'NONE', filters: [{ fieldId: statsField('Team'), operator: 'EQ', value: '$Team' }] })).rows.length, 0);
  const periods = await analyseStats({ operation: 'SUM', fieldId: statsField('Amount'), groupBy: 'NONE', dateFieldId: statsField('Day'), from: '2026-02-01', to: '2026-02-28', comparisonFrom: '2026-01-01', comparisonTo: '2026-01-31' });
  assert.deepEqual([periods.rows[0].value, periods.comparisonRows[0].value], ['1060.5', '30']);
  assert.match(await gql(ANALYSE, { id: statsCol.id, input: { formatId: readingFmt.id, measureKind: 'EVENT', operation: 'STDDEV', fieldId: statsField('Amount'), groupBy: 'NONE', filters: [{ fieldId: statsField('Label'), operator: 'EQ', value: 'r1' }] } }, token, true), /at least 2|Not enough/);
  const vectorFormula = (await gql(SAVE_FORMULA, { id: statsCol.id, input: { name: 'Doubled', formatId: readingFmt.id, expression: JSON.stringify(binary('MULTIPLY', { kind: 'field', fieldId: statsField('Amount') }, num('2'))) } })).saveCollectionFormula.formulas.find((item) => item.name === 'Doubled').id;
  const doubled = await analyseStats({ operation: 'SUM', formulaId: vectorFormula, groupBy: 'NONE' });
  assert.deepEqual([doubled.rows[0].value, doubled.unit, doubled.skippedMissingCount], ['2215.25', 'EUR', 1]);
  const zeroFormula = (await gql(SAVE_FORMULA, { id: statsCol.id, input: { name: 'Over zero', formatId: readingFmt.id, expression: JSON.stringify(binary('DIVIDE', { kind: 'field', fieldId: statsField('Plain') }, num('0'))) } })).saveCollectionFormula.formulas.find((item) => item.name === 'Over zero').id;
  assert.match(await gql(ANALYSE, { id: statsCol.id, input: { formatId: readingFmt.id, measureKind: 'EVENT', operation: 'SUM', formulaId: zeroFormula, groupBy: 'NONE' } }, token, true), /Cannot divide by zero/);
  const mixedEntry = await createEvent(statsCol.id, readingFmt, { Label: 'odd unit', Amount: '1', Day: '2026-03-06', Team: 'East', Note: 'odd' });
  await mongoose.connection.collection('entries').updateOne({ _id: new mongoose.Types.ObjectId(mixedEntry), 'values.fieldId': statsField('Amount') }, { $set: { 'values.$.unitSnapshot': { id: 'USD', version: 1, symbol: '$', dimension: 'CURRENCY', factor: '1', root: 'CURRENCY' } } });
  assert.match(await gql(ANALYSE, { id: statsCol.id, input: { formatId: readingFmt.id, measureKind: 'EVENT', operation: 'SUM', fieldId: statsField('Amount'), groupBy: 'NONE' } }, token, true), /mixed units/);
  await mongoose.connection.collection('entries').deleteOne({ _id: new mongoose.Types.ObjectId(mixedEntry) });

  // Another account still cannot read these figures
  const statsOutsider = (await gql('mutation($input:RegisterInput!) { register(input:$input) { token user { id } } }', { input: { name: 'Stats outsider', email: `stats-${randomUUID()}@example.test`, password: 'temporary-test-password' } }, undefined)).register;
  await gql(ANALYSE, { id: statsCol.id, input: { formatId: readingFmt.id, measureKind: 'EVENT', operation: 'SUM', fieldId: statsField('Amount'), groupBy: 'NONE' } }, statsOutsider.token, true);
  await mongoose.connection.collection('users').deleteOne({ _id: new mongoose.Types.ObjectId(statsOutsider.user.id) });

  // Above 100 000 entries: neither the database path nor the entry-by-entry stream refuses the volume
  const massive = Array.from({ length: 100100 }, (_, index) => ({ _id: new mongoose.Types.ObjectId(), ownerId, collectionId: statsCol.id, formatId: readingFmt.id, formatVersion: 1, values: [{ fieldId: statsField('Label'), value: `Massive ${index}` }, { fieldId: statsField('Plain'), value: String(index % 7), numberValue: String(index % 7) }, { fieldId: statsField('Day'), value: '2026-05-01' }], createdAt: new Date(), updatedAt: new Date() }));
  await mongoose.connection.collection('entries').insertMany(massive, { ordered: false });
  const massiveFormula = (await gql(SAVE_FORMULA, { id: statsCol.id, input: { name: 'Plain by entry', formatId: readingFmt.id, expression: JSON.stringify({ kind: 'round', digits: 2, mode: 'HALF_UP', value: { kind: 'field', fieldId: statsField('Plain') } }) } })).saveCollectionFormula.formulas.find((item) => item.name === 'Plain by entry').id;
  const massiveCount = await analyseStats({ operation: 'COUNT', groupBy: 'NONE' });
  assert.equal(massiveCount.rows[0].count, 100110);
  assert.equal(massiveCount.rows[0].sources.length, 100);
  assert.equal(massiveCount.rows[0].sourcesHasMore, true);
  assert.equal((await analyseStats({ operation: 'COUNT', groupBy: 'NONE', sourceGroup: 'All', sourceOffset: 100050 })).rows[0].sources.length, 60);
  assert.equal(await statValue('MEDIAN', { fieldId: statsField('Plain') }), '3');
  assert.equal(await statValue('MODE', { fieldId: statsField('Plain') }), '2');
  for (const operation of ['SUM', 'MEDIAN', 'MODE', 'STDDEV']) {
    const [byDatabase, byStream] = [await analyseStats({ operation, fieldId: statsField('Plain'), groupBy: 'NONE' }), await analyseStats({ operation, formulaId: massiveFormula, groupBy: 'NONE' })];
    assert.equal(byStream.rows[0].value, byDatabase.rows[0].value, `${operation} above the former limit`);
    assert.equal(byStream.rows[0].count, byDatabase.rows[0].count, operation);
    assert.equal(byStream.rows[0].sources.length, 100, operation);
  }
  const streamPage = (await analyseStats({ operation: 'SUM', formulaId: massiveFormula, groupBy: 'NONE', sourceGroup: 'All', sourceOffset: 100050 })).rows[0];
  assert.deepEqual([streamPage.sources.length, streamPage.sourcesHasMore], [streamPage.count - 100050, false], 'the last page of sources is reachable in a stream');
  assert.match(await gql(ANALYSE, { id: statsCol.id, input: { formatId: readingFmt.id, measureKind: 'EVENT', operation: 'CUMULATIVE', fieldId: statsField('Plain'), dateFieldId: statsField('Day'), groupBy: 'NONE' } }, token, true), /Group this series by day or month/);
  const orderedSeries = await analyseStats({ operation: 'CUMULATIVE', fieldId: statsField('Plain'), dateFieldId: statsField('Day'), groupBy: 'MONTH' });
  assert.equal(orderedSeries.rows.at(-1).value, await statValue('SUM', { fieldId: statsField('Plain'), filters: [{ fieldId: statsField('Day'), operator: 'LTE', value: '2026-12-31' }] }), 'an ordered series reads every entry');
  assert.equal(orderedSeries.rows.at(-1).sources.length, 100);

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
