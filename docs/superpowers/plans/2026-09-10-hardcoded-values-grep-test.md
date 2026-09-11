# Plan: Hardcoded-value grep test (spec §13 gap)

**Date:** 2026-09-10
**Follows:** the spec's own audit trail — §13 lists "Zero hardcoded hosts/tokens/keys in `src/` ✅
(by convention; grep test not built)" and §0.3 lists the grep test under "Promised but not built".

## Problem

The invariant is enforced by convention only. Nothing fails CI when a host, token, or key
literal lands in `src/`. The promise deserves a test, and the repo already has a
contract-test pattern for hand-written consumers (alerts, dashboard) — this is the same idea
turned inward: the codebase pins its own hygiene rule.

## Rule (what counts as a hardcoded value)

Scan `src/**/*.ts` (excluding `*.test.ts`) for *string literals*:

- **Hosts/URLs** — `https?://…` with a non-loopback, non-ENV-derived host:
  allowed roots: `localhost`, `127.0.0.1`, `[::1]`, and **any host from the `env.` / `process.env` chain** (see test note).
- **Tokens/keys** — literals whose *name* declares secretness: `\b[A-Z_]*(TOKEN|SECRET|KEY|PASSWORD|PASSWD|PWD|CREDENTIALS?|API_?KEY|KEYS)\b` matched against the *identifier or string key the literal is assigned to or compared against*.
- **Long high-entropy literals** — ≥ 24 chars in `[A-Za-z0-9_\-]` — heuristic net for things like base64 blobs. High-signal allowlist maintained in the test, each entry commented.

## What's explicitly OK

- The **provider-catalog file** (`src/support-voice-agent/tools/llm.ts`) — the repo's own
  documented provider catalog, a stable product list, not a deployment secret. It is pinned
  by its own unit test asserting exact catalog contents. **Boundary rule, restated:** URLs
  in `llm.ts` are catalog **keys**; every request URL must still derive its host from
  `env.LLM_BASE_URL` (its existing unit test pins this). The grep test additionally asserts
  that file imports `env` (config-only host sourcing) and contains no other URL literals.
  Catalog keys ≠ deployment endpoints.
- Loopback URLs (`localhost`, `127.0-255.0-255.0-255`, `[::1]`) in any file.
- URLs whose host derives from `env.*` / `process.env.*` (template literals already do this).
- Non-secret generic words (e.g. `openai` inside `model` strings) are not host/secret shapes —
  the patterns are deliberately host- and name-shaped, so they don't match.

## Verification before writing the test

Ran the candidate patterns manually across `src/` — findings so far (to become the initial
allowlist, each with a reason):

| Literal | File | Why it's OK |
|---|---|---|
| provider URLs in `llm.ts` | `src/support-remote...` | documented provider catalog (product decision, unit-pinned) |
| `https://slack.com/api` | `src/support-voice-agent/integrations/slack-bot.ts` | Slack API is the product's *definition* (the integration *is* Slack); base URL is a stable global constant, not per-deployment |
| `https://logs.${cfg.region}.amazonaws.com/` | `src/support-voice-agent/integrations/logs.ts` | RESOLVED: AWS regional pattern, region interpolates from config — host-allowlisted |
| `http://127.0.0.1`, `http://local…` in `server.ts` | `src/http/server.ts` | loopback (allowed root) |

(Resolved: `logs.ts` builds the AWS CloudWatch regional endpoint from a configured region —
allowed via the host-pattern allowlist. `src/fixtures/` is clean. Final tally: the real scan
passes with zero findings; every allowlist entry is exercised by a canary in the test.)

## TDD shape

- tests/hardcoded-values.test.ts scans every src .ts file, runs the three pattern families
  (URL/host, secret-name, entropy), asserts findings ⊆ allowlist.
- Fail message explains the rule, why the allowlist exists, and how to fix (config/env, or
  justify + allowlist with a reason).
- This test is a contract test (like tests/dashboard.test.ts): failure = regression on the
  invariant, and the invariant's carve-outs are visible and commented in one place.

## Bounds

New file `tests/hardcoded-values.test.ts` (+ plan doc). Spec §13 and §0.3 updated to
"grep test built"; OPERATIONS.md gets a hygiene-test line in the enforcement section.
`src/` itself: **no production code changes**.
