import { BadRequestException, Injectable } from '@nestjs/common';
import { AnalysisService } from './analysis.service';
import { ForecastInput, ForecastPoint, ForecastResult } from './forecast.input';
import { decimal } from './unit_math';

@Injectable()
export class ForecastService {
  constructor(private readonly analysis: AnalysisService) {}

  async forecast(collectionId: string, ownerId: string, input: ForecastInput): Promise<ForecastResult> {
    if (!['MEAN', 'LINEAR'].includes(input.method) || !['DAY', 'MONTH'].includes(input.frequency)) throw new BadRequestException('Choose a supported forecast method and frequency');
    if (!Number.isInteger(input.horizon) || input.horizon < 1 || input.horizon > 12 || !Number.isInteger(input.holdout) || input.holdout < 2 || input.holdout > 12) throw new BadRequestException('Choose a horizon of 1–12 and at least two held-out periods');
    if (!['EVENT', 'SNAPSHOT', 'RATE'].includes(input.measureKind)) throw new BadRequestException('Choose a measure kind');
    const result = await this.analysis.analyse(collectionId, ownerId, {
      formatId: input.formatId, fieldId: input.fieldId, dateFieldId: input.dateFieldId,
      groupBy: input.frequency, operation: input.measureKind === 'EVENT' ? 'SUM' : 'AVERAGE',
      measureKind: input.measureKind, from: input.from, to: input.to,
    });
    const rows = result.rows.filter((row) => /^\d{4}-\d{2}(-\d{2})?$/.test(row.group)).sort((a, b) => a.group.localeCompare(b.group));
    if (rows.length < Math.max(6, input.holdout + 4)) throw new BadRequestException('At least six compatible periods are needed, including four training periods');
    if (rows.length > 500) throw new BadRequestException('Choose a shorter source period (maximum 500 periods)');
    const nextDate = (date: string, steps: number) => {
      const [year, month, day] = date.split('-').map(Number);
      const value = input.frequency === 'MONTH' ? new Date(Date.UTC(year, month - 1 + steps, 1)) : new Date(Date.UTC(year, month - 1, day + steps));
      return value.toISOString().slice(0, input.frequency === 'MONTH' ? 7 : 10);
    };
    for (let index = 1; index < rows.length; index++) if (rows[index].group !== nextDate(rows[index - 1].group, 1)) throw new BadRequestException('The source series has missing periods; fill or narrow the period before forecasting');
    const values = rows.map((row) => { const value = decimal(row.value); const number = Number(value.n) / Number(value.d); if (!Number.isFinite(number)) throw new BadRequestException('A source value is too large'); return number; });
    const trainCount = values.length - input.holdout;
    const training = values.slice(0, trainCount);
    const predict = (series: number[], step: number): number => {
      if (input.method === 'MEAN') return series.reduce((sum, value) => sum + value, 0) / series.length;
      const middle = (series.length - 1) / 2;
      const mean = series.reduce((sum, value) => sum + value, 0) / series.length;
      const slope = series.reduce((sum, value, index) => sum + (index - middle) * (value - mean), 0) / series.reduce((sum, _, index) => sum + (index - middle) ** 2, 0);
      return mean + slope * (step - middle);
    };
    const positive = (value: number) => input.measureKind === 'EVENT' ? Math.max(0, value) : value;
    const rounded = (value: number) => String(Math.round(value * 1000) / 1000);
    const validation = values.slice(trainCount).map((observed, index) => ({ observed, estimate: positive(predict(training, trainCount + index)) }));
    const mae = validation.reduce((sum, point) => sum + Math.abs(point.observed - point.estimate), 0) / validation.length;
    const residual = training.reduce((sum, value, index) => sum + Math.abs(value - positive(predict(training, index))), 0) / training.length;
    const uncertainty = Math.max(mae, residual);
    const point = (date: string, estimate: number, observed?: number): ForecastPoint => ({ date, estimate: rounded(estimate), lower: rounded(positive(estimate - uncertainty)), upper: rounded(estimate + uncertainty), ...(observed === undefined ? {} : { observed: rounded(observed) }) });
    return {
      method: input.method, frequency: input.frequency, sourceFrom: rows[0].group, sourceTo: rows.at(-1)!.group,
      trainingCount: trainCount, holdoutCount: input.holdout, holdoutMae: rounded(mae), uncertainty: rounded(uncertainty),
      unit: result.unit, dimension: result.dimension,
      observations: rows.slice(0, trainCount).map((row, index) => point(row.group, values[index], values[index])),
      validation: rows.slice(trainCount).map((row, index) => point(row.group, validation[index].estimate, validation[index].observed)),
      forecast: Array.from({ length: input.horizon }, (_, index) => point(nextDate(rows.at(-1)!.group, index + 1), positive(predict(values, values.length + index)))),
    };
  }
}
