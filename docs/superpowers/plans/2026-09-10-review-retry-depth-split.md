# Plan: Split review_retries by retry depth (one-shot vs thrash)

**Date:** 2026-09-10
**Follows:** `2026-09-10-review-retry-metrics.md` (metric + panel + alert addendum).

## Problem

`support_agent_review_retries_total{outcome=…}` counts runs that needed a re-dance, but a
healthy system (reviewer feedback lands, one repair) and a thrashing one (the reviewer keeps
rejecting, the re-plan keeps missing) look identical. Retry depth is the discriminator the
producer already records — `stats.reviewRetries` is the count, not a boolean — it just isn't
surfaced.

## Design

**Renderer** (`src/http/metrics.ts`) — extend the family with a `depth` label:

```
support_agent_review_retries_total{outcome="retried",depth="one_shot"}   N
support_agent_review_retries_total{outcome="retried",depth="repeated"}   N
support_agent_review_retries_total{outcome="recovered",depth="one_shot"} N
support_agent_review_retries_total{outcome="recovered",depth="repeated"} N
support_agent_review_retries_total{outcome="failed",depth="one_shot"}    N
support_agent_review_retries_total{outcome="failed",depth="repeated"}    N
```

- Buckets: `reviewRetries == 1` → `one_shot`; `>= 2` → `repeated`. Deliberately coarse —
  "did the first repair land?" is the operational question; exact counts are in the event log.
- Full cross-product of outcome x depth, explicit zeros like today, so **no duplicate
  aggregates**: `sum by (outcome)` over the family reconstructs the pre-split totals — every
  existing query, dashboard panel, and the recovery alert keep their exact meaning.
- Depth family is only meaningful for pipeline-sourced outcomes (procedures never retry);
  that's inherent in the event, no new gating needed.

**Dashboard** — the existing timeseries switches to `sum by (outcome, depth)` (6 series) and
its description names the reading; a new `SupportAgentReviewThrashShare` stat panel charts
`100 * repeated / retried` with thresholds (green low, red high — thrash is bad). The
recovery-rate stat panel is untouched.

**Alerts** — recovery alert untouched (still ratio over all depths). New
`SupportAgentReviewThrash`: `increase(...{depth="repeated",outcome="retried"}[6h]) > 3`,
warning, no for-duration (volume signal, like VetoSpike) — same volume-gating philosophy so
sparse traffic can't fire it.

**Contract pins (TDD first):**
- `tests/http/metrics.test.ts` — depth series from mixed fixtures (1 retry, 2 retries),
  zero-state renders all six series, `sum by (outcome)` reconstruction asserted.
- `tests/dashboard.test.ts` — forward/reverse pins keep passing (both directions exercise the
  new label); thrash-share panel pinned to divide `depth="repeated"` by the family.
- `tests/alerts.test.ts` — new thrash alert in the class list; seeds gain a repeated-depth
  event; negative pins: recovery ratio must not reference `depth` (stays depth-blind) and
  thrash must use `depth="repeated"` on `outcome="retried"`.

**Docs** — OPERATIONS.md metric enumeration + alerting bullet; spec Phase 4 phrase gains the
depth split; plan doc filed.

## Non-goals

- No per-count depth cardinality (`depth="2"`, `"3"`, …) — bounded labels, coarse question.
- No change to OutcomeRecord/EfficacyTracker shapes (the tracker already carries
  `avgReviewRetries` for the learning view; this is the ops view).
- No change to the producer (`stats.reviewRetries` already records the count).

## Bounds

`src/http/metrics.ts` (aggregation + render), `deploy/grafana/support-agent-dashboard.json`
(targets + one stat panel), `deploy/prometheus/support-agent-alerts.yml` (+1 rule + header
class list), the three contract tests, OPERATIONS.md + spec phrases, plan doc. Nothing else.
