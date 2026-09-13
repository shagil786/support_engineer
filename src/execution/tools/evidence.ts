/**
 * query_evidence executor — read-only subgraph lookup for the investigator.
 * Unwired graph → honest "not configured", never an invented graph.
 */
import type { z } from 'zod';
import type { ToolResult } from '../../support-voice-agent/tools/types.js';
import type { ToolContext } from './registry.js';
import type { EvidenceNodeKind } from '../../evidence/types.js';

type Args = z.output<typeof import('./registry.js').TOOL_REGISTRY['query_evidence']['schema']>;

export async function queryEvidence(args: Args, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.evidenceGraph) {
    return { ok: false, error: 'query_evidence unavailable — evidence graph not configured' };
  }
  const kinds = args.kinds as EvidenceNodeKind[] | undefined;
  const limit = args.limit ?? 20;
  const serviceId = `svc:${args.service}`;
  const anchor = ctx.evidenceGraph.get(serviceId) ?? ctx.evidenceGraph.byKind('service').find((n) => n.label === args.service);
  if (!anchor) return { ok: true, data: { service: args.service, nodes: [], edges: [] } };
  const seen = new Map<string, (typeof anchor)>();
  seen.set(anchor.id, anchor);
  for (const { node } of ctx.evidenceGraph.neighbors(anchor.id)) {
    if (kinds && !kinds.includes(node.kind)) continue;
    if (!seen.has(node.id)) seen.set(node.id, node);
    if (seen.size >= limit) break;
  }
  const ids = new Set(seen.keys());
  const edges = ctx.evidenceGraph.snapshot().edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  return { ok: true, data: { service: args.service, anchor: anchor.id, nodes: [...seen.values()], edges } };
}
