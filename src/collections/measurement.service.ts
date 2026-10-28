import { BadRequestException, Injectable } from '@nestjs/common';
import { EntryMeasureValueInput } from './collection.input';
import { Entry, EntryMeasureValue, EntryValue } from './entry.schema';

export const MEASURE_STATUSES = ['MEASURED', 'ESTIMATED', 'CALCULATED', 'ABSENT'] as const;
export type MeasureStatus = typeof MEASURE_STATUSES[number];

export const UNCERTAINTY_TYPES = ['ABSOLUTE', 'RELATIVE'] as const;
export type UncertaintyType = typeof UNCERTAINTY_TYPES[number];

@Injectable()
export class MeasurementService {
  validateMeasure(
    input: EntryMeasureValueInput | undefined,
    rawText: string,
    fieldName: string,
  ): { value: string; numberValue?: string; measureValue: EntryMeasureValue } {
    const status = (input?.status?.trim().toUpperCase() || 'MEASURED') as MeasureStatus;
    if (!MEASURE_STATUSES.includes(status)) {
      throw new BadRequestException(`${fieldName} has an invalid measure status: ${input?.status}`);
    }

    let uncertainty: string | undefined;
    let uncertaintyType: string | undefined;
    if (input?.uncertainty !== undefined && input.uncertainty !== null && input.uncertainty.trim() !== '') {
      const uText = input.uncertainty.trim().replace(',', '.');
      const uNum = Number(uText);
      if (!/^[+]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(uText) || !Number.isFinite(uNum) || uNum < 0) {
        throw new BadRequestException(`${fieldName} uncertainty must be a non-negative number`);
      }
      uncertainty = uText;
      uncertaintyType = (input.uncertaintyType?.trim().toUpperCase() || 'ABSOLUTE') as UncertaintyType;
      if (!UNCERTAINTY_TYPES.includes(uncertaintyType as UncertaintyType)) {
        throw new BadRequestException(`${fieldName} uncertainty type must be ABSOLUTE or RELATIVE`);
      }
    }

    if (input?.observedAt) {
      const parsed = Date.parse(input.observedAt);
      if (Number.isNaN(parsed)) {
        throw new BadRequestException(`${fieldName} observedAt must be a valid ISO date/datetime`);
      }
    }

    const recordedAt = input?.recordedAt ? new Date(input.recordedAt).toISOString() : new Date().toISOString();
    const revisedAt = input?.revisedAt ? new Date(input.revisedAt).toISOString() : undefined;

    if (status === 'ABSENT') {
      return {
        value: '',
        measureValue: {
          status: 'ABSENT',
          quality: input?.quality?.trim() || undefined,
          instrument: input?.instrument?.trim() || undefined,
          observedAt: input?.observedAt ? new Date(input.observedAt).toISOString() : undefined,
          recordedAt,
          revisedAt,
          revisionNote: input?.revisionNote?.trim() || undefined,
        },
      };
    }

    const text = rawText.trim().replace(',', '.');
    if (!text || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text) || !Number.isFinite(Number(text))) {
      throw new BadRequestException(`${fieldName} must have a valid numeric value when status is not ABSENT`);
    }

    return {
      value: text,
      numberValue: text,
      measureValue: {
        status,
        uncertainty,
        uncertaintyType,
        quality: input?.quality?.trim() || undefined,
        instrument: input?.instrument?.trim() || undefined,
        observedAt: input?.observedAt ? new Date(input.observedAt).toISOString() : undefined,
        recordedAt,
        revisedAt,
        revisionNote: input?.revisionNote?.trim() || undefined,
      },
    };
  }

  asOfDate(entry: Entry, asOf: string): Entry {
    const targetTime = Date.parse(asOf);
    if (Number.isNaN(targetTime)) {
      throw new BadRequestException('Invalid asOf date');
    }

    if (!entry.revisions || entry.revisions.length === 0) {
      return entry;
    }

    // Sort revisions chronologically
    const sorted = [...entry.revisions].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    
    // Find the latest revision that occurred at or before targetTime
    // If the entry itself was updated later, we look at the history
    let valuesAtTime: EntryValue[] | undefined;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const revTime = new Date(sorted[i].at).getTime();
      if (revTime <= targetTime) {
        valuesAtTime = sorted[i].values;
        break;
      }
    }

    if (!valuesAtTime) {
      // If targetTime is before the first recorded revision, use the earliest revision values
      valuesAtTime = sorted[0].values;
    }

    const doc = typeof (entry as any).toObject === 'function' ? (entry as any).toObject() : entry;
    return {
      ...doc,
      id: entry.id ?? doc._id?.toString(),
      values: valuesAtTime,
    } as Entry;
  }

  propagateUncertainties(
    operation: string,
    items: { value: number; uncertainty?: string; uncertaintyType?: string }[],
  ): { propagatedUncertainty?: string; note?: string } {
    if (items.length === 0) return {};

    const allHaveAbsolute = items.every(
      (item) => item.uncertainty !== undefined && (item.uncertaintyType === 'ABSOLUTE' || !item.uncertaintyType),
    );

    if (!allHaveAbsolute) {
      return { note: 'Incertitude non propagée (données manquantes ou relatives)' };
    }

    const uValues = items.map((item) => Number(item.uncertainty));

    if (operation === 'SUM') {
      const sumSq = uValues.reduce((acc, u) => acc + u * u, 0);
      const res = Math.sqrt(sumSq);
      return { propagatedUncertainty: (Math.round(res * 1000000) / 1000000).toString() };
    }

    if (operation === 'AVERAGE') {
      const sumSq = uValues.reduce((acc, u) => acc + u * u, 0);
      const res = Math.sqrt(sumSq) / items.length;
      return { propagatedUncertainty: (Math.round(res * 1000000) / 1000000).toString() };
    }

    return { note: 'Incertitude non propagée pour cette opération' };
  }
}
