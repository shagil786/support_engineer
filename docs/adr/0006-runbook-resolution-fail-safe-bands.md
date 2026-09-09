# ADR-0006: Fail-safe bands for fuzzy runbook resolution

**Status:** Accepted (2026-09-09)

## Context

Resolving a spoken runbook offer to a concrete catalog action is a precision
problem, and the resolver got it wrong in the worst direction. Live-audit
proof: against a catalog holding a harmless `restart-checkout-pod` and a
destructive `db-restart-drill` ("restart the primary database"), the utterance
"please restart the primary database now" resolved — through tier-3
description-keyword matching (shared verb "restart") — to the checkout pod,
whose provider flag said `destructive: false`. The policy engine correctly
trusted that flag over the text, so the wrong action auto-executed with no
approval. The safety design worked exactly as specified; the resolver fed it
the wrong target.

The underlying failure was twofold. First, keyword fuzzy matching is a
different scorer from the one the platform already trusts elsewhere: the
knowledge base's hybrid BM25+vector→RRF→rerank engine that grounds `/ask`
citations. Second, the fuzzy tier had no notion of *how confident* a match
was — any keyword overlap resolved, and resolution auto-executed whenever the
(mis)matched action was non-destructive.

ADR-0003 already mirrors every catalog action into the KB as a `runbook:<id>`
doc carrying `runbookId`/`destructive` metadata. That makes the citation
engine available as the resolution engine — one scorer for "which document
answers the question" and "which action did the speaker mean".

## Decision

`RunbookResolver` (src/pipeline/runbook-resolver.ts) keeps its exact tiers
first — the speaker (or the LLM) naming the action **id**, or the full action
**name** appearing in the text, always resolve with the provider's own flag.
Everything below that is tier 3: hybrid-KB retrieval over the catalog's own
docs, judged by **calibrated fail-safe bands** rather than best-effort
keyword overlap.

The bands are calibrated by measuring the live scoring engine on
catalog-shaped docs — true matches score 1.18–1.53, wrong winners 0.95–1.05,
unrelated queries ≤ 0.2 — and sit in the gap between true and wrong:

- **KB_STRONG = 1.1** — a top hit at or above this is an unambiguous catalog
  match; resolve it (a destructive action still goes to the approval gate via
  its real flag — the band decides *which* action, policy still decides *how*).
- **KB_FLOOR = 0.3** — below this, nothing is a match; refuse outright.
- **KB_TIE = 0.15** — the margin below which the top two hits are a near-tie.

Between the floor and the strong band, resolution is deliberately pessimistic:

- The **top candidate itself is destructive** → resolve it. Its real flag
  routes it into M-of-N approval, so "resolution" here means *a human sees a
  card naming this action* — never auto-execution.
- A **destructive candidate is in a near-tie** with the top hit (top − hit <
  KB_TIE) → stage *that* destructive candidate. When two actions are
  score-indistinguishable and one is destructive, the ambiguity itself is the
  safety signal: put the destructive one in front of a human and let the card
  resolve it.
- A **clear non-destructive winner** below the strong band is an action the
  speaker did not name → refuse with the three closest action ids as a hint.

The invariant: **every fuzzy destructive outcome lands in front of a human;
only confident matches auto-execute.** Executing the wrong action is worse
than executing nothing, and worse than asking.

With no KB wired, tiers 1–2 only apply — the resolver degrades to exact
matches rather than guessing.

### matchedBy provenance

The resolved action carries `matchedBy: 'id' | 'name' | 'kb'`, which rides
the envelope onto the audit spine as `runbookMatchedBy`. An auditor can
distinguish "the speaker named the id" from "retrieval picked it" without
reconstructing the utterance — and every tier-3 resolution is visible as
such.

### The resolver shares the citation scorer structurally

The pipeline depends on a minimal `RunbookSearchPort` (search → scored hits
with metadata) that the platform KB satisfies. The pipeline layer never
imports the concrete knowledge-base class; bootstrap wires the same KB
instance used by `/ask`. If the retrieval engine changes, resolution follows
automatically — the two can never drift apart silently.

## Alternatives considered

- **Keep keyword matching, add a destructive-only guard** — a band-aid on the
  wrong scorer; the mix-up incident was a keyword match, so the engine that
  produced it stays in the path.
- **Refuse all fuzzy matches** — the safest possible posture, but it breaks
  the natural-language product promise ("restart the payment pod" spoken as
  *restart the payment pod* rather than an id) and pushes users toward
  memorizing ids.
- **LLM-based disambiguation of near-ties** — adds a provider dependency to
  the safety-critical path; the whole point of the ladder (ADR-0004) is that
  provider failure must not reach governance, and a deterministic retrieval
  score does not 429.
- **Ask the speaker a clarifying question mid-meeting** — better UX in
  theory; today the staged approval card IS the clarifying question, with an
  audit trail, and a conversational disambiguation loop is unbuilt scope.

## Consequences

- The mix-up incident is closed by construction: replaying the exact incident
  catalog now stages `db-restart-drill` for approval instead of executing
  `restart-checkout-pod`, pinned by tests against the real scorer
  (tests/pipeline/runbook-resolver.test.ts).
- Sub-strong *non-destructive* resolution dies: a paraphrase that scores 0.9
  refuses with hints where the old resolver would have executed. That is the
  intended trade — precision over recall on an execution path.
- The bands are calibrated constants, not a self-tuning mechanism. If the
  retrieval engine's score scale drifts (engine change, different reranker),
  the bands need recalibration — and the band-calibration eval
  (tests/understanding/knowledge/band-calibration.test.ts) re-measures the
  true/wrong-winner/unrelated distributions on the live engine and fails
  when the exported RUNBOOK_BANDS no longer sit inside the measured gap.
  A distribution change fails CI, not a meeting; recalibration is a
  constants edit plus a re-run of the eval.
- Tier 3 requires `runbookId` metadata on KB hits; docs without it are
  filtered, so stray corpus documents can never resolve to an action.
