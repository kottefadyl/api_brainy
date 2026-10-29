import { BadRequestException } from '@nestjs/common';
import { CollectionFormat, FieldKind } from './collection.schema';
import { EntryValue } from './entry.schema';
import { WorkflowDefinition, WorkflowDefinitionInput, WorkflowEvent, WorkflowEventImportInput } from './workflow.schema';

export function validateWorkflowDefinition(format: CollectionFormat, input: WorkflowDefinitionInput): WorkflowDefinition {
  const field = format.fields.find((item) => item.id === input.stateFieldId);
  const states = field?.options ?? [];
  if (!field || field.kind !== FieldKind.SELECT || states.length < 2 || states.length > 20 || new Set(states).size !== states.length || states.some((state) => !state.trim())) {
    throw new BadRequestException('Choose a single-choice field with 2 to 20 distinct states');
  }
  if (!states.includes(input.initialState)) throw new BadRequestException('Choose an initial state from the field choices');
  if (!input.transitions.length || input.transitions.length > 100) throw new BadRequestException('Choose 1 to 100 transitions');
  const seen = new Set<string>();
  for (const transition of input.transitions) {
    const key = JSON.stringify([transition.from, transition.to]);
    if (!states.includes(transition.from) || !states.includes(transition.to) || transition.from === transition.to || seen.has(key) || !['OWNER', 'EDITOR'].includes(transition.minimumRole)) {
      throw new BadRequestException('Choose distinct allowed transitions and an owner or editor role');
    }
    seen.add(key);
  }
  if (input.requirements.length > states.length) throw new BadRequestException('Too many state requirements');
  const requiredStates = new Set<string>();
  for (const requirement of input.requirements) {
    if (!states.includes(requirement.state) || requiredStates.has(requirement.state) || requirement.fieldIds.length > format.fields.length || new Set(requirement.fieldIds).size !== requirement.fieldIds.length || requirement.fieldIds.some((id) => id === field.id || !format.fields.some((item) => item.id === id))) {
      throw new BadRequestException('Choose valid required fields for each state');
    }
    requiredStates.add(requirement.state);
  }
  return { stateFieldId: field.id, initialState: input.initialState, transitions: input.transitions, requirements: input.requirements };
}

export function workflowState(format: CollectionFormat, values: EntryValue[]): string | undefined {
  return format.workflow ? values.find((item) => item.fieldId === format.workflow!.stateFieldId)?.value : undefined;
}

export function assertWorkflowRequirements(format: CollectionFormat, values: EntryValue[], state: string): void {
  const requirement = format.workflow?.requirements.find((item) => item.state === state);
  for (const fieldId of requirement?.fieldIds ?? []) {
    if (!values.some((item) => item.fieldId === fieldId && item.value.trim())) {
      const name = format.fields.find((item) => item.id === fieldId)?.name ?? fieldId;
      throw new BadRequestException(`Fill in ${name} before entering ${state}`);
    }
  }
}

export function prepareWorkflowCreate(format: CollectionFormat, values: EntryValue[]): EntryValue[] {
  if (!format.workflow) return values;
  const current = workflowState(format, values);
  if (current && current !== format.workflow.initialState) throw new BadRequestException('Start this entry in the initial state');
  const next = current ? values : [...values, { fieldId: format.workflow.stateFieldId, value: format.workflow.initialState }];
  assertWorkflowRequirements(format, next, format.workflow.initialState);
  return next;
}

export function assertWorkflowEdit(format: CollectionFormat, before: EntryValue[], after: EntryValue[]): void {
  if (!format.workflow) return;
  const previous = workflowState(format, before);
  if (!previous || workflowState(format, after) !== previous) throw new BadRequestException('Change the state with a workflow transition');
  assertWorkflowRequirements(format, after, previous);
}

export function prepareWorkflowImport(format: CollectionFormat, values: EntryValue[]): EntryValue[] {
  if (!format.workflow) return values;
  const states = format.fields.find((field) => field.id === format.workflow!.stateFieldId)?.options ?? [];
  const current = workflowState(format, values);
  if (current && !states.includes(current)) throw new BadRequestException('Imported workflow state is not available in this data format');
  const next = current ? values : [...values, { fieldId: format.workflow.stateFieldId, value: format.workflow.initialState }];
  assertWorkflowRequirements(format, next, current ?? format.workflow.initialState);
  return next;
}

export function importedWorkflowHistory(format: CollectionFormat, values: EntryValue[], source: WorkflowEventImportInput[] | undefined, actorUserId: string, importedAt: Date): WorkflowEvent[] | undefined {
  if (!format.workflow) {
    if (source?.length) throw new BadRequestException('This data format has no workflow for imported transitions');
    return undefined;
  }
  if (source && source.length > 2000) throw new BadRequestException('Import at most 2000 workflow events per entry');
  const states = format.fields.find((field) => field.id === format.workflow!.stateFieldId)?.options ?? [];
  const current = workflowState(format, values)!;
  const history: WorkflowEvent[] = [];
  let previous = 0;
  let lastState: string | undefined;
  for (const item of source ?? []) {
    const at = new Date(item.at);
    if (!['TRANSITION', 'ASSIGNMENT', 'IMPORTED_TRANSITION', 'IMPORTED_ASSIGNMENT', 'IMPORTED_STATE'].includes(item.kind) || !states.includes(item.from) || !states.includes(item.to) || !item.actorUserId || item.actorUserId.length > 100 || !Number.isFinite(at.getTime()) || at.getTime() < previous || at > importedAt) {
      throw new BadRequestException('Invalid imported workflow history');
    }
    if (item.dueAt && !Number.isFinite(Date.parse(item.dueAt))) throw new BadRequestException('Invalid imported workflow due date');
    if ((lastState && item.from !== lastState) || (item.kind.includes('ASSIGNMENT') && item.to !== item.from) || (item.kind.includes('TRANSITION') && item.to === item.from)) {
      throw new BadRequestException('Imported workflow history has a broken state sequence');
    }
    previous = at.getTime();
    lastState = item.to;
    history.push({ kind: item.kind.startsWith('IMPORTED_') ? item.kind : `IMPORTED_${item.kind}`, from: item.from, to: item.to, actorUserId: item.actorUserId, at, assigneeUserId: item.assigneeUserId, dueAt: item.dueAt ? new Date(item.dueAt) : undefined });
  }
  if (history.length && history.at(-1)!.to !== current) throw new BadRequestException('Imported workflow history does not match the current state');
  if (!history.length && current !== format.workflow.initialState) history.push({ kind: 'IMPORTED_STATE', from: format.workflow.initialState, to: current, actorUserId, at: importedAt });
  return history;
}
