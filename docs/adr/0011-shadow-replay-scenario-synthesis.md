# ADR 0011: Shadow-Replay Scenario Synthesis

Date: 2026-09-13
Status: accepted

## Context
ADR-0010's shadow replay refuses a candidate that would change a decision
the live bundle made on real traffic — but the refusal is only as durable
as the event spine. Once the spine is pruned (or a deployment resets),
nothing prevents the same silent regression from slipping in again: no
handwritten scenario ever pinned it, because we never knew the traffic
shape until the replay surfaced it. The loop was one-directional —
recording caught the change, then the lesson evaporated.

## Decision
Close the loop: turn every replay divergence into a ready-to-add eval
scenario. `src/learning/scenario-synthesis.ts` provides:

1. **`synthesizeScenarios`** — maps each `ShadowDivergence` to a
   `SynthesizedScenario` whose `expect` is the **RECORDED** (live) effect.
   The candidate's proposal was refused; refusing a change to proven
   behavior pins the proven behavior, not the proposal. Traffic shape
   (intent kind/subKind, entities, action tool/args) is preserved from the
   recorded event.
2. **Guardrails**:
   - **PII redaction** — a card-shaped token in recorded args *or* entities
     is replaced with `[REDACTED]` before anything can reach a committed
     `policies/` file (the repo's never-emit-credit-card invariant).
   - **Dedup** — scenarios already present (same tool + args + expect) in
     the shipped `policies/eval/scenarios.yaml`, or already produced within
     the batch, are skipped.
   - **Unique ids** — base `shadow_<tool>_<effect>`, numeric suffix on
     collision; EvalRunner fails loud on duplicate ids, so synthesis
     guarantees uniqueness against both the existing file and the batch.
   - **Effect guard** — a recorded `transform` effect has no pinnable eval
     expectation (the scenario schema accepts allow/deny/require_approval),
     so it is skipped, never silently converted.
3. **`toScenarioFragmentYaml`** — renders the pins as a YAML fragment
   (serialized with the same `yaml` library EvalRunner parses with) ready
   to paste under `scenarios:` in `policies/eval/scenarios.yaml`, each
   entry annotated with its recorded-traffic provenance
   (`cid=<id> ts=<ms>`).

Surfaces:
- **PromotionGate** — when a candidate is refused by shadow replay, the
  error message now includes how many divergences would pin as eval
  scenarios and renders the first two as a fragment. The refusal still
  stands unconditionally; synthesis is advisory reporting inside it.
- **`npm run replay --synthesize [file]`** — drift checks / candidate
  previews can emit the same fragment to stdout or to a file.

## Consequences
- A divergence that blocked a candidate can now become a permanent
  regression test, so the policy suite grows in the direction real traffic
  actually exercises it — the recorded corpus teaches the handwritten one.
- The operator makes the call on whether to add the pin; synthesis never
  writes to `policies/eval/scenarios.yaml` automatically. Promotion still
  requires the M-of-N signature gate (unchanged).
- Pinned scenarios are enforce-only-as-recorded: if live traffic shows a
  shape that should be *re-examined* (not preserved), the divergence
  report is the place to decide; auto-pinning the old effect is the safe
  default, not an override of governance judgment.
- Volume: dedup keeps the suite from unbounded growth — an already-pinned
  divergence adds nothing. Worst case (many genuinely new shapes) is new
  pins until the traffic surface is covered, which is the point.

## Non-goals (deliberate)
- No automatic write-back into the shipped scenarios file.
- No divergence-rate metrics or alerts (ADR-0010's deferred items stay
  deferred — promotion and human review remain the enforcement point).