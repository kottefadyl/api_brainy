import { BadRequestException } from '@nestjs/common';
import type { SavedCollectionViewInput } from './collection.input.js';
import type { Collection } from './collection.schema.js';

/** Day and Calendar task views exist only where the planner is set up, on its data format. */
export function assertTaskPlannerView(collection: Collection, input: SavedCollectionViewInput): void {
  if (!['TASK_DAY', 'TASK_CALENDAR'].includes(input.layout)) return;
  if (!collection.taskPlanner || collection.templateId !== 'tasks') throw new BadRequestException('Day and calendar task views belong to the Task list template');
  if (input.formatIds.length !== 1 || input.formatIds[0] !== collection.taskPlanner.formatId || input.sort === 'MANUAL') throw new BadRequestException('A task view needs the task data format');
}
