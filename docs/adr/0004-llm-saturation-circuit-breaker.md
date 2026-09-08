# ADR-0004: Saturation circuit breaker on the LLM client

**Status:** Accepted (2026-09-08)

## Context

The LLM client's retry ladder (2 retries, 500ms base, 8s cap, ±25% jitter)
recovers blips and short capacity windows, but provider saturation outlasts
it: live verification showed inferX 429 "all replicas at capacity" surviving
the full ladder (~2.5s of wall clock). After that, every caller gives up —
and concurrent callers each burn the same futile ladder against a provider
with no capacity at all. The jitter fix stopped lockstep retries; it did not
stop the window from being paid in full by every request.

## Decision

A per-client **saturation circuit breaker** layers on the ladder
(`src/support-voice-agent/tools/llm.ts`), tripping on *saturated completions*,
not attempts:

- A completion counts only when **every** ladder attempt answered 429
  (surfaced as `rateLimited` on `LlmError`). Consecutive saturated
  completions (default 3) open the circuit; a single overloaded request
  still just retries — the pinned single-request behavior is untouched.
- **Open:** `complete()` fails fast with `LlmError('circuit_open')` without
  touching the provider. The `llm_call` audit event records
  `errorCode: 'circuit_open'`, `attempts: 0`, and the remaining cooldown ms —
  saturation windows are visible in the event spine, not just console noise.
- **Cooldown is adaptive:** 10s, doubling per re-trip, capped at 2min. After
  it elapses, exactly **one half-open probe** decides reset vs re-open;
  concurrent callers during the probe keep failing fast. Any success resets
  the breaker entirely.
- **Scope:** 5xx/network never open it (they are not capacity signals).
  `breakerThreshold: 0` disables it. Breaker timing uses an injectable
  `now`, per the codebase clock convention.

## Alternatives considered

- **Longer fixed ladder** — trades the caller's latency budget for a bigger
  window; still futile against minute-scale saturation, and every caller
  pays it.
- **Retry-after header parsing** — the right signal when a provider sends
  it, but many OpenAI-compatible gateways do not; the breaker works without
  cooperation. (A compatible header could later refine the cooldown.)
- **Distributed breaker (shared store)** — one instance per process is the
  deployment reality today (bootstrap constructs a single client); a shared
  registry is the follow-up if callers ever fan out across clients.
- **Queue-and-wait instead of fail-fast** — converts saturation into latency
  spikes and holds request-scoped state; honest degradation (the deterministic
  floor, the honest fallback) is already the codebase's answer to "LLM
  unavailable".

## Consequences

- Sustained saturation degrades cheaply: at most one provider request per
  cooldown window instead of a full ladder per caller.
- `circuit_open` is a new `LlmError` code. Existing call sites only branch on
  `'unwired'` (verified across the codebase), so nothing new treats it as a
  validation failure — honest-degradation paths keep working during windows.
- The breaker is per-client-instance; multi-client fan-out against one
  provider would need a shared registry (noted as future work, not built).
