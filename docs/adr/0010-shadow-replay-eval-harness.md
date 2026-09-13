# ADR 0010: Shadow-Replay Eval Harness

Date: 2026-09-13
Status: accepted

## Context
The shipped eval suite (`policies/eval/scenarios.yaml`, 26 scenarios) pins
exactly what was hand-written — and only that. Its tool coverage is the tell:
six read-only tools (`query_evidence`, `correlate_changes`, `query_signals`,
`assess_blast_radius`, `verify_remediation`, and `jira_get_issue` beyond a
scenario pinning the tool name) appear in **zero** scenarios. A candidate
bundle that drops `read_only_default_allow` passes the handwritten suite
today while silently default-denying every evidence query in production.
Meanwhile the platform's own event spine records every real governance
decision (`src/event-log/types.ts` `governance` events) — real envelopes,
real actions, real volume — and the PromotionGate already evaluates the
candidate bundle against the handwritten suite. The recorded traffic is the
eval corpus we were not using.

## Decision
Build shadow replay as a plain library (`src/learning/shadow-replay.ts`),
composed from existing parts — no runtime, no new subsystem:

1. **Spine enrichment (additive):** `governance` events gain an optional
   `action` field, populated by `GovernedDispatch` at both emission sites
   (the primary decision and the blast-escalation re-audit). Legacy events
   without `action` remain valid — the discriminated union is additive, so
   nothing else changes shape.
2. **`ShadowReplay`**: replays recorded `governance` events through a policy
   engine and diffs its effects against the recorded decisions. Contract:
   - only events with a recorded `action` replay; action-less events are
     counted (`skipped`), never fatal;
   - the FIRST governance event per `correlationId` is the vote — a second
     event on the same cid is the blast-escalation re-audit, which is
     platform logic layered on top of policy, not new traffic;
   - replay re-runs ONLY the policy engine. The SafetyNet, blast topology,
     and approval gate are code or platform state, not bundle data, so they
     are out of scope by construction;
   - an empty spine (or window) is zero replays and green — a green harness
     must never depend on having traffic; a corrupt spine line is dropped by
     the existing reader (skipped, not fatal), the same fail-soft the JSONL
     log uses everywhere.
3. **Default replay window** = traffic since the current bundle's
   `promotedAt` (inclusive): events decided by OLDER bundles must not vote
   on the candidate. Explicit `from`/`to` overrides for analysis.
4. **PromotionGate integration (fail-closed, opt-in by wiring):** when a
   `shadowReplay` harness is wired, the gate replays the candidate over the
   default window and refuses promotion on ANY divergence — with the same
   error style as a handwritten-eval failure. Unwired gates are unchanged
   (the gate is host-constructed; `createPlatform` does not build one).
   Shadow replay is advisory evidence for humans, not an auto-promoter —
   the M-of-N signature gate stands unchanged.

## Consequences
- The handwritten suite keeps pinning intent ("what we decided this bundle
  must do"); shadow replay pins history ("what this bundle promised the
  live bundle's decisions would keep doing"). Promotion is refused when a
  candidate regresses either.
- The near-miss class is closed: unbundled read-only tools, unpinned
  severity bands, and any rule traffic exercises daily are all guarded by
  recorded reality, not by remembering to write a scenario.
- Fresh deployments replay nothing until they have traffic — expected and
  harmless; the handwritten suite still guards those.
- A spike in divergences at promotion time is itself signal: it surfaces
  envelope/action shapes the handwritten suite never imagined (the failure
  report includes cid, ts, tool, both effects, and the window used).
- If replay volume ever becomes a promotion-latency problem, the window
  can shrink (the JSONL reader is day-segmented and streams); no format
  change needed.
- Deliberately NOT built (matching the platform's v1 discipline): no
  shadow "what-if" HTTP surface, no divergence metrics/alerts — promotion
  is the single enforcement point and it is human-gated regardless.

## As-built addendum (same day)

Two consumption surfaces shipped with it, completing the loop:

- **`Platform.shadowReplay`** — `createPlatform` wires a `ShadowReplay`
  over the platform's event spine and the live bundle's engine. Hosts pass
  the handle to their PromotionGate's `shadowReplay` option (the gate
  swaps in the candidate engine at promotion time) or call `run()` for a
  drift report — the live bundle re-replayed against its own recorded
  decisions must yield zero divergences.
- **`npm run replay`** (`scripts/replay.ts`) — the ops-facing report,
  mirroring `scripts/eval.ts`:
  `npm run replay [-- --bundle <path>] [--from <ms>] [--to <ms>] [--promoted-at <ms>]`.
  No `--bundle` replays the live bundle (drift check, exit 1 on any
  divergence); `--bundle` previews a candidate (exit 1 = this bundle would
  change real decisions); `--promoted-at` scopes the window to traffic
  since the live bundle's promotion stamp (read it from your PolicyStore);
  exit 2 = usage/IO error. Exit 1 is CI-gateable, so a drift check can run
  on the same ladder as the eval CLI.

