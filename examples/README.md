# First-run example corpus

A fresh deployment starts with zero knowledge by design — the agent refuses
to answer anything it cannot cite. This directory is the smallest corpus that
makes a first run useful; wire it with two env vars and replace its contents
with your team's real runbooks, postmortems, and on-call notes.

## What ships

- `runbooks.json` — a RunbookAction catalog: five sample actions including
  one destructive (`db-failover`, which policy gates behind two admin
  approvals). Every action is auto-ingested into the knowledge base at boot,
  so "how do I restart the checkout pod?" answers with a citation.
- `knowledge/*.md` — the demo war-room corpus, promoted here as the canonical
  first-run set: an on-call handbook, a cache-incident postmortem note, and
  two runbook walkthroughs matching the sample catalog.

## Wire it (env)

```sh
KNOWLEDGE_SEED_DIR=/app/examples/knowledge   # markdown corpus, ingested at boot
RUNBOOKS_FILE=/app/examples/runbooks.json    # executable catalog, synced to the KB
```

In containers the image already points at the shipped corpus, so
`docker run ... support-agent` answers from knowledge on the first boot. On a
bare host the paths depend on where you cloned the repo — the two vars above
with absolute paths are all it takes.

## Replace for production

Copy the shape, not the content:

- Knowledge: markdown files; `# Heading` structure becomes chunk headings and
  is what answers cite. Ingest-by-directory mirrors the corpus — files you
  delete disappear from the KB on the next boot.
- Runbooks: one JSON array of `{ id, name, description, destructive }`. The
  catalog is validated loudly at boot; `destructive: true` requires human
  approval before execution (see `policies/default.yaml`).

Re-index after changing the embedding backend:

```sh
npx tsx scripts/knowledge-cli.ts reindex
```
