# PROJECT.md — Freebuff Desktop / Support Voice Agent

Updated: 2026-09-14

## Purpose

A meeting-etiquette voice agent for standups, war rooms, and client calls.
Three modes (Silent / Response / Interrupt), wired to Jira, Splunk/CloudWatch,
runbooks, and Slack. The deterministic etiquette brain (`SupportVoiceAgent`)
is framework-agnostic; a host supplies mic/STT/TTS.

## Stack

- TypeScript strict ESM (`noUncheckedIndexedAccess`, `isolatedModules`), Node ≥ 22.12 with engine-strict (`.nvmrc` is the production floor).
- Runtime deps kept minimal: `better-sqlite3`, `zod`, `yaml` (the `@huggingface/transformers` ONNX embedder was removed 2026-09-14 — `EMBEDDINGS_PROVIDER=local` is the built-in hash embedder; `npm audit` is clean). All integrations are injected ports — no SDK clients in `src/`, no hardcoded hosts/tokens.
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

## Status 2026-09-14 (end of session — PRs #4–#8 all merged to main)

- **Shipped:** repaired replay-CLI integration test (12 cases incl. `--bundle` + exit-2 coverage); direct unit pins for `meeting/notes`, `topology/blast`, `signals/types` (34 tests); coverage ratchet (85/75/85/88 enforced by CI's coverage run); lockfile bumps (zod 4.6.5, yaml 2.9.1); **embeddings exposure closed** — `@huggingface/transformers` removed, `local` = built-in hash embedder, `npm audit` = 0 (was 4 high).
- **Suite:** 101 files / 843 tests green; retrieval eval hitRate 1.000; chaos probe 9/9; boot-check passes.
- **LLM live smoke (go-live item 5): PASSED on Groq (2026-09-14).** `LLM_BASE_URL=https://api.groq.com/openai/v1`, model `qwen/qwen3.8-27b` (the previous provider `model.inferx.net` was dropped — tenant quota exhausted and its model id `qwen38-flash-next` was never in the catalog). `.env` holds live Jira/Slack creds — smoke tests must filter to `LLM_*` only.
- **Whole-agent live test (2026-09-14): PASSED, with findings.** All static gates green (typecheck, 844 tests + ratchet, policy evals 27/27, retrieval hitRate 1.000, boot-check, chaos 9/9). Live drive with Groq wired: fail-closed 401, cited /ask, guest SafetyNet veto, 2-of-2 admin approval ceremony with signature dedupe + idempotent replay execution, feedback→Jira-offer, honest refusals — every step on the audit spine, `approvals_total` metrics moving. **Fixed live (PR #11):** the LLM-visible `query_evidence` schema lacked the `kinds` enum → the model invented `alert` → post-run verification of an APPROVED runbook failed `invalid args`; drift-guard test added. **Open finding — faithfulness eval flaps:** `npm run eval:faithfulness` loads `.env`, so /ask runs the LLM-verified path; f3's LLM answer scored 0.889 (vs 1.000 extractive) and Groq rate limits make the path nondeterministic. Gate not in CI. Investigate f3's LLM-verified answer; if CI gets the gate, run it LLM-free (extractive) or with a pinned judge.
- **Operator note:** if your persisted KB (`var/knowledge`) was written by MiniLM (384-dim), first boot after #8 fails loudly → `npx tsx scripts/knowledge-cli.ts reindex` once.
