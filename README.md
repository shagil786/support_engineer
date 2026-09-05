# Freebuff Desktop — Support Voice Agent

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

**Layer 2 — Tool Registry & LLM** (new):
- `OpenAiCompatibleClient` — real HTTP client for any OpenAI-compatible endpoint (OpenAI, OpenRouter, Ollama, vLLM, Azure gateways). No hardcoded keys/hosts.
- `LlmOrchestrator` — LLM + tools loop that coexists with the deterministic etiquette brain. When LLM is unwired, falls back to the deterministic agent byte-for-byte.
- Tools: `jira_create_issue`, `query_logs`, `execute_runbook_script`, `invoke_human_on_slack`, `meeting_interrupt`.

## Getting started

```bash
npm install
npm run typecheck
npm test
```

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
