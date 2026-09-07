# Plan: LLM token accounting + observability (2026-09-07)

## Context

The live learning-loop verification (2026-09-07) exposed two structural gaps
against the agentic-ai skill's checklist:

1. **Token cap is dead code.** `LlmChatResponse.usage` is typed and parsed,
   but no caller consumes it: `AgentRunInput`/`AgentRunOutput` never carry
   usage, and the pipeline initializes `context.tokens = {0,0}` and nothing
   ever increments it. The supervisor's `maxTokens` cap therefore can never
   trip — the "prevent runaway costs" control is structural only.
2. **No LLM call observability.** The agentic-ai skill requires logging every
   LLM call (model, latency, tokens, retries). Today an LLM call leaves no
   trace except its final result; retries are invisible until they exhaust.
   The event log has no `llm_call`-shaped event.

Also evidenced live: inferX 429 saturation outlasted the retry ladder. The
ladder (default 2 retries, 500ms base, 8s cap) has no jitter; synchronized
retries hammer a saturated provider.

## Spec

The spec (docs/superpowers/specs/2026-09-06-support-engineer-agentic-design.md)
describes the Supervisor caps as live controls; this plan makes the token cap
real and adds the observability surface the spec's event-spine promises.

## Global Constraints

- Full suite stays green (`npm test`, `npm run typecheck`).
- Honest degradation is preserved: usage accounting must never change
  fallback/legacy behavior; missing usage (older providers) degrades to
  "no data", never to a failure.
- No changes to the byte-compat legacy fallback path.
- Events must fit the existing DecisionEvent envelope (no schema migration).

## Task 1: Thread LLM usage into the supervisor's token cap (TDD)

- `LlmAgent.callLlm` (src/execution/agents/base.ts) discards everything but
  `choices[0].message.content`. Return `usage` on `AgentRunOutput`:
  `usage?: { prompt: number; completion: number }` (absent when the provider
  omits it).
- `SupervisorAgent` accumulates into `context.tokens` after every agent run
  (triage, investigator, reviewer ×2, executor) and after every LLM-driven
  step it executes. The existing `overTokens()` check then becomes live.
- Tests (tests/execution/supervisor.test.ts):
  - a spy LLM reporting usage pushes `context.tokens` up and a small
    `maxTokens` fails the run with "token cap exceeded";
  - usage absent → tokens stay put, run succeeds (degradation).
- The pipeline creates the context objects; nothing to change there — tokens
  are mutated in place by the supervisor.

## Task 2: LLM call events + retry jitter (TDD)

- `OpenAiCompatibleClient` gains an optional `onCall` hook (constructor
  option): after every `complete()` (ok or failed), report
  `{ model, latencyMs, promptTokens?, completionTokens?, attempts, ok, errorCode? }`.
- Bootstrap wires the hook to the event log as a DecisionEvent
  (kind `llm_call`, source `internal`, layer per existing envelope rules —
  no schema change). Where bootstrap constructs the client before the event
  log, reorder construction (log first) or wire the hook lazily.
- Retries: add ±25% jitter to the backoff delay and log one console line per
  retry (`[llm] retry N/M after Xms: <code>`) — visible in serve logs without
  spamming the event log.
- Tests (tests/llm.test.ts): hook fires once per complete with attempts and
  latency; failed calls carry the error code; jitter stays within bounds
  (mock the rng or assert the delay function range). Bootstrap test: an
  llm_call event lands in the event log for a request (spy LLM server not
  required — assert the hook wiring path with a fake fetch or unit-level hook
  injection).

## Out of scope

- LLM prompt/response content logging (PII risk; never log payloads).
- Multi-provider usage normalization.
- Fixing inferX saturation itself (ops concern).
