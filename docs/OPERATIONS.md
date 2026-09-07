# Operations guide — deploying the support agent anywhere

The agent is deployment config, not code. The same binary joins any org:
point it at a data directory, hand it a runbook catalog and a context corpus,
wire whatever integrations the org has (each one degrades honestly when
absent), and expose the meeting surface you want.

## Runtime data — `DATA_DIR`

All runtime state lives under one root (default `var/` in the repo, fine for
dev; production should point at a mounted volume):

| Path | Contents |
|---|---|
| `<DATA_DIR>/events/` | The append-only audit spine (`llm_call`, `understanding`, `governance`, `tool_call`, `agent_outcome`, …) |
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
- **HTTP** (starts only when a token exists): `HTTP_TOKENS=tok1,tok2`
  `HTTP_PORT` (default 8787) `HTTP_HOST` (default 127.0.0.1),
  `RATE_LIMIT_PER_MINUTE` (default 120/credential), idempotency keys honored.
  Routes: `POST /utterance` `{ text, speakerId }`, `POST /ask`
  `{ question }`, `POST /envelope` (structured webhook deliveries), approval
  grant/deny/execute endpoints.
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

## Supervisor caps — `SUPERVISOR_*`

`SUPERVISOR_MAX_WALLCLOCK_MS` (default 60s), `SUPERVISOR_MAX_HOPS` (8),
`SUPERVISOR_MAX_TOKENS` (50k), `SUPERVISOR_MAX_IDENTICAL_TOOL_CALLS` (3).
Raise the wall clock for slow LLM providers; each var is optional and
independently floor-checked.

## Approval timing — `APPROVAL_TIMEOUT_MS`

How long a staged approval stays pending (default 5 minutes; >= 1000).

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
