# Plan: Grow the policy eval suite (spec §12 gate)

**Date:** 2026-09-10
**Follows:** spec §12 ("8 scenarios shipped, ~50 recommended before enabling
online promotion") and §0.3.

## Problem

The eval suite pins 8 scenarios against `policies/default.yaml`. It is the
stated precondition for enabling the learning loop's online promotion, and it
is the only behavioral regression net that runs against *bundles as data* —
so its holes are silent policy regressions.

## Ground truth the scenarios must encode

`PolicyEngine` semantics: first match wins; no match = deny. Predicate keys:
`intent_kind`, `intent_subKind` (requires kind), `tools_in`, `severity_in`,
`runbook_destructive` (envelope flag first, else prod/all marker regex on
ids), `output_matches_regex` (regex over JSON-serialized args). The default
bundle has 5 rules: PII card deny → destructive-runbook approval → read-only
allow → non-destructive allow → P0/P1 alert allow.

## Defect found in the shipped suite

`unknown_tool_default_denied` uses tool `query_logs` — a **valid, allowed**
tool — under an id claiming default-deny. The default-deny path is untested.
Fix: rename the scenario to what it tests (`pii_in_query_args_denied` — the
rule-order test the PII rule's comment promises) and add a real
default-deny scenario (tool outside every `tools_in`).

## Scenario matrix (16 new + 8 fixed/existing ≈ 24)

- Default-deny: unknown tool. (Discovered during the run: the bundle's
  non-destructive allow rule is deliberately intent-agnostic — mirrors
  `handlers.ts` — so the `human_action`-envelope scenario pins
  intent-agnosticism with a truthful name instead of an assumed deny.)
- PII rule order: card in query args; card in runbook script_name; SSN-like
  9-digit (no match — pattern is 13-19); card with separators.
- Destructive detection surface: `prod` marker id; `Production` casing;
  envelope flag `runbookDestructive: true` (provider-confirmed) and `false`
  overriding a prod-sounding id; non-runbook tool with prod id (no approval);
  marker inside a longer id.
- Cross-intent policy: `async_triage`/`incident` P1 files (severity rule);
  `async_triage` P4 question on read-only (rule order: read-only allow);
  `proactive_alert` P2 anomaly on `jira_create_issue` (falls to non-destructive
  allow — pins that the P0/P1 rule is severity-gated).
- Pin `complaint` subKind on `invoke_human_on_slack`; `meeting_interrupt` with
  a card number (PII beats the P0/P1 allow by rule order); approval-shape
  attributes via the destructive scenario family.

## Runner hardening (TDD first)

Duplicate scenario ids currently pass silently and make `passed/total`
reporting ambiguous (a PromotionGate reads that file — report integrity is
the contract). Test: two scenarios sharing an id → `runScenarios` throws.

## Non-goals

No PolicyEngine changes; no default.yaml changes; no scenario-schema change
beyond the duplicate-id guard. Scenario count lands ~24, not 50 — the
remaining distance is noted honestly in the spec (see below) rather than
padded with near-duplicates to hit a number.

## Bounds

`policies/eval/scenarios.yaml`, `scripts/eval.ts` untouched, one new test in
`tests/learning/eval-runner.test.ts`, spec §12 note, OPERATIONS.md eval line.
