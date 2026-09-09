# ADR-0001: KB-first answering before governance

**Status:** Accepted (2026-09-07)

## Context

A question reaching the pipeline can be answered three ways: from the static
knowledge base (deterministic, cited), through the governed tool path (policy
engine → SafetyNet → supervisor log query), or by free LLM generation. The
naive ordering routed every question through governance first and consulted
the KB only as a fallback — spending policy checks, supervisor hops, and
tokens on questions that a static doc already answers. The failure it invites
is worse than waste: a question like "how do we fail over the database?"
answered by *running* a tool mutates the world when reading would do, and a
free-LLM answer can invent a runbook step.

## Decision

Questions are offered to the KB **first** (`GroundedQuestionStage.offer`,
`src/pipeline/grounded-question.ts`), before any governance. A grounded
answer ends the request: cited speech is delivered, a `grounded_answer` audit
event is recorded, and no tool is proposed. Two gates keep the shortcut
honest:

- **Live-data gate** — questions about *current* system state
  (`intent.liveData`, set by the LLM classifier and, narrowly, by the
  deterministic floor's `asksForLogs` heuristic) never touch the static KB. A
  lexically-similar postmortem must not answer "are there fresh errors right
  now?".
- **Refusal fall-through** — the answerer must cite; below the 0.4 relevance
  floor it refuses, and the question proceeds to the governed log-query path
  (provenance stamped `'logs'` — a skipped KB is a KB that did not answer).

Governance is not weakened: it sits on the *execution* path, and every KB
answer is itself audited.

## Alternatives considered

- **Governance-first, KB fallback** — simplest to reason about ("everything
  risky passes policy") but pays policy cost on read-only questions and
  tempts tool execution for answerable-from-docs questions.
- **LLM generation with governance** — most flexible, least verifiable;
  rejected as an answering strategy for spoken operational answers (the LLM
  stays for classification, extraction verdicts, and supervisor planning).
- **Parallel KB + governance race** — wasted work and nondeterministic
  provenance.

## Consequences

- Answer provenance is always explicit: `answerSource: 'knowledge'` with
  citations, `'jira'` for read-only ticket-status lookups, or `'logs'` via
  the governed path. Nothing answers unattributed.
- The KB's quality is load-bearing. An empty or stale KB silently pushes
  every question to the tool path (visible as `answerSource: 'logs'` in the
  audit spine); ingest-on-boot (ADR-0003) exists to keep it fed.
- The deterministic classifier floor must mirror the LLM ceiling's liveData
  rule, or the gate depends on an LLM being wired — closed when the floor
  gained `asksForLogs` parity.
