import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parsePosition, parseZone, insideZone, distanceMeters } = require('../dist/collections/geo.logic.js');
const { countPointsByZone } = require('../dist/collections/geo-grouping.js');
const { ZoneAnalysisService } = require('../dist/collections/zone-analysis.service.js');
const { validateClassificationCodes, codeAtDepth, parseClassificationCsv } = require('../dist/collections/classification.logic.js');

const point = parsePosition('{"latitude":6.5244,"longitude":3.3792,"accuracy":12}');
assert.deepEqual(point, { latitude: 6.5244, longitude: 3.3792, accuracy: 12 });
assert.throws(() => parsePosition('{"latitude":null,"longitude":3}'));
assert.throws(() => parsePosition('{"latitude":91,"longitude":3}'));
const circle = parseZone('{"type":"Circle","center":[3.3792,6.5244],"radiusMeters":1000}');
assert.equal(insideZone(point, circle), true);
assert.equal(insideZone({ latitude: 7, longitude: 3.3792 }, circle), false);
const polygon = parseZone('{"type":"Polygon","coordinates":[[3,6],[4,6],[4,7],[3,7]]}');
assert.equal(insideZone(point, polygon), true);
assert.ok(distanceMeters(point, { latitude: 6.5344, longitude: 3.3792 }) > 1000);
assert.deepEqual(countPointsByZone([{ entryId: 'point-1', position: point }], [
  { id: 'near', label: 'Nearby', shape: circle },
  { id: 'overlap', label: 'Overlapping', shape: polygon },
  { id: 'far', label: 'Far away', shape: parseZone('{"type":"Circle","center":[0,0],"radiusMeters":100}') },
]), [
  { zoneEntryId: 'near', label: 'Nearby', count: 1 },
  { zoneEntryId: 'overlap', label: 'Overlapping', count: 1 },
  { zoneEntryId: 'far', label: 'Far away', count: 0 },
]);

const codes = validateClassificationCodes([
  { code: 'country', labelEn: 'Country', labelFr: 'Pays', active: true },
  { code: 'region', labelEn: 'Region', labelFr: 'Région', parentCode: 'country', active: true },
  { code: 'city', labelEn: 'City', labelFr: 'Ville', parentCode: 'region', active: true },
]);
assert.equal(codeAtDepth({ id: 'local', name: 'Territories', version: 1, codes }, 'city', 1), 'region');
assert.throws(() => validateClassificationCodes([{ code: 'orphan', labelEn: 'Orphan', labelFr: 'Orphelin', parentCode: 'missing', active: true }]));
const preview = parseClassificationCsv('code,label_en,label_fr,parent_code,active\ncountry,Country,Pays,,true\nregion,Region,Région,country,true\ncity,City,Ville,region,true');
assert.equal(preview.errors.length, 0);
assert.equal(preview.codes.length, 3);
assert.equal(parseClassificationCsv('code,label_en,label_fr,parent_code,active\na,A,A,missing,true').errors[0].row, 2);
let appliedPageOptions;
const zoneAnalysis = new ZoneAnalysisService(
  { find: () => ({ limit: () => ({ exec: async () => [{ id: 'near', values: [{ fieldId: 'zone-field', value: JSON.stringify(circle) }, { fieldId: 'zone-title', value: 'Nearby' }] }] }) }) },
  { entriesPage: async (_collectionId, _ownerId, options) => { appliedPageOptions = options; return { entries: [{ id: 'point-1', formatId: 'points', values: [{ fieldId: 'position-field', value: JSON.stringify(point) }] }], nextCursor: undefined }; } },
);
const zoneResult = await zoneAnalysis.analyse({ id: 'collection', ownerId: 'owner', formats: [
  { id: 'points', fields: [{ id: 'position-field', kind: 'POSITION' }] },
  { id: 'zones', fields: [{ id: 'zone-field', kind: 'ZONE' }, { id: 'zone-title', kind: 'TITLE' }] },
] }, 'owner', { formatId: 'points', groupFieldId: 'position-field', zoneFormatId: 'zones', zoneFieldId: 'zone-field', operation: 'COUNT', groupBy: 'ZONE', measureKind: 'EVENT', search: 'station', filters: [{ fieldId: 'name', operator: 'EQ', value: 'A' }] });
assert.equal(zoneResult.rows[0].count, 1);
assert.equal(zoneResult.rows[0].label, 'Nearby');
assert.equal(appliedPageOptions.search, 'station');
assert.equal(appliedPageOptions.filters[0].value, 'A');
console.log('T38/T39 geographic and classification smoke passed');
