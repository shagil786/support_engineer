# Plan: Pin the Node toolchain (.nvmrc, engines, engine-strict, CI check)

**Date:** 2026-09-11
**Follow-up to:** the prod-readiness sweep finding — "`engines: >=18` is wide for a
native-module dependency (`better-sqlite3`); pin a tested range or add `.nvmrc`."

## Problem

Five Node version sources exist and nothing ties them together:

| Source | Today | Meaning |
| --- | --- | --- |
| `package.json` `engines` | `>=18` on main; `>=22.12` on the vitest-5 branch | **A lie since the vitest 5 upgrade** — vitest 5 requires Node ≥ 22.12, so `>=18` claims support the suite no longer has. |
| `.nvmrc` | absent | Contributors (and nvm/auto-switching tooling) get whatever Node they happen to have. |
| CI matrix (ci.yml) | 22, 24 | The lines CI actually proves. |
| chaos.yml | 22 | Scheduled probe runs LTS only. |
| Dockerfile | `node:22-slim` (build + runtime) | **The production truth.** |
| Dev machine | v26.8.1 | Untested by any gate. |

CI "verifies" versions only implicitly: `setup-node` installs them, but nothing
asserts the toolchain in use matches the repo's declared floor.

## Decisions

1. **`.nvmrc` = `22`** — the production LTS line that ships (`node:22-slim`), not the
   dev machine's 26. Pinning the minor (`22.x.y`) in .nvmrc would rot within weeks;
   the LTS *line* is the contract, and CI gates both 22 and 24.
2. **`engines.node` = `">=22.12"`** — identical to the vitest-5 branch's string
   (`chore/vitest-5` already fixed this floor; mirroring exactly avoids a merge
   conflict and keeps one story: the floor is vitest 5's Node requirement, the
   tested range is CI's 22/24).
3. **`.npmrc` with `engine-strict=true`** — makes `npm install` refuse on a too-old
   Node locally, instead of a warning nobody reads. This is the local gate; CI keeps
   its own explicit check so the gate is visible in the run log.
4. **`check:node` script** (`scripts/check-node.ts`, sibling of `check-sqlite.ts`)
   — reads `engines.node`, checks `process.version` satisfies it, prints a one-line
   parity summary (floor / running / .nvmrc / Dockerfile). CI runs it as a cheap,
   explicit first step; every workflow gets it.
5. **Drift guard test** (`tests/toolchain-pinning.test.ts`) — the CI yml can drift
   silently (steps get deleted in refactors), so the *suite* pins: .nvmrc exists and
   equals the major of the Dockerfile runtime image; every workflow that sets up
   Node either uses the ci matrix or the pinned LTS; `check:node` exists and is
   wired into ci.yml, chaos.yml, and security.yml.

## Files

- `.nvmrc` (new) — `22`
- `.npmrc` (new) — `engine-strict=true`
- `package.json` — `engines.node` → `">=22.12"`; add `check:node` script
- `scripts/check-node.ts` (new) — the parity check
- `tests/toolchain-pinning.test.ts` (new) — the drift guard (TDD: written first, red)
- `.github/workflows/ci.yml` — `check:node` step + comment
- `.github/workflows/chaos.yml` — same step
- `security.yml` (open prod-hardening PR) — intentionally untouched: it runs
  gitleaks via a container and sets up no Node, so there is no toolchain to
  verify. The drift-guard test documents that exclusion.
- `README.md` — one line in Getting started (Node floor + .nvmrc)

## Explicitly out of scope

- Pinning Node 26 anywhere (it's the dev machine's choice, not a tested line).
- A CI matrix expansion to 26 — better-sqlite3 prebuilds are the constraint and the
  current comment already documents that policy.
- Volta/asdf files beyond .nvmrc (one tool-agnostic pin file is enough; nvm reads it,
  and the test + engine-strict cover everyone else).

## Verification

- TDD: drift-guard test red → files in → green.
- `npm run typecheck`, full suite.
- `engine-strict` install proof: `npm install --engine-strict` with a fake old floor
  must fail (temporary scratch package.json, reverted) — proves the gate actually gates.
- Merge-order note: this branch and `chore/vitest-5` both touch `package.json`
  engines; the strings are intentionally identical so either merge order is trivial.
