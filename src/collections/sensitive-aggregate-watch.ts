import { createHash } from 'node:crypto';
import { AnalysisInput } from './analysis.input.js';
import { CollaborationService } from './collaboration.service.js';

/**
 * T43/3: audit trail of sensitive aggregate queries and alerts on repeated
 * targeting patterns. Nothing here blocks a query; the threshold and the
 * refusals of `sensitivity.logic.ts` remain the protection. No value is
 * written: only a fingerprint of the question and its number of observations.
 */
export const SERVED = 'READ_SENSITIVE_AGGREGATE';
export const REFUSED = 'REFUSED_SENSITIVE_AGGREGATE';
export const ALERT = 'SENSITIVE_AGGREGATE_ALERT';

export const WATCH = {
  /** History used to compare results of the same question. */
  differenceWindowMs: 24 * 60 * 60 * 1000,
  /** Same question asked this many times within an hour. */
  burstCount: 10,
  burstWindowMs: 60 * 60 * 1000,
  /** Refused sensitive queries within an hour: someone may be probing the rules. */
  refusalCount: 5,
  /** One alert of a kind per question and person per hour. */
  alertQuietMs: 60 * 60 * 1000,
} as const;

export type AlertReason = 'DIFFERENCING' | 'BURST' | 'PROBING';
type Event = { action: string; occurredAt: Date; queryKey?: string; observationCount?: number; details?: string };

/** Fingerprint of what is asked, independent of language and of field order in the request. */
export function sensitiveQueryKey(input: AnalysisInput): string {
  const asked = {
    formatId: input.formatId, fieldId: input.fieldId ?? null, formulaId: input.formulaId ?? null, operation: input.operation,
    measureKind: input.measureKind, groupBy: input.groupBy, groupFieldId: input.groupFieldId ?? null, dateFieldId: input.dateFieldId ?? null,
    secondaryGroupBy: input.secondaryGroupBy ?? null, filters: input.filters ?? null, search: input.search ?? null, viewId: input.viewId ?? null,
    from: input.from ?? null, to: input.to ?? null, comparisonFrom: input.comparisonFrom ?? null, comparisonTo: input.comparisonTo ?? null,
  };
  return createHash('sha256').update(JSON.stringify(asked)).digest('hex').slice(0, 16);
}

/**
 * Patterns worth an alert for the event just recorded, given the person's
 * earlier events in the collection (newest first, current one excluded).
 * - DIFFERENCING: the same question gave a total that differs by fewer than
 *   `minimum` observations; subtracting both can isolate a few entries.
 * - BURST: the same question asked `burstCount` times within an hour.
 * - PROBING: `refusalCount` refused sensitive queries within an hour.
 */
export function repeatAlerts(history: Event[], current: { refused: boolean; queryKey: string; observationCount?: number }, minimum: number, now: Date): AlertReason[] {
  const since = (ms: number) => history.filter((event) => now.getTime() - event.occurredAt.getTime() <= ms);
  const quiet = since(WATCH.alertQuietMs).filter((event) => event.action === ALERT && event.queryKey === current.queryKey);
  const recentlyAlerted = (reason: AlertReason) => quiet.some((event) => event.details?.startsWith(reason));
  const reasons: AlertReason[] = [];
  if (!current.refused && current.observationCount !== undefined) {
    const differing = since(WATCH.differenceWindowMs).some((event) => event.action === SERVED && event.queryKey === current.queryKey &&
      event.observationCount !== undefined && event.observationCount !== current.observationCount &&
      Math.abs(event.observationCount - current.observationCount!) < minimum);
    if (differing) reasons.push('DIFFERENCING');
  }
  const sameQuestion = since(WATCH.burstWindowMs).filter((event) => (event.action === SERVED || event.action === REFUSED) && event.queryKey === current.queryKey).length + 1;
  if (sameQuestion >= WATCH.burstCount) reasons.push('BURST');
  if (current.refused && since(WATCH.burstWindowMs).filter((event) => event.action === REFUSED).length + 1 >= WATCH.refusalCount) reasons.push('PROBING');
  return reasons.filter((reason) => !recentlyAlerted(reason));
}

const describe: Record<AlertReason, string> = {
  DIFFERENCING: 'DIFFERENCING: the same sensitive question returned totals that differ by fewer observations than the threshold',
  BURST: 'BURST: the same sensitive question was asked repeatedly within an hour',
  PROBING: 'PROBING: several sensitive aggregate queries were refused within an hour',
};

/** Records a served or refused sensitive aggregate, then any alert it raises. */
export async function recordSensitiveAggregate(
  audit: CollaborationService,
  event: { collectionId: string; userId: string; formatId: string; input: AnalysisInput; minimum: number; refused?: string; observationCount?: number },
): Promise<AlertReason[]> {
  const queryKey = sensitiveQueryKey(event.input);
  const now = new Date();
  const history = await audit.recentActions(event.collectionId, event.userId, [SERVED, REFUSED, ALERT], new Date(now.getTime() - WATCH.differenceWindowMs));
  const refused = event.refused !== undefined;
  const details = refused
    ? `Data format ${event.formatId}; operation ${event.input.operation}; query ${queryKey}; refused: ${event.refused!.slice(0, 160)}`
    : `Data format ${event.formatId}; operation ${event.input.operation}; query ${queryKey}; observations ${event.observationCount}`;
  await audit.logAction(event.collectionId, event.userId, refused ? REFUSED : SERVED, details, { queryKey, observationCount: event.observationCount });
  const reasons = repeatAlerts(history.map((item) => ({ action: item.action, occurredAt: item.occurredAt, queryKey: item.queryKey, observationCount: item.observationCount, details: item.details })), { refused, queryKey, observationCount: event.observationCount }, event.minimum, now);
  for (const reason of reasons) await audit.logAction(event.collectionId, event.userId, ALERT, `${describe[reason]}; data format ${event.formatId}; query ${queryKey}`, { queryKey });
  return reasons;
}
