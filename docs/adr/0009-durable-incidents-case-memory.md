# ADR 0009: Durable Incidents + Case Memory

Date: 2026-09-13
Status: accepted

## Context
ADR-0007 shipped the incident brain (a pure, phase-gated state machine with
`serialize`/`deserialize` "for durable hosts") and `IncidentMemory`
(case-based recall over past-incident signatures). Neither had a host:
records lived only in whatever variable the caller held, and the case
library was a plain in-memory array — every restart lost both the open
incident's timeline/approval linkage and the lessons of every closed one.

## Decision
Add file-backed persistence as plain libraries (no runtime, no new
subsystem), following the platform's established durability conventions
(mirroring `FileBackedVectorMemory`):

1. **`FileBackedIncidentStore`** (`src/incident/durable.ts`) — persists
   `IncidentRecord`s as a human-inspectable JSON snapshot with atomic
   tmp+rename writes; upsert-by-id; `get`/`all`/`byPhase` surfaces. Loaded
   entries are round-tripped through the brain's own `deserialize`
   validator, so the on-disk shape and the runtime shape cannot drift.
2. **`FileBackedIncidentMemory`** — composes the existing `IncidentMemory`
   (the similarity engine is untouched) and persists the case library; the
   wrapper keeps a mirror of the set only for flushing, in step by
   construction.
3. **Shared failure policy**: a missing file is an empty store (first run);
   a corrupt snapshot fails open (start empty, log, repair on the next
   mutation) — memory loss is never worse than memory corruption; a failed
   flush leaves the in-memory set correct and is logged, non-fatal;
   on-disk entries failing validation are dropped, not fatal.
4. **Wiring**: `createPlatform` constructs both under the runtime data root
   (`<dataDir>/incidents/records.json`,
   `<dataDir>/memory/incident-cases.json`) and exposes them as
   `platform.incidents` / `platform.incidentMemory`; both are exported from
   the `incident-support` barrel. Hosts drive the brain and call
   `save()` at each transition — durability is a library call away, not a
   framework.

## Consequences
- An incident investigation survives a process restart with its timeline,
  hypotheses, and approval linkage intact; a restarted process can resume
  the lifecycle at any phase (verified by continuing a deserialized record
  through `proposeFix` → `awaitApproval`).
- Recall keeps improving across restarts: a case stored once is recalled
  forever after ("87% similar to INC-1842…") without re-learning.
- Default-off-by-default nothing: the stores are always constructed and
  cheap (JSON snapshots, write-per-mutation) — incident volume is low by
  nature, so no batching/compaction is warranted yet.
- No migration: there was no prior durable format to be compatible with.
- If incident volume ever grows, the snapshot format (a JSON array) can be
  replaced by JSONL append or a real DB behind the same class surface.

