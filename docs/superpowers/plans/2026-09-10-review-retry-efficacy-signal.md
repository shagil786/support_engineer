# Plan: Review-retry efficacy signal (2026-09-10)

## Context

The reviewer-feedback retry loop (2026-09-10) put
`agent_outcome.stats.reviewRetries` on the event spine but nothing consumes
it. This plan feeds that signal into the learning layer so recovered requests
inform promotion decisions — the consumption half of the loop.

The promotion decision at risk is `destructive_runbook_requires_admin_approval`
(`approver_count: 2`). The SuggestionQueue's relaxation heuristic counts
destructive approvals; without the retry signal it cannot distinguish a calm
process from one where reviews are doing real repair work before every grant.

## Signal path (existing pipeline, no new plumbing)

`agent_outcome.stats.reviewRetries` flows through the two existing consumers
of the spine:

1. **OutcomeRecorder** joins per-correlationId events into OutcomeRecords
   (what SuggestionQueue reads). It already copies the whole `agent_outcome`
   finalResult; add the outcome event's `stats.reviewRetries` as an additive
   optional `reviewRetries` field (absent for legacy records).
2. **EfficacyTracker** aggregates `agent_outcome.stats` into the snapshot
   (what the cron persists for humans + `applyFeedback()`). The
   `OutcomeStats` parser gains `reviewRetries?: number`; the pipeline bucket
   gains:
   - `retried` — requests that spent review-retry budget;
   - `recovered` — of those, the ones whose final outcome was ok
     (true recoveries, per finalResult.ok);
   - `recoveryRate` — recovered / retried (0 when none retried);
   - `avgReviewRetries` — mean retries over served pipeline requests.

   Procedure-served requests never carry `reviewRetries` (the procedure
   short-circuit runs no reviews), so only the pipeline bucket changes.

## Guard: stand down relaxation while retries are load-bearing

`SuggestionQueue.scan()` gains one check: when ≥ 50% of approval-carrying
outcomes in the window used retry budget, destructive-approval relaxation is
WITHHELD — the queue returns `[]` for that heuristic instead of proposing
`approver_count: 1`. Rationale on the record: a review that passes only after
a re-dance is evidence the pre-grant bar is doing real work, not ceremony.
This is the conservative direction (fewer auto-suggestions), fail-closed for
the human gate, and needs no PromotionGate change: the gate still re-evals
everything it is handed. No new suggestion type is added — an honest
"keep the bar" needs no proposal.

## Tasks (TDD)

1. `tests/learning/outcome-recorder.test.ts` — an `agent_outcome` event with
   `stats.reviewRetries` lands on the record; a legacy event leaves the field
   absent.
2. `tests/learning/efficacy-tracker.test.ts` — parse + aggregate retried,
   recovered, recoveryRate, avgReviewRetries; absent stats keep legacy shape.
3. `tests/learning/suggestion-queue.test.ts` — relaxation stands down above
   the 50% retry ratio and proceeds below it; malformed/absent fields count
   as 0 retries.
4. Implement the three modules.
5. Docs: OPERATIONS.md efficacy snapshot notes + spec Phase 5 as-built line.

## Out of scope

- Weighting ProcedureSpec successRate by retries (procedure paths never
  retry; nothing to weight).
- New PromotionGate logic — the queue's stand-down is the guard.
- Suggesting `approver_count` *raises* — over-tightening is the gate's
  refusal doctrine, not a heuristic's.
