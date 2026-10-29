import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parsePosition, parseZone, insideZone, distanceMeters } = require('../dist/collections/geo.logic.js');
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
console.log('T38/T39 geographic and classification smoke passed');
