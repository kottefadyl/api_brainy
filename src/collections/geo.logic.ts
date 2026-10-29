import { BadRequestException } from '@nestjs/common';

export type Position = { latitude: number; longitude: number; accuracy?: number };
export type Zone = { type: 'Circle'; center: [number, number]; radiusMeters: number } | { type: 'Polygon'; coordinates: [number, number][] };

function coordinates(latitude: number, longitude: number): void {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) throw new BadRequestException('Coordinates must use WGS84 latitude and longitude');
}

export function parsePosition(raw: string): Position {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new BadRequestException('Position needs latitude and longitude'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Position needs latitude and longitude');
  const data = value as Record<string, unknown>;
  if (typeof data.latitude !== 'number' || typeof data.longitude !== 'number') throw new BadRequestException('Position needs numeric latitude and longitude');
  const latitude = data.latitude, longitude = data.longitude;
  coordinates(latitude, longitude);
  if (data.accuracy !== undefined && data.accuracy !== null && typeof data.accuracy !== 'number') throw new BadRequestException('Position accuracy must be numeric');
  const accuracy = data.accuracy === undefined || data.accuracy === null ? undefined : data.accuracy as number;
  if (accuracy !== undefined && (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 1_000_000)) throw new BadRequestException('Position accuracy must be in metres');
  return { latitude, longitude, ...(accuracy === undefined ? {} : { accuracy }) };
}

function intersects(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): boolean {
  const cross = (p: [number, number], q: [number, number], r: [number, number]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0;
}

export function parseZone(raw: string): Zone {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new BadRequestException('Zone needs a circle or polygon'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Zone needs a circle or polygon');
  const data = value as Record<string, unknown>;
  if (data.type === 'Circle') {
    const center = data.center as number[];
    if (!Array.isArray(center) || center.length !== 2) throw new BadRequestException('Circle needs a centre');
    if (center.some((coordinate) => typeof coordinate !== 'number') || typeof data.radiusMeters !== 'number') throw new BadRequestException('Circle needs numeric coordinates and radius');
    coordinates(center[1], center[0]);
    const radiusMeters = data.radiusMeters;
    if (!Number.isFinite(radiusMeters) || radiusMeters <= 0 || radiusMeters > 20_000_000) throw new BadRequestException('Circle radius must be in metres');
    return { type: 'Circle', center: [center[0], center[1]], radiusMeters };
  }
  if (data.type !== 'Polygon' || !Array.isArray(data.coordinates)) throw new BadRequestException('Zone needs a circle or polygon');
  const points = data.coordinates as number[][];
  if (points.length < 3 || points.length > 100 || points.some((point) => !Array.isArray(point) || point.length !== 2)) throw new BadRequestException('Polygon needs 3 to 100 points');
  const ring = points.map((point): [number, number] => { if (point.some((coordinate) => typeof coordinate !== 'number')) throw new BadRequestException('Polygon needs numeric coordinates'); coordinates(point[1], point[0]); return [point[0], point[1]]; });
  if (new Set(ring.map((point) => point.join(','))).size !== ring.length) throw new BadRequestException('Polygon has repeated points');
  for (let i = 0; i < ring.length; i++) for (let j = i + 2; j < ring.length; j++) {
    if (i === 0 && j === ring.length - 1) continue;
    if (intersects(ring[i], ring[(i + 1) % ring.length], ring[j], ring[(j + 1) % ring.length])) throw new BadRequestException('Polygon crosses itself');
  }
  return { type: 'Polygon', coordinates: ring };
}

export function distanceMeters(a: Position, b: Position): number {
  const radians = Math.PI / 180;
  const lat = (b.latitude - a.latitude) * radians, lon = (b.longitude - a.longitude) * radians;
  const h = Math.sin(lat / 2) ** 2 + Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) * Math.sin(lon / 2) ** 2;
  return 12_742_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function insideZone(position: Position, zone: Zone): boolean {
  if (zone.type === 'Circle') return distanceMeters(position, { latitude: zone.center[1], longitude: zone.center[0] }) <= zone.radiusMeters;
  const x = position.longitude, y = position.latitude, points = zone.coordinates;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
