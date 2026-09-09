# Desktop — Support Voice Agent

A meeting-etiquette voice agent for standups, war rooms, and client calls.

The agent joins meetings via audio and operates in three modes, wired to:

- Jira (create issues, transitions, comments; formatted output on every update)
- Splunk and CloudWatch Logs (pull logs in the background when asked)
- Runbooks (offer + confirm + run actions like restarting a pod)
- Slack (post end-of-meeting summaries)

## Three operational modes

| Mode | When it speaks |
|------|---------------|
| **Silent** (default) | Only listens and takes background notes: updates Jira statuses, notes vague technical complaints and vocal feedback. Does not speak. |
| **Response** | Speaks politely when: the wake word ("hey agent") is used; a human asks the group a direct status/data/help question; or a vague technical complaint comes up and a clarifying question is needed. Waits for a ~1.5 s pause before speaking; keeps responses short (20-word cap unless reporting logs or critical data). |
| **Interrupt** | Barges in immediately on P0/P1 alerts, when a server/API goes down (detected via the log watchers), or when a human says "This is a P1" / "Critical incident". Uses a firm, urgent tone. |

## Behavior highlights

- **"Agent, shut up" / "Stop talking"** → immediately mutes for 5 minutes, responds only to the wake word after that.
- **Verbal feedback** (e.g. "Users hate the new UI") → paraphrased and the agent asks "Should I create a Jira bug for this? What priority?"
- **Vague technical complaints** ("it's down", "something's broken") → either a clarifying question (response mode) or a background note (silent mode).
- **Architecture deep-dives** with 2+ speakers → the agent stays silent.
- **End of meeting** → a summary of all vocal feedback, Jira changes, and alerts is posted to Slack or Jira but never read aloud.

## Architecture

The brain is `SupportVoiceAgent`. It is intentionally framework-agnostic: it exposes `processUtterance(...)`, `ingestAlert(...)`, `onPause(...)`, and a typed event bus for `speech`, `jira`, `alert`, `muted`, and `summary`. The host (Freebuff Desktop) owns the microphone, wake-word detection, STT, and TTS/audio playback.

Integrations are dependency-free ports you wire in:

- `JiraClient` — Jira Cloud REST (create issue, transitions, comments, status).
- `SplunkProvider` — Splunk REST oneshot export.
- `CloudWatchProvider` — CloudWatch Logs Insights (StartQuery / GetQueryResults) with a host-provided SigV4 signer.
- `InMemoryRunbookProvider` — in-memory runbook registry + executor (default for local dev and tests).
- `SlackWebhookNotifier` — incoming-webhook summaries.

**Layer 3 — Voice bridge ports** (`src/support-voice-agent/bridge/`):
- `MeetingBridge` / `SpeechToText` / `TextToSpeech` / `MeetingTarget` vendor-neutral ports.
- `createVoiceSession(bridge, agent)` — the exact glue a host performs: transcript→agent, speech→TTS, pause events both ways, echo suppression (agent never transcribes its own voice).
- `ScriptedBridge` — deterministic in-process fake; real Meet/Teams/Zoom/Slack-huddle adapters implement the same port.
- Offline demo: `npm run demo` (interactive) / `npm run demo -- --script` (scripted war-room scene over fake Jira/Slack — zero network, zero credentials).

**Layer 1 — Memory** (`src/support-voice-agent/memory/`):
- `KeyValueStore` port (+ in-memory impl with TTL) — meeting summaries persist across sessions; swap in Redis by satisfying the same port.
- `VectorMemory` port (+ in-memory impl) — RAG over feedback, alerts, and runbook runs using a deterministic keyless embedder (hashed words + char trigrams). Relevant notes answer questions as "From my notes: …"; swap in a real embedding API or Pinecone behind the same `Embedder`/`VectorMemory` types later.
- Config: `memory: { kv, vectors }` on `SupportVoiceAgent`; both optional, agent degrades to no-memory behavior when absent.

**Layer 4 — Guardrails** (`src/support-voice-agent/guardrails.ts`):
- RBAC speaker registry (`admin`/`engineer`/`viewer`/`guest`; unknown speakers default to `guest`).
- Destructive runbook actions hard-gated to approver roles — enforced in BOTH the deterministic
  confirm path and the LLM tool handler, so the model cannot talk its way past it; refusals page
  `#security` (configurable) via Slack.
- Prompt-injection detection (`isPromptInjection`) refuses and pages security.

