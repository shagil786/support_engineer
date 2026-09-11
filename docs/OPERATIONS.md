# Operations guide — deploying the support agent anywhere

The agent is deployment config, not code. The same binary joins any org:
point it at a data directory, hand it a runbook catalog and a context corpus,
wire whatever integrations the org has (each one degrades honestly when
absent), and expose the meeting surface you want.

The architectural decisions behind these behaviors are recorded in
[docs/adr/](../docs/adr/) — KB-first answering, hybrid retrieval, catalog
ingest-on-boot, the LLM saturation breaker, and server-side signer-role
resolution each have a page.

## Runtime data — `DATA_DIR`

All runtime state lives under one root (default `var/` in the repo, fine for
dev; production should point at a mounted volume):

| Path | Contents |
|---|---|
| `<DATA_DIR>/events/` | The append-only audit spine (`llm_call`, `understanding`, `governance`, `tool_call`, `agent_outcome` — whose `stats.reviewRetries` counts reviewer-repair re-dances —, …) |
| `<DATA_DIR>/outcomes/` | Per-request outcome records the learning loop extracts from |
| `<DATA_DIR>/memory/procedures.json` (+ `.meta.json`) | Durable learned procedures; the sidecar records the embedding identity |
| `<DATA_DIR>/knowledge/kb.json` | The knowledge base snapshot (chunks; vectors re-embed on boot) |
| `<DATA_DIR>/stats/procedure-stats.json` | Efficacy snapshot (procedures vs pipeline baseline) |

Honored by serve, the learning cron, knowledge-cli, and both evals.

## The agent's context — `RUNBOOKS_FILE` + knowledge ingestion

**Runbooks** are data, not code:

```json
[
  { "id": "clear-cache", "name": "clear-cache", "description": "clear the api cache tier", "destructive": false },
  { "id": "drain-pool",  "name": "drain-pool",  "description": "drain and restart the connection pool", "destructive": true }
]
```

`RUNBOOKS_FILE=/path/to/runbooks.json` — the file is validated loudly at boot
(a missing or malformed catalog is an error, never a silent empty registry).
`destructive: true` actions always stage a human approval before execution.

**Knowledge corpus** — ingest Markdown (runbooks, postmortems, FAQs, design
docs); the agent answers questions from it with citations:

```bash
npx tsx scripts/knowledge-cli.ts ingest /path/to/runbook.md runbooks
npx tsx scripts/knowledge-cli.ts search "how do I rotate the TLS cert"
```

**Runbook actions are knowledge too** — every action in `RUNBOOKS_FILE` is
auto-ingested into the KB at boot as a `runbook:<id>` doc (`source: runbooks`,
plus `runbookId`/`destructive` metadata), so `/ask` and KB-first answers cite
the executable catalog with zero manual ingest. The KB re-syncs to the catalog
on every boot: changed actions replace atomically, and actions removed from
the catalog have their docs evicted. Fuzzy resolution runs on the same KB's
hybrid scorer with fail-safe bands — a destructive candidate below the
strong-match floor always stages for approval instead of executing, and
every resolution records how it matched (`matchedBy: id/name/kb`) on the
spine. The bands and their rationale are specified in
[ADR-0006](../docs/adr/0006-runbook-resolution-fail-safe-bands.md). The same
sync runs on demand:

```bash
npx tsx scripts/knowledge-cli.ts runbooks /path/to/runbooks.json
```

Telemetry requests ("check the error logs", "any fresh errors?") always go to
live log data, never to the static KB — including without an LLM. Ticket-status
questions ("what's the status of SUPPORT-7?") go to the read-only
`jira_get_issue` tool when Jira is wired (policy treats it as read-only; the
lookup is audited on the event spine like every governed action). The
KB-first-before-governance ordering and its gates are specified in
[ADR-0001](../docs/adr/0001-kb-first-before-governance.md); the retrieval
stack in [ADR-0002](../docs/adr/0002-hybrid-retrieval.md); the catalog sync
semantics in [ADR-0003](../docs/adr/0003-runbook-catalog-ingest-on-boot.md).

**First-run seed** — `KNOWLEDGE_SEED_DIR=/path/to/markdown/` ingests every
`*.md` file into the KB during ready() (ids are filename stems, ingested docs
mirror the directory: remove a file and its doc is evicted on the next boot).
A fresh deployment with no corpus and no seed answers everything with an
honest refusal — that is correct behavior, but nobody wants it on day one;
the container image presets the seed to the shipped `examples/` corpus
(see `examples/README.md`).

