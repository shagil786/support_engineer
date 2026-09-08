# ADR-0002: Hybrid BM25 + vector retrieval with RRF fusion

**Status:** Accepted (2026-09-07)

## Context

Retrieval started cosine-only over a deterministic hash embedder. Two failure
modes showed against real operational docs: an exact rare term ("postmortem")
drowns among trigram noise in vector space, while keyword-heavy runbook
phrasing misses paraphrase queries ("checkout service unresponsive" vs
"restart the pod"). Operational content is both exact-term-heavy *and*
paraphrase-prone, so neither single signal suffices. The rag-engineering
skill's guidance: hybrid search generally outperforms pure vector search for
factual recall.

## Decision

`FileBackedKnowledgeBase` scores every query through three composed stages
(`src/understanding/knowledge/knowledge-base.ts`):

1. **Two candidate pools** — Okapi BM25 lexical scoring plus cosine vector
   similarity (embedder swappable: hash default, local MiniLM, or remote
   OpenAI-compatible via the shared factory), each contributing up to 20
   candidates. Metadata `where` filters apply **before** scoring.
2. **Reciprocal-rank fusion** (k=60) merges the pools parameter-free — no
   score-scale tuning between a BM25 and a cosine distribution.
3. **Deterministic re-rank** over the fused candidates: vector similarity is
   the base (a zero-lexical-overlap paraphrase must survive), term coverage
   and density lift exact-term chunks, fused rank breaks ties. This body is a
   documented cross-encoder stand-in; a real model replaces it behind the
   same call site.

Chunks come from semantic markdown-section splitting (never mid-sentence,
word-aligned overlap for oversized sections); documents are the unit of
replacement (ingest by id), chunks the unit of retrieval and citation. The
golden-set eval pins both directions: vector rescues a paraphrase BM25
cannot see; BM25 rescues an exact rare term the embedder drowns.

## Alternatives considered

- **Vector-only** — lost exact rare terms (the eval case that killed it).
- **Keyword-only** — lost paraphrases, the original Layer-1 failure.
- **Weighted score blend instead of RRF** — requires tuning weights per
  embedder; RRF is rank-based and parameter-light.
- **Cross-encoder re-rank now** — better ceiling, but a model dependency and
  latency in the spoken-answer path; the deterministic re-rank captures the
  cheap wins and the seam is reserved.

## Consequences

- Two indexes must stay in sync with the doc map; ingest/evict rebuild all
  three atomically per document, and the snapshot reloads both on boot.
- Embedder swaps require a one-time `reindex()` (vectors only; BM25 and the
  chunk map survive). Identity-tagged embedders detect same-dimension model
  swaps that dimension checks cannot.
- The re-rank is the known ceiling; retrieval quality regressions show up in
  the golden set before they show up in spoken answers.