**Layer 2 — Tool Registry & LLM**:
- `OpenAiCompatibleClient` — real HTTP client for any OpenAI-compatible endpoint (OpenAI, OpenRouter, Ollama, vLLM, Azure gateways). No hardcoded keys/hosts.
- `LlmOrchestrator` — LLM + tools loop that coexists with the deterministic etiquette brain. When LLM is unwired, falls back to the deterministic agent byte-for-byte.
- Tools: `jira_create_issue`, `query_logs`, `execute_runbook_script`, `invoke_human_on_slack`, `meeting_interrupt`.

**Design decisions** — the reasoning behind the core architecture lives in [docs/adr/](docs/adr/):
- [ADR-0001](docs/adr/0001-kb-first-before-governance.md) — KB-first answering before governance (live-data gate, refusal floor, explicit provenance).
- [ADR-0002](docs/adr/0002-hybrid-retrieval.md) — Hybrid BM25 + vector retrieval with RRF fusion and a deterministic re-rank.
- [ADR-0003](docs/adr/0003-runbook-catalog-ingest-on-boot.md) — The runbook catalog is the source of truth; the KB mirrors it on every boot.
- [ADR-0004](docs/adr/0004-llm-saturation-circuit-breaker.md) — Saturation circuit breaker on the LLM client: sustained 429 windows fail fast instead of hammering.
- [ADR-0005](docs/adr/0005-server-side-signer-role-resolution.md) — Approval signatures resolve the signer's role server-side; a bearer token authenticates the channel, the speaker registry authorizes the actor.
- [ADR-0006](docs/adr/0006-runbook-resolution-fail-safe-bands.md) — Fuzzy runbook resolution shares the citation engine's scorer, with fail-safe bands: ambiguous destructive candidates always stage for approval, never auto-execute.

## Getting started

```bash
npm install
npm run typecheck
npm test
npm run check:boot
```

`check:boot` is the five-minute tour as a script: it boots the real server on
a temp data dir and verifies fail-closed auth, a cited `/ask` answer, RBAC
vetoes on a guest's destructive request, approval staging, and metrics. To
drive the same things by hand — including the full approval click-through in
the web console — read on.

### 1. Boot with the example corpus (no API keys needed)

```bash
HTTP_TOKEN=dev-token \
RUNBOOKS_FILE=examples/runbooks.json \
KNOWLEDGE_SEED_DIR=examples/knowledge \
APPROVERS=alice,bob \
SERVE_KEEP_ALIVE=1 \
npx tsx scripts/serve.ts
```

- `HTTP_TOKEN` turns the HTTP surface on. Fail-closed: no token, no server.
- `RUNBOOKS_FILE` is the action catalog. Every action is ingested into the
  knowledge base at boot, so `/ask` can cite the executable surface.
- `KNOWLEDGE_SEED_DIR` ingests every `.md` file as a KB document (four ship
  in `examples/knowledge`: two runbooks, a postmortem note, an on-call
  handbook).
- `APPROVERS` names the admin identities. Everyone else is a guest.
- `SERVE_KEEP_ALIVE=1` keeps the server alive when started from a script;
  in an interactive terminal Ctrl-C stops it either way.

The web console is at **http://127.0.0.1:8787/console**. Paste `dev-token`
as the token and set the speaker field — start with `guest`.

### 2. Ask something (KB-first, cited)

In the console, ask: **how do I fail the database over?** Or via curl:

```bash
curl -s -X POST -H "Authorization: Bearer dev-token" -H 'content-type: application/json' \
  -d '{"question":"how do I fail the database over?"}' \
  http://127.0.0.1:8787/ask
```

The answer is extracted from the knowledge base with a citation to
`runbook:db-failover`. No LLM is configured, so this is the deterministic
extractive path. A question the corpus cannot ground refuses instead of
guessing.

### 3. Drive one governed destructive action, end to end

`db-failover` is destructive: policy requires two admin signatures before it
runs. One utterance exercises the whole chain:

1. **As `guest`**, send: *please restart the primary database now.* The
   SafetyNet vetoes it — a guest cannot approve a destructive action.
2. **As `alice`** (an `APPROVERS` id), send it again. It stages:
   `{"routed":"pipeline","approvalId":"…","approvalStatus":"pending"}`.
   Note what happened: the catalog has no database-restart action, and the
   KB resolver still matched the utterance to `db-failover` through the
   hybrid scorer — destructive, so it goes to humans either way, and
   resolution provenance lands on the audit spine.
