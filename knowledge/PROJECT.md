# PROJECT.md — Freebuff Desktop / Support Voice Agent

Updated: 2026-09-14

## Purpose

A meeting-etiquette voice agent for standups, war rooms, and client calls.
Three modes (Silent / Response / Interrupt), wired to Jira, Splunk/CloudWatch,
runbooks, and Slack. The deterministic etiquette brain (`SupportVoiceAgent`)
is framework-agnostic; a host supplies mic/STT/TTS.

## Stack

- TypeScript strict ESM (`noUncheckedIndexedAccess`, `isolatedModules`), Node ≥ 22.12 with engine-strict (`.nvmrc` is the production floor).
- Runtime deps kept minimal: `better-sqlite3`, `zod`, `yaml`, `@huggingface/transformers`. All integrations are injected ports — no SDK clients in `src/`, no hardcoded hosts/tokens.
- Vitest 5, tsx, gitleaks; pre-push hook in `.githooks/`; CI in `.github/workflows/` (ci.yml, security.yml, hourly chaos.yml).

## Architecture (src/)

- `support-voice-agent/` — deterministic etiquette brain, heuristics, guardrails (RBAC, prompt-injection), bridge ports, memory ports.
- `governance/` — policy engine + approvals + safety net. **Policy = data** in `policies/default.yaml`: first matching rule wins, default-deny; `never_emit_credit_card` is deliberately the FIRST rule (any tool args containing a card-shaped token → deny).
- `event-log/` — JSONL event spine (`<DATA_DIR>/events/YYYY-MM-DD.jsonl`); governance decisions are recorded here and replayed later.
- `understanding/` — KB-first answering (ADR-0001), hybrid BM25+vector retrieval with RRF (ADR-0002).
- `evidence/`, `incident/`, `remediation/`, `change/`, `signals/`, `topology/` — investigation layers (evidence graph, durable incidents, verified remediation).
- `learning/` — shadow replay (ADR-0010: replay spine through candidate policy bundle, divergence = exit 1) and scenario synthesis (ADR-0011: divergences → PII-redacted eval pins; `expect` is always the RECORDED effect).
- `http/` — fail-closed HTTP surface (`HTTP_TOKEN` required, no token = no server) + web console at `/console`.

## Conventions / invariants

- Fail-closed everywhere: unknown tool → deny, no token → no server, ungrounded KB question → refuse (never guess).
- Integrations are env-driven and optional; missing config degrades honestly, never invents a server. `requireJira()` is the only throwing variant.
- ADRs in `docs/adr/` (11 as of 2026-09-14) are the design-decision record; ops runbook in `docs/OPERATIONS.md`.

## Verification commands

- `npm run typecheck` · `npm test` (99 files / 810 tests, ~3 s)
- `npm run check:boot` — five-minute boot tour (auth, cited /ask, RBAC veto, approval staging, metrics)
- `npm run replay` — shadow-replay drift check; `npm run learn:once` — learning cron
- `npm run eval` / `eval:retrieval` / `eval:faithfulness` — eval suites

## Status 2026-09-14

- Latest commit `c218e14` (scenario synthesis); replay-CLI integration test committed as `267017b`, pushed and open as PR #4 (`test/replay-cli-integration`).
- That test file had been broken mid-write (afterEach never closed → describes nested inside it → "No test suite found"; plus a wrong test premise: it seeded a card-bearing event as recorded `deny`, which the live bundle also denies, so no divergence — fixed to recorded `allow`, the pre-PII-guard drift case). Header-promised `--bundle` candidate-preview and usage/IO-error (exit 2) cases are now written too; a missing events dir is documented as the empty-spine steady state (exit 0, by design in JsonlFileEventLog.query).
- Suite totals: 99 files / 817 tests, all green; typecheck clean.
