import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parsePosition, parseZone, insideZone, distanceMeters } = require('../dist/collections/geo.logic.js');
const { countPointsByZone } = require('../dist/collections/geo-grouping.js');
const { ZoneAnalysisService } = require('../dist/collections/zone-analysis.service.js');
const { validateClassificationCodes, codeAtDepth, parseClassificationCsv, codeHierarchy, resolveClassificationPaths, MAX_CODE_LEVELS } = require('../dist/collections/classification.logic.js');

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
// T39: deep hierarchies, breadcrumbs and cycle protection
const chainOf = (length) => Array.from({ length }, (_, index) => ({ code: `L${index + 1}`, labelEn: `Level ${index + 1}`, labelFr: `Niveau ${index + 1}`, parentCode: index ? `L${index}` : undefined, active: true }));
assert.equal(MAX_CODE_LEVELS, 8);
const deepest = validateClassificationCodes(chainOf(8));
assert.equal(codeAtDepth({ id: 'local', name: 'Deep', version: 1, codes: deepest }, 'L8', 4), 'L5');
assert.equal(codeAtDepth({ id: 'local', name: 'Deep', version: 1, codes: deepest }, 'L8', 7), 'L8');
assert.equal(codeAtDepth({ id: 'local', name: 'Deep', version: 1, codes: deepest }, 'L3', 7), 'L3', 'a shallow code stays itself at a deeper level');
assert.throws(() => validateClassificationCodes(chainOf(9)), /exceeds 8 levels at L9/);
const code = (name, parentCode) => ({ code: name, labelEn: name, labelFr: name, parentCode, active: true });
assert.throws(() => validateClassificationCodes([code('self', 'self')]), /cycle at self/, 'a code cannot be its own parent');
assert.throws(() => validateClassificationCodes([code('a', 'b'), code('b', 'a')]), /cycle at a/, 'a parent cannot be a descendant');
const longCycle = Array.from({ length: 12 }, (_, index) => code(`c${index}`, `c${(index + 1) % 12}`));
assert.throws(() => validateClassificationCodes(longCycle), /cycle/, 'a cycle longer than the limit is still reported as a cycle');
assert.deepEqual(codeHierarchy([code('child', 'a'), code('a', 'b'), code('b', 'a')]).problems.map((item) => item.code), ['child', 'a', 'b'], 'codes below a cycle are refused too');
assert.throws(() => validateClassificationCodes([code('a', 'missing')]), /Missing parent code for a/);
const naf = { id: 'naf', name: 'NAF', version: 1, codes: validateClassificationCodes([
  { code: 'G', labelEn: 'Trade', labelFr: 'Commerce', active: true },
  { code: '47', labelEn: 'Retail', labelFr: 'Vente de détail', parentCode: 'G', active: true },
  { code: '47.1', labelEn: 'Non-specialised stores', labelFr: 'Magasins non spécialisés', parentCode: '47', active: true },
  { code: '47.11B', labelEn: 'General food stores', labelFr: "Commerce d'alimentation générale", parentCode: '47.1', active: true },
]) };
assert.deepEqual(resolveClassificationPaths(naf, 'fr').at(-1), { code: '47.11B', label: "Commerce d'alimentation générale", path: ['Commerce', 'Vente de détail', 'Magasins non spécialisés'], level: 4, active: true });
assert.deepEqual(resolveClassificationPaths(naf, 'en')[0], { code: 'G', label: 'Trade', path: [], level: 1, active: true });
const csvHeader = 'code,label_en,label_fr,parent_code,active';
const deepCsv = parseClassificationCsv([csvHeader, ...Array.from({ length: 5 }, (_, index) => `n${index},N${index},N${index},${index ? `n${index - 1}` : ''},true`)].join('\n'));
assert.deepEqual([deepCsv.errors.length, deepCsv.codes.length], [0, 5], 'a five-level CSV imports');
assert.deepEqual(parseClassificationCsv([csvHeader, 'a,A,A,b,true', 'b,B,B,a,true', 'c,C,C,,true'].join('\n')).errors.map((item) => item.row), [2, 3], 'each code of a cycle is reported on its own row');
const nineRows = parseClassificationCsv([csvHeader, ...Array.from({ length: 9 }, (_, index) => `n${index},N,N,${index ? `n${index - 1}` : ''},true`)].join('\n'));
assert.deepEqual(nineRows.errors.map((item) => item.row), [10], 'only the code beyond the limit is reported');
const wide = Array.from({ length: 5000 }, (_, index) => code(`w${index}`, index % 8 ? `w${index - 1}` : undefined));
const started = performance.now();
assert.equal(validateClassificationCodes(wide).length, 5000);
assert.ok(performance.now() - started < 1000, 'a full list validates quickly');
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