The KB re-embeds on boot under the configured embedding backend, so changing
`EMBEDDINGS_*` only requires a restart (and, if the model identity changed, a
`npx tsx scripts/learning-cron.ts --reindex` for the durable procedure store).

## Identities — `SPEAKER`, `APPROVERS`, `APPROVAL_CHANNEL`

- `SPEAKER` — the console operator's id; always admin in the serve process.
- `APPROVERS` — comma-separated additional admin ids (Slack user ids work:
  `APPROVERS=U0123,U0456`). Admins stage approvals; everyone else is a guest
  whose destructive requests the SafetyNet vetoes outright.
- `APPROVAL_CHANNEL` — Slack channel for staged approvals (default
  `#support-agent-approvals`). With `SLACK_BOT_TOKEN` wired, sign-off happens
  by emoji reaction on the posted approval message.

## Surfaces

- **Console** (serve's stdin): utterances, `:learning tick`, `:quit`.
- **Web console**: `GET /console` — a single static page (no external assets,
  served without a token since it embeds no data). Paste a bearer token and a
  speaker id (RBAC is keyed on the speaker id, so use the id your role
  resolver maps to admin/engineer), then chat with the pipeline: answers show
  their provenance (knowledge-base citation, Jira lookup, live logs), staged
  approvals appear in the queue panel, and two admin signatures enable
  Execute. The queue lists pending AND granted-but-unexecuted approvals, so a
  granted action is never stranded. The panel updates in real time via a
  server-sent-events stream (`GET /approvals/events`, same bearer auth) that
  pushes the full listing after every approval mutation — no polling.
- **HTTP** (starts only when a token exists): `HTTP_TOKENS=tok1,tok2`
  `HTTP_PORT` (default 8787) `HTTP_HOST` (default 127.0.0.1),
  `RATE_LIMIT_PER_MINUTE` (default 120/credential), idempotency keys honored.
  Routes: `POST /utterance` `{ text, speakerId }`, `POST /ask`
  `{ question }`, `POST /envelope` (structured webhook deliveries),
  `GET /approvals` (the queue listing; entries carry `status` of
  `pending` or `granted` plus the `correlationId` execute needs),
  `GET /approvals/events` (the same listing as an SSE stream, pushed on
  connect and after every mutation, with keep-alive pings), approval
  sign/execute endpoints. Signing is `POST /approvals/:id/sign
  {"signerId": …}` — the server resolves the signer's role through the
  same speaker registry the SafetyNet uses and answers 403 when the
  identity is not an approver; client-asserted roles are not accepted
  (ADR-0005). Grants are attributed: `approval_granted` events record the
  resolved `signerIds`. `GET /metrics` (same bearer auth) exposes the
  Prometheus text format: LLM calls/tokens/latency, tool calls/latency,
  governed-run outcomes, policy decisions, SafetyNet vetoes, review-retry
  recovery counts (`retried`/`recovered`/`failed`), and approval lifecycle
  counts (`requested`/`granted`/`denied`/`timed_out`/`executed`) —
  aggregated live from the event log.

- **Monitoring**: scrape `GET /metrics` with Prometheus (bearer token in the
  scrape config), then import `deploy/grafana/support-agent-dashboard.json`
  (uid `support-agent-ops`) — LLM error rate, latency percentiles, token
  burn, per-tool latency, policy decisions, vetoes, review-recovery rate,
  and the approval queue out of the box. A contract test keeps the dashboard and the metric set
  from drifting apart. Add
  `deploy/prometheus/support-agent-alerts.yml` to your `rule_files` for
  provider-saturation (early warning + open breaker), approval-queue
  backlog, review-recovery sag (the reviewer's re-dance stops rescuing
  runs), and SafetyNet veto-spike alerting — also contract-pinned.
  Pending approvals are in-memory, but boot-time reconciliation sweeps
  requests orphaned by a dead process (a terminal `approval_timeout` event
  per swept id, reported as `approvalsSwept` by `/readyz`-backed readiness
  when nonzero), so an orphaned queue self-heals on restart instead of
  wedging the backlog alert.
- **Slack**: `SLACK_SIGNING_SECRET` enables events; `SLACK_BOT_TOKEN` upgrades
  approvals to the reaction UX.

## Integrations (each optional; absent = honest degradation)

- `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` — any OpenAI-compatible
  endpoint. Unwired LLM = the deterministic floor everywhere (classifier,
  agents, answers) — the platform still runs.
- `EMBEDDINGS_PROVIDER=local|remote` + `EMBEDDINGS_MODEL`/`EMBEDDINGS_DIM` —
  local MiniLM needs no key; remote uses an OpenAI-compatible `/embeddings`.
- `JIRA_*` — ticket integration. `SPLUNK_URL`/`SPLUNK_TOKEN` — log provider
  for `query_logs`. Absent = the dance reports `unwired` honestly.

## Learning loop — `LEARNING_ENABLED`, `LEARNING_INTERVAL_MS`

Run the cron next to serve (separate process, separate schedule):

```bash
LEARNING_ENABLED=true npx tsx scripts/learning-cron.ts   # or: npm run learn
```

Outcomes flow from serve; the cron extracts procedures, refreshes the library
serve short-circuits with, and writes the efficacy snapshot. Ticks report via
`[learning] tick …` log lines.

The efficacy snapshot's pipeline bucket carries the review-retry evidence
alongside the aggregates: `retried` (requests that spent reviewer-retry
budget), `recovered` (of those, the ones whose final outcome was ok),
`recoveryRate`, and `avgReviewRetries`. The SuggestionQueue reads the same
signal and **withholds destructive-approval relaxation** (`approver_count`
lowering) while at least half of the approval outcomes in its window needed
review retries — a review that passes only after a re-dance is evidence the
pre-grant bar is doing real work, not ceremony.

## Supervisor caps — `SUPERVISOR_*`

`SUPERVISOR_MAX_WALLCLOCK_MS` (default 60s), `SUPERVISOR_MAX_HOPS` (10),
`SUPERVISOR_MAX_TOKENS` (50k), `SUPERVISOR_MAX_IDENTICAL_TOOL_CALLS` (3),
`SUPERVISOR_MAX_REVIEW_RETRIES` (1).
Raise the wall clock for slow LLM providers; each var is optional and
independently floor-checked.

When the pre-execution review returns a correctable `fail`, the supervisor
re-runs the investigation dance (triage → investigate → review) so the
planners can act on the reviewer's feedback — up to
`SUPERVISOR_MAX_REVIEW_RETRIES` times. A `reask` verdict (needs a human)
never retries or executes. Retries consume the shared hop/token caps — the
retry budget widens fidelity, never the caps — and the count lands on the
`agent_outcome` event (`stats.reviewRetries`) so degraded-but-recovered
requests are visible on the spine.

## LLM transient failures — retry ladder + saturation breaker

The LLM client retries transient failures (429 / 5xx / network) with jittered
exponential backoff (2 retries, 500ms base, 8s cap per attempt). When
consecutive completions end fully rate-limited — every attempt answered 429
(default 3 in a row) — the saturation circuit breaker opens: further calls
fail fast with a `circuit_open` error instead of hammering a provider that is
out of capacity. After a cooldown (10s, doubling per re-trip, capped at 2min)
a single half-open probe decides reset vs re-open; any success resets the
breaker entirely. 5xx/network failures retry as before but never open it, and
a single overloaded request still just retries — the breaker counts
completions, not attempts. The `llm_call` audit event records
`errorCode: circuit_open` plus the remaining cooldown ms (`breakerState`).
The tripping rule (completions, not attempts), the adaptive cooldown, and
the half-open probe are specified in
[ADR-0004](../docs/adr/0004-llm-saturation-circuit-breaker.md).

**What saturation costs the product: classification fidelity, not
availability.** When a call does fail at the LLM (ladder exhausted on 429s,
breaker open, network down), the intent classifier degrades to the
deterministic classifier floor instead of failing the utterance: utterances
keep working, with reduced classification fidelity, and the emitted
`understanding` event records the real reason (`contextBundleRef: via:<code>`
— `http_error`, `circuit_open`, `network`) joined to the request's
correlation id, so degraded periods are visible on the spine rather than
silent. Two caveats: the floor claims action requests only for a family of common
operational verbs (restart/reboot/clear/rerun/deploy/rollback/redeploy, plus
fail over/promote/drain/rotate/flush/scale) — a request built from unusual
phrasing (or naming a runbook id directly) needs the LLM, so during
saturation it routes as a question rather than staging an approval — and
`support_agent_llm_calls_total{ok="false"}` counts these events. `/ask`
(KB-direct) is unaffected either way. The same ladder covers the execution
layer: the supervisor's LLM agents (triage/investigator/executor/reviewer)
fell back deterministically on provider failure (`degradedReason` on the
result, visible in the agent_outcome summary), so a saturated provider
degraded a governed run's plan quality without failing it.

## Approval timing — `APPROVAL_TIMEOUT_MS`

How long a staged approval stays pending (default 5 minutes; >= 1000).

## Running in a container

```bash
docker build -t support-agent .
docker run --rm -p 8787:8787 --env-file .env -v agent-data:/data support-agent
```

The image (node:22-slim, non-root) carries sources, `policies/`, the example
corpus (`examples/`, preset as the first-run knowledge seed and runbook
catalog), and the probed native `better-sqlite3` binary; a prebuild/ABI
failure fails the *build*, not a runtime request — the same contract CI
enforces on the runner. All state lives under the `/data` volume (`DATA_DIR`);
HTTP binds `0.0.0.0:8787`; the container runs with `SERVE_KEEP_ALIVE=1`
because a detached container has no stdin (without it the console loop would
exit and take the server down). `npm run smoke:container` builds, boots, and
probes health/readiness/fail-closed auth/cited answering from the seeded
corpus; it skips cleanly when no Docker daemon is present.

## Go-live checklist

Run each step against the real deployment (not a fake) before routing humans
to the agent. Every step below maps to a probe the suite exercises against
fakes — this is the pass that proves the real surfaces agree.

1. **Knowledge answers.** `GET /readyz` shows `kb.docs` > 0. `POST /ask` with
   a corpus question returns a cited answer; a nonsense question returns
   `refused: true` — the refusal is the product, verify it on purpose.
2. **Runbook catalog.** With `RUNBOOKS_FILE` set, asking "how do I restart X?"
   cites the catalog (auto-ingested), and `/readyz` procedures reflect it.
3. **Governance dry run.** From a non-admin identity, request a destructive
   action → expect a SafetyNet veto. From an admin → expect a staged approval,
   a Slack card in `APPROVAL_CHANNEL`, and execution only after the human
   grant (emoji sign-off or card button). Check the audit trail on the event
   spine for every step.
4. **Real Slack card click-through.** The card flow is contract-tested against
   a local fake; do one pass against a real workspace: wire `SLACK_BOT_TOKEN`
   + `SLACK_SIGNING_SECRET`, stage a destructive action, click Approve in the
   real client, and confirm the in-place status update and thread reply.
5. **Live LLM smoke.** The retry ladder and saturation breaker are pinned by
   unit tests, not by live providers. Before real traffic: wire
   `LLM_BASE_URL/KEY/MODEL`, ask a live-data question through `/utterance`,
   confirm `llm_call` events appear and `/metrics` reports calls and latency,
   and confirm a nonsense question refuses instead of hallucinating. Then run
   the scheduled chaos probe against the real endpoint:
   `npm run probe:llm-chaos -- --quick` boots the platform against a local
   broken provider and checks the full degradation ladder end to end —
   429 saturation (`via:http_error`), breaker trip (`via:circuit_open`),
   recovery (`via:llm`), and connection drops (`via:network`) — with every
   utterance still completing through the deterministic floor. It exits
   non-zero on any failed check, so it works as a cron/CI gate; it runs in
   `--quick` mode on every push and the full production-shaped ladder hourly
   (`.github/workflows/ci.yml`, `.github/workflows/chaos.yml`), so ladder
   regressions surface as a failed run, not as a saturated incident.
6. **Observability live.** Point Prometheus at `/metrics` (same bearer auth),
   import the dashboard, load the alert rules, and trigger one approval so the
   approval metrics visibly move.
7. **Auth posture.** No token → 401 everywhere; wrong token → 401; hammering
   a route → 429 with `Retry-After`. Rotate `HTTP_TOKENS` once before go-live
   so the launch tokens were never in a chat message.

## Minimal production example

```bash
DATA_DIR=/srv/agent \
  RUNBOOKS_FILE=/srv/agent-config/runbooks.json \
  APPROVERS=U0123,U0456 \
  APPROVAL_CHANNEL=#oncall-approvals \
  LLM_BASE_URL=… LLM_API_KEY=… LLM_MODEL=… \
  EMBEDDINGS_PROVIDER=local \
  HTTP_TOKENS=$(cat /etc/agent/http-token) HTTP_PORT=8080 \
  LEARNING_ENABLED=true \
  npx tsx scripts/serve.ts &
LEARNING_ENABLED=true LEARNING_INTERVAL_MS=900000 \
  npx tsx scripts/learning-cron.ts &
```

Zero code changes — the org's identity, actions, and knowledge are all data.
