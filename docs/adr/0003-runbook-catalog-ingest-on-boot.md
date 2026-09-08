# ADR-0003: Runbook catalog ingest-on-boot

**Status:** Accepted (2026-09-07)

## Context

`createPlatform` wired the runbook catalog into the execution provider — the
agent could *execute* `restart-checkout-pod` — but never into the knowledge
base, so KB-first (ADR-0001) could not answer "how do I restart the checkout
pod" from an action the platform can actually perform. Manual CLI ingest
covers that gap once and then drifts: the first catalog change (an action
renamed, removed, or made destructive) leaves the KB answering from stale
facts about what the platform can do — worse than no answer, because the
answer cites authority it no longer has.

## Decision

The catalog is the source of truth and the KB mirrors it on **every boot**
(`src/bootstrap/runbooks-kb.ts`, called from `createPlatform`):

- One KB doc per action (`runbook:<id>`), body = name as heading, offer verb
  phrase, action id, and the approval posture (destructive actions state that
  they always require explicit human approval).
- **Replace-by-id ingest** makes re-sync idempotent; **eviction** removes any
  `runbook:`-prefixed doc whose action left the catalog, so the KB never
  answers from an action the platform no longer offers.
- `ready()` awaits the sync: a readiness surface never reports a half-ingested
  corpus. The same sync backs the `knowledge-cli runbooks <file>` command for
  operators syncing without a restart.
- Docs carry `source: 'runbooks'` plus `runbookId`/`destructive`/tag
  metadata, so citations name the catalog entry, and metadata filtering can
  scope to the executable surface.

## Alternatives considered

- **Manual CLI ingest only** — drifts from the catalog by construction;
  kept, but as an operator convenience on the same sync function, never as
  the mechanism.
- **Ingest on catalog write** — requires the provider to know about the KB
  (a dependency edge from execution into understanding) and misses out-of-band
  catalog edits; boot-time reconciliation is self-healing regardless of how
  the catalog changed.
- **Separate runbook index** — a second retrieval substrate to query and
  keep honest; the KB already owns "static operational knowledge".

## Consequences

- The KB-first path answers from the executable surface by construction; a
  KB answer about a runbook can be executed, and every executable action is
  documented.
- Every boot re-ingests the catalog (cheap: replace-by-id, atomic snapshot
  writes); catalogs with hundreds of actions may want the sync made dirty-
  checked — correctness is unaffected either way.
- `runbook:` is a platform-owned doc-id namespace: anything else written
  under that prefix by hand will be evicted on the next boot.
