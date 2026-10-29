import { AnalysisInput, AnalysisRow } from './analysis.input';
import { executeRegisteredOperation, getOperationSpec, ObservationRecord } from './analysis_registry';
import { insideZone, Position, Zone } from './geo.logic';

export type NamedZone = { id: string; label: string; shape: Zone };
export type NamedPoint = { entryId: string; position: Position };

export function analysePointsByZone(points: NamedPoint[], zones: NamedZone[], input: AnalysisInput): AnalysisRow[] {
  const operation = getOperationSpec('COUNT');
  return zones.map((zone) => {
    const observations: ObservationRecord[] = points.filter((point) => insideZone(point.position, zone.shape)).map((point) => ({ entryId: point.entryId, primaryKey: zone.id }));
    const result = executeRegisteredOperation(operation, observations, input);
    return result.rows[0] ? { ...result.rows[0], label: zone.label } : { group: zone.id, label: zone.label, value: '0', count: 0, sources: [], sourcesHasMore: false };
  });
}

export function countPointsByZone(points: NamedPoint[], zones: NamedZone[]): { zoneEntryId: string; label: string; count: number }[] {
  return analysePointsByZone(points, zones, { formatId: '', operation: 'COUNT', groupBy: 'ZONE', measureKind: 'EVENT' }).map((row) => ({ zoneEntryId: row.group, label: row.label, count: row.count }));
}
