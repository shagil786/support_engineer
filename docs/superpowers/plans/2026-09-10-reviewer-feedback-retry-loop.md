# Plan: Reviewer-feedback retry loop (2026-09-10)

## Context

Spec §0.2 (Phase 4) records the gap: "**No reviewer-feedback retry loop** — a
`fail` verdict ends the request `ok=false` (retry-with-feedback is future
work)." Today, when the pre-action review (Supervisor step 3) returns
`verdict: 'fail'`, the run dies even though the failure is cheap to repair:
the reviewer's `feedback` names what's missing, the investigators can go get
it, and nothing irreversible has happened yet — the governed action has not
executed. A P0 utterance dies because the first review found the trace thin.

This plan builds the bounded retry. The final review (step 6) is unchanged:
there, the work is done and a `fail` must still end the request `ok=false`.

## Design

- **One retry by default.** `SupervisorOptions.maxReviewRetries` (default 1,
  floor 0). `0` restores today's fail-fast behavior exactly. The budget
  covers the retry cycle (triage → investigate → review), not the final
  review.
- **The reviewer's `reask` verdict finally has a consumer.** `fail` (correction
  needed) spends budget and retries; `reask` (question for humans) never did
  and never will retry — it ends the request with the reviewer's feedback.
- **The whole pre-action dance re-runs, not just the review.** Retry =
  triage → investigator → execute its (read-only) plan → review again. The
  reviewer sees the refreshed live trace (same 60 s window as the first
  pass). Planners are injected `LlmAgent`s, so the second pass is real work,
  not a re-read of stale context.
- **Caps stay fail-closed and shared.** Hops, tokens, wall clock, and
  identical-tool-call loop detection are not reset on retry; the same
  `hops`/`tokenCalls` counters keep climbing. A retry can therefore die of
  the hop cap mid-cycle — the budget widens fidelity, never the caps.
- **The governed action is never re-decided.** Retry loops only over steps
  1–3; the action's approval (`governed.decision`) is carried through
  unchanged. The mutation itself still runs exactly once, after the first
  non-fail review.
- **Observed on the spine, not silent.** `agent_outcome.stats` gains an
  additive optional `reviewRetries` count (like `procedureId`/`fallbackFrom`,
  absent when 0 — legacy events unaffected). A persistent failure's `reason`
  concatenates every distinct reviewer feedback, so the outcome record shows
  *why the budget ran out*, not just the last complaint.
- **Reviewer prompt states the contract.** `ReviewerAgent.systemPrompt` gains
  explicit semantics: `fail` = correctable, feedback must name the fix;
  `pass` = good; `reask` = unresolvable, ask a human. No behavior change for
  the agent class itself.
- **Wiring.** `SUPERVISOR_MAX_REVIEW_RETRIES` (floor 0) joins the other
  `SUPERVISOR_*` caps: `configFromEnv` → `supervisorCaps` → spread into
  `SupervisorAgent` (bootstrap already spreads, so only the type widens).
  `.env.example` and OPERATIONS.md document it.
- **Degradation is untouched.** An unwired/failing reviewer falls back to
  `pass` (existing `LlmAgent` ladder) — no retries are spent on fallback
  passes, and the deterministic floor neither triggers nor consumes budget.

## Tasks (TDD)

1. **Tests first** (`tests/execution/supervisor.test.ts`, new describe block;
   `tests/config.test.ts`):
   - first review `fail` → re-dance (investigator runs twice) → review
     `pass` → run completes `ok=true`;
   - persistent `fail` → budget exhausts → `ok=false`, reason carries both
     feedback strings;
   - `maxReviewRetries: 0` → exactly one review call, fail-fast (legacy);
   - retry consumes shared caps → hop cap trips mid-retry;
   - `reviewRetries` lands on the `agent_outcome` event stats;
   - config parses `SUPERVISOR_MAX_REVIEW_RETRIES` with floor 0.
2. **Event type**: additive optional `reviewRetries?: number` on
   `agent_outcome.stats` (`src/event-log/types.ts`).
3. **Supervisor**: option + default, step-3 retry loop, `reask` fail path,
   stats on both outcome emits, `reason` accumulation.
4. **ReviewerAgent prompt**: the verdict contract.
5. **Config + bootstrap + `.env.example` + OPERATIONS.md**.

## Out of scope

- Retrying after the governed action executed (step 6 `fail` still final).
- Per-verdict retry budgets; reviewer-driven argument surgery on the action.
- Learning-layer consumption of `reviewRetries` (efficacy tracker can use it
  later; the event lands first).
