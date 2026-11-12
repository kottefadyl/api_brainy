import { BadRequestException } from '@nestjs/common';
import { RelationKind } from './relation.schema.js';

export type GraphEdge = { fromEntryId: string; toEntryId: string; kind: RelationKind };

export function graphNodes(edges: GraphEdge[], root: string, kind: RelationKind, depthLimit = 32): string[] {
  const children = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== kind) continue;
    const parent = kind === RelationKind.PARENT ? edge.toEntryId : edge.fromEntryId;
    const child = kind === RelationKind.PARENT ? edge.fromEntryId : edge.toEntryId;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const reachable = new Set<string>([root]);
  const pending = [root];
  for (let index = 0; index < pending.length; index++) for (const child of children.get(pending[index]) ?? []) if (!reachable.has(child)) { reachable.add(child); pending.push(child); }
  const incoming = new Map([...reachable].map((id) => [id, 0]));
  for (const [parent, descendants] of children) if (reachable.has(parent)) for (const child of descendants) incoming.set(child, (incoming.get(child) ?? 0) + 1);
  const ready = [...reachable].filter((id) => incoming.get(id) === 0);
  const depth = new Map<string, number>([[root, 0]]);
  const result: string[] = [];
  for (let index = 0; index < ready.length; index++) {
    const id = ready[index]; result.push(id);
    for (const child of children.get(id) ?? []) {
      depth.set(child, Math.max(depth.get(child) ?? 0, (depth.get(id) ?? 0) + 1));
      if (depth.get(child)! > depthLimit) throw new BadRequestException('Relation depth limit exceeded');
      incoming.set(child, incoming.get(child)! - 1);
      if (incoming.get(child) === 0) ready.push(child);
    }
  }
  if (result.length !== reachable.size) throw new BadRequestException('Relation cycle detected');
  return result;
}

export function validateNewEdge(edges: GraphEdge[], edge: GraphEdge): void {
  if (edge.fromEntryId === edge.toEntryId) throw new BadRequestException('Choose another entry');
  if (edge.kind === RelationKind.ASSOCIATION) return;
  if (edge.kind === RelationKind.PARENT && edges.some((item) => item.kind === RelationKind.PARENT && item.fromEntryId === edge.fromEntryId && item.toEntryId !== edge.toEntryId)) throw new BadRequestException('This entry already has a parent');
  graphNodes([...edges, edge], edge.kind === RelationKind.PARENT ? edge.toEntryId : edge.fromEntryId, edge.kind);
}
