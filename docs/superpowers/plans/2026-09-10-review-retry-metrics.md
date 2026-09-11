# Plan: Review-retry recovery metrics (Prometheus + Grafana panel)

**Date:** 2026-09-10
**Follows:** `2026-09-10-reviewer-feedback-retry-loop.md` (the `stats.reviewRetries` producer) and `2026-09-10-review-retry-efficacy-signal.md` (the learning-layer consumer).

## Problem

`agent_outcome` events carry additive `stats.reviewRetries`, the efficacy tracker aggregates
`retried`/`recovered`/`recoveryRate`, but `/metrics` and the Grafana dashboard are blind to it.
An on-call cannot see whether the review-repair loop is quietly saving runs — or firing constantly.
The approval metrics set the pattern: a metric family + dashboard panels, pinned in both
directions by `tests/dashboard.test.ts`.

## Design

**Metric family** — `support_agent_review_retries_total{outcome="retried"|"recovered"|"failed"}`
(counter, emitted with explicit zeros like the approvals family so panels always render):

- `retried` — every `agent_outcome` event with `stats.reviewRetries >= 1` (a run that passed
  review only after a re-dance). Counts *runs*, not retry cycles, mirroring the efficacy
  tracker's definition of `retried`.
- `recovered` — subset whose `finalResult.ok === true`.
- `failed` — subset whose `finalResult.ok === false`.

Legacy events (`stats` absent or `reviewRetries` absent/0) are never counted. Recovery rate is
a PromQL ratio, not a stored metric: `recovered / retried` — same convention as the dashboard's
other derived stats.

**Dashboard** — new row "Review quality" between "Governed runs & policy" and "Human approvals":

1. Stat panel: review **recovery rate** (`100 * recovered / retried`, percent unit).
2. Timeseries: **retried vs recovered vs failed** rate by `outcome`.

**Contract pins (TDD, failing first):**

- `tests/http/metrics.test.ts` — the three series aggregate from mixed events; `reviewRetries: 0`
  and legacy events are excluded; the zero-state renders in the empty-log test.
- `tests/dashboard.test.ts` — seed a retried event in `seededRender`; new test pins the
  recovery-rate panel arithmetic (divides `outcome="recovered"` by `outcome="retried"`), so a
  label-value typo blanks the panel in CI instead of Grafana.

**Docs** — `docs/OPERATIONS.md` metric enumeration + dashboard description; spec Phase 5
as-built note gains one line.

## Non-goals

- ~~No new alert rule~~ — superseded same day: `SupportAgentReviewRecoveryLow` was added to
  `deploy/prometheus/support-agent-alerts.yml` (see Addendum).
- No histogram/latency for retries: the retry count is small and the rate is the signal.

## Addendum (2026-09-10, same-day follow-up)

`SupportAgentReviewRecoveryLow` (warning): `increase(recovered[6h]) / clamp_min(increase(retried[6h]), 1)
< 0.8 and on(instance) increase(retried[6h]) > 3` — 6h window for a few supervisor cycles of
signal, `for: 15m` so brief sags ride out, and an `and`-gated volume floor (≥ 4 retried runs)
so sparse traffic can't divide by near-noise and fire on one unlucky request. `clamp_min(…, 1)`
keeps a zero-retry window from alerting on silence; the two-sided `sum by (instance)` pairs
must share the identical window for the ratio to be per-instance honest. `tests/alerts.test.ts`
seeds one recovered + one failed retry event and pins the ratio's operands (and that `failed`/
`approvals_total` never leak in).

## Bounds

- `src/http/metrics.ts` — one aggregation block + one family block; header doc line.
- `deploy/grafana/support-agent-dashboard.json` — new row + two panels; approvals row `gridPos.y`
  renumbered (+9) to make room.
- Tests + docs as above. Nothing else.