3. **Grant.** The approval card sits in the console's queue (with a Slack
   bot token wired it posts there instead; reactions and clicks work as
   signatures). Signatures dedupe by identity and two are required, so cast
   the second as `bob` — switch the speaker field, or use the REST API:

   ```bash
curl -s -X POST -H "Authorization: Bearer dev-token" -H 'content-type: application/json' \
  -d '{"signerId":"bob"}' \
  http://127.0.0.1:8787/approvals/$APPROVAL_ID/sign
   ```

4. **Execute** — the console's Execute button (live over SSE) or:

   ```bash
curl -s -X POST -H "Authorization: Bearer dev-token" -H 'content-type: application/json' \
  -d "{\"correlationId\":\"$CORRELATION_ID\"}" \
  http://127.0.0.1:8787/approvals/$APPROVAL_ID/execute
   ```

`{"routed":"pipeline","ok":true}` — the runbook ran only after the full
human chain, and staging, both signatures with signer ids, and execution are
all on the event spine. Sign out of band on a stale approval and execute
returns the replayed result instead of running it twice.

### 4. Where to go next

- Wire `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` for full natural
  language (*fail the database over to the standby*). Everything above works
  with zero keys: without an LLM the deterministic classifier claims only
  common action verbs (restart, deploy, clear, rollback, …), and provider
  saturation degrades to it rather than failing requests (ADR-0004).
- Replace `examples/` with your team's catalog and corpus — same binary,
  your operational knowledge (ADR-0003).
- Point Prometheus at `/metrics` and import the Grafana dashboard; load the
  alert rules. The go-live checklist in `docs/OPERATIONS.md` walks the rest,
  including the scheduled chaos probe.

## Environment variables

All production wiring is env-driven via `configFromEnv()` / `createAgent()` / `createLlmClient()` in `src/config.ts`
(see `.env.example` for a placeholder template; `.env` is git-ignored). No host, token, or
project key is ever hardcoded in `src/`. Every integration is optional: if a group's required
variables are missing the integration stays **unwired** and the agent degrades honestly
("I don't have that data in my current context, but I can pull it from Jira now.") instead of
contacting an invented server. `requireJira()` is the only variant that throws.

| Variable | Purpose |
|----------|---------|
| `JIRA_BASE_URL` | Jira REST base URL. Required for any Jira wiring. |
| `JIRA_AUTH_TYPE` | `bearer` (default) or `basic`. |
| `JIRA_BEARER_TOKEN` | Token when `JIRA_AUTH_TYPE=bearer`. |
| `JIRA_EMAIL` + `JIRA_API_TOKEN` | Credentials when `JIRA_AUTH_TYPE=basic`. |
| `JIRA_PROJECT_KEY` | Optional default project key for `createIssue`. |
| `SLACK_WEBHOOK_URL` | Incoming webhook used to post meeting summaries to Slack. |
| `SPLUNK_URL` + `SPLUNK_TOKEN` | Both required to wire the Splunk log provider. |
| `AWS_REGION` (+ `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) | Read by the host's AWS SDK setup; CloudWatch needs a host-provided SigV4 `signer` (see `CloudWatchConfig`), so it is not wired by `configFromEnv()`. |
| `LLM_BASE_URL` | OpenAI-compatible endpoint (e.g., `https://api.openai.com/v1`, `http://localhost:11434/v1`, `https://openrouter.ai/api/v1`). |
| `LLM_API_KEY` | **Add later** — the API key for your cloud-hosted model. Empty = LLM unwired. |
| `LLM_MODEL` | Model name (e.g., `gpt-4o`, `llama3`, `mistral`). |

Behavioral defaults (wake word, 1.5 s pause, 5 min mute, 20-word cap, 60 s runbook
confirm window) live only as exported constants in `src/support-voice-agent/heuristics.ts`
(`DEFAULT_WAKE_WORD`, `DEFAULT_MIN_PAUSE_MS`, `DEFAULT_MUTE_DURATION_MS`,
`DEFAULT_MAX_RESPONSE_WORDS`, `DEFAULT_RUNBOOK_CONFIRM_WINDOW_MS`). Sample runbook actions
are demo fixtures in `src/fixtures/sample-runbooks.ts`; production `createAgent()` starts with
an empty runbook registry and expects the host to pass its real registry via config.

## Type-safety

The project uses strict TypeScript (`noUncheckedIndexedAccess`, `noImplicitOverride`, `isolatedModules`). Integration adapters are injected, never instantiated internally, so they are trivial to mock in tests.

## Notes

- Utterance classification uses simple regex heuristics in `src/support-voice-agent/heuristics.ts`. They are deliberately swappable — the agent only depends on their boolean/triage results, not their internals.
- Jira updates always follow the output rule: `"I have updated TICKET-123 to status 'In Progress' and added the comment: '...'."`
