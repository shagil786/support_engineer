/**
 * Scenario synthesis (ADR-0011) — turns shadow-replay divergences into
 * ready-to-add eval scenarios, closing the loop that ADR-0010 opened.
 *
 * ADR-0010's replay refuses a candidate that would change a DECISION the
 * live bundle made on real traffic (recorded on the event spine). But the
 * refusal only protects the NEXT promotion while the spine still holds the
 * traffic; once the spine is pruned, the same silent regression can slip
 * in again because no handwritten scenario ever pinned it. Synthesis makes
 * the divergence durable: each divergence becomes an eval scenario whose
 * `expect` is the RECORDED (live) effect — the behavior real traffic
 * proved — so every future candidate is enforced against it, forever.
 *
 * Guardrails:
 *  - `expect` is always the RECORDED effect (never the candidate's). The
 *    candidate's proposal was REFUSED; refusing a change to proven
 *    behavior should pin the proven behavior.
 *  - PII is redacted before a scenario can be written into policies/
 *    (the repo's never-emit-credit-card invariant). A card number that
 *    appears in recorded args must never survive into a committed YAML.
 *  - Scenarios that already exist (same tool+args+expect) are skipped,
 *    and ids are guaranteed unique against both the existing file and the
 *    batch — EvalRunner fails loud on duplicate ids.
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import type { ShadowDivergence } from './shadow-replay.js';

/** Matches the EvalRunner scenario schema exactly — a synthesized scenario
 *  is byte-compatible with a hand-written one. */
export interface SynthesizedScenario {
  id: string;
  intent: { kind: string; subKind?: string };
  entities: Record<string, unknown>;
  action: { tool: string; args: Record<string, unknown> };
  /** Always the RECORDED (live) effect. */
  expect: 'allow' | 'deny' | 'require_approval';
}

const ScenarioShapeSchema = z.object({
  id: z.string().min(1),
  intent: z.object({ kind: z.string(), subKind: z.string().optional() }).passthrough(),
  entities: z.record(z.string(), z.unknown()).default({}),
  action: z.object({ tool: z.string().min(1), args: z.record(z.string(), z.unknown()).default({}) }),
  expect: z.enum(['allow', 'deny', 'require_approval']),
});

/** A card-shaped token anywhere in a string value. Mirrors the bundle's own
 *  never_emit_credit_card rule so synthesis and policy agree on what is PII. */
const CARD_RE = /\b(?:\d[ -]*?){13,19}\b/g;

export interface SynthesizeOptions {
  divergences: ShadowDivergence[];
  /** The current eval scenarios YAML (for dedupe + id uniqueness). */
  existingScenariosYaml?: string;
}

/** Redacts card-shaped tokens from a value (only strings carry PII). Used
 *  for both args and entities, so no literal card number can reach a
 *  committed policies/ file. */
function redact(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(CARD_RE, '[REDACTED]');
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redact(v);
    return out;
  }
  return value;
}

/** Deterministic canonical form of args for dedupe (key order-insensitive). */
function canonicalArgs(args: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(args).sort()) sorted[k] = args[k];
  return JSON.stringify(sorted);
}

export function synthesizeScenarios(opts: SynthesizeOptions): SynthesizedScenario[] {
  // Parse the existing file (tolerant: a missing/malformed file is treated
  // as empty — synthesis is advisory, not the source of truth).
  const existing: SynthesizedScenario[] = [];
  if (opts.existingScenariosYaml) {
    const parsed: unknown = parseYaml(opts.existingScenariosYaml);
    if (Array.isArray((parsed as { scenarios?: unknown })?.scenarios)) {
      for (const s of (parsed as { scenarios: unknown[] }).scenarios) {
        const shape = ScenarioShapeSchema.safeParse(s);
        if (shape.success) existing.push(shape.data as SynthesizedScenario);
      }
    }
  }

  const existingKeys = new Set(existing.map((s) => `${s.action.tool}|${canonicalArgs(s.action.args)}|${s.expect}`));
  const existingIds = new Set(existing.map((s) => s.id));
  const usedKeys = new Set<string>();
  const usedIds = new Set<string>();

  const out: SynthesizedScenario[] = [];
  for (const d of opts.divergences) {
    const args = redact(d.action.args) as Record<string, unknown>;
    const entities = redact(d.intent.entities) as Record<string, unknown>;
    const effect = d.recorded;
    // The eval scenario schema pins allow/deny/require_approval only — a
    // recorded transform effect has no pinnable expectation, so it cannot
    // become a scenario (and is not silently turned into an unrelated one).
    if (effect !== 'allow' && effect !== 'deny' && effect !== 'require_approval') continue;
    const key = `${d.tool}|${canonicalArgs(args)}|${effect}`;
    if (existingKeys.has(key) || usedKeys.has(key)) continue; // already pinned

    // Unique id: base slug, numeric suffix on collision.
    const base = `shadow_${d.tool}_${effect}`;
    let id = base;
    for (let n = 2; existingIds.has(id) || usedIds.has(id); n++) id = `${base}_${n}`;
    existingIds.add(id);
    usedIds.add(id);
    usedKeys.add(key);

    out.push({
      id,
      intent: {
        kind: d.intent.intent.kind,
        ...('subKind' in d.intent.intent && d.intent.intent.subKind !== undefined ? { subKind: d.intent.intent.subKind } : {}),
      },
      entities,
      action: { tool: d.tool, args },
      expect: effect as SynthesizedScenario['expect'],
    });
  }
  return out;
}
/** Renders synthesized scenarios as a YAML FRAGMENT ready to paste under
 *  the `scenarios:` key of policies/eval/scenarios.yaml. Each entry is
 *  serialized by the same `yaml` library the EvalRunner parses with, and
 *  annotated above with its recorded-traffic provenance (cid + ts). */
export function toScenarioFragmentYaml(
  scenarios: SynthesizedScenario[],
  provenance: ReadonlyMap<string, { correlationId: string; ts: number }> = new Map(),
): string {
  return scenarios
    .map((s) => {
      const src = provenance.get(s.id);
      // Serialize ONE scenario, strip the leading `scenarios:` key — leaves
      // the `  - id: …` entry at the file's two-space list indent.
      const entry = stringifyYaml({ scenarios: [s] as never })
        .split('\n')
        .slice(1)
        .join('\n');
      const note = src
        ? `  # shadow-replay pin (ADR-0011): from cid=${src.correlationId} ts=${src.ts}`
        : '  # shadow-replay pin (ADR-0011)';
      return `${note}\n${entry}`;
    })
    .join('\n') + '\n';
}