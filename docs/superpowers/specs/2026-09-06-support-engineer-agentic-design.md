# Support Engineer — Agentic Orchestration Design

**Status:** Implemented (v1) — this document describes the system **as built**
**Date:** 2026-09-06 (revised after implementation)
**Repo:** `support_engineer` (Freebuff Desktop / Support Voice Agent)
**Suite at time of writing:** typecheck clean, **460/460 tests green** across 58 files (the original 150 remain as the regression floor)

---

## 0. Implementation status & deviation audit

All five phases are implemented and wired into the live agent. Where the original
draft diverged from what was built, **reality won** — usually because a phase
plan's own tests contradicted its prose, or because the draft described tool
names and file moves that don't exist in this repo. The material deviations:

### 0.1 Global

| Draft said | Built instead | Why |
|---|---|---|
| Dotted tool names (`jira.getIssue`, `runbook.execute`) throughout | The repo's real `ToolName` union (`jira_create_issue`, `query_logs`, `execute_runbook_script`, `invoke_human_on_slack`, `meeting_interrupt`) everywhere — event types, policy DSL, eval scenarios, registry | The dotted names never existed in this codebase; binding to a fiction would have made governance untestable against the real tools |
| Replace the deterministic brain | **Compose around it** (see §15) | The etiquette cascade is battle-tested and deterministic; the platform wraps it instead of rewriting it |
| `src/llm/`, top-level `src/integrations/`, `src/surface/meeting/` moves | LLM client stays at `support-voice-agent/tools/llm.ts`; integrations stay under `support-voice-agent/`; meeting bridge untouched under `support-voice-agent/bridge/` | Moving working code adds churn with no behavioral payoff; new layers got their own top-level dirs |

### 0.2 Per-phase deltas

- **Phase 1 (Event spine)** — built as drafted. 11-kind `DecisionEvent` union, JSONL daily segments, serialized writes, streaming filtered queries.
- **Phase 2 (Understanding)** — `LegacyClassifierAdapter` checks runbook offers *before* direct questions (the draft's order misclassified "can you restart X?"). `EpisodicMemory` has **real** TTL expiry and a real `purgeMeeting` (draft's version was a stub that couldn't pass its own test). `ContextBundle` = envelope + episodes + recent decisions — **no policy summary component** (draft §4.1 item 4 dropped). No `embedders/openai.ts` — the `Embedder` port stays swappable but only the hash embedder ships.
- **Phase 3 (Governance)** — policy DSL is a strict Zod-validated key set (`intent_kind`, `intent_subKind`, `tools_in`, `severity_in`, `runbook_destructive`, `output_matches_regex`), not dotted-path conditions; unknown keys fail at load. Default-deny on no match. `GovernanceDecision` extends `Decision` with `approverRole/approverCount/timeoutSeconds/onTimeout` so the ApprovalGate has something to consume. `PolicyStore` is SQLite (`policy_versions`, `policy_current`) with content-addressed YAML on disk; promotion metadata lives on the version row (no separate `policy_promotions` table). `ApprovalGate` posts plain-text Slack messages (no Block Kit buttons, no slash fallback in v1) and exposes pull-based `checkTimeouts()`. `LoopDetector` is **stateful per correlationId** (a stateless counter can't see pending calls). `SafetyNet.runAll` takes `args`; RBAC gates `execute_runbook_script`. No `security.yaml`/`meeting.yaml` bundles — one `default.yaml`, parity-tested.
- **Phase 4 (Execution)** — `ToolRunner` pipeline: governed-check → SafetyNet re-check → registry lookup → Zod validate → idempotency → retry/timeout → one `tool_call` event. **No per-tool rate limiting and no `Retry-After` support in v1.** The error boundary moved: tools **throw** transport errors (so retries can fire) and return `ToolResult` for handled failures; the runner catches/retries/reports and never throws across its own boundary. Sub-agents are `LlmAgent`s with Zod JSON outputs and honest `source: 'llm' | 'fallback'` marking; tool "whitelists" are enforced in each agent's output schema, not by the runner. **No reviewer-feedback retry loop** — a `fail` verdict ends the request `ok=false` (retry-with-feedback is future work). **No cancellation/abort** (§6.3 of the draft dropped); plans execute sequentially.
- **Phase 5 (Learning + surfaces)** — `OutcomeRecord` is lean: `correlationId`, `toolCalls`, `finalResult?`, `approvals[]`, `ts` (no intent/feedback/token fields in v1). `SuggestionQueue` v1 = one threshold heuristic (destructive approvals → propose relaxing `approver_count`, **risk: high**). `PromotionGate` evaluates the **candidate** bundle (better than the draft's "current + proposed": a regression-causing patch is refused before it lands) and refuses `tighten_safety_net`/`add_procedure` suggestions outright. `ProcedureSpec.trigger` is the tool-sequence string, not an `IntentMatch`; **procedures short-circuit execution**: the Supervisor's `ProcedureLibrary` matches requests by leading tool (live thresholds: sample ≥ 3, success rate 1.0) and replaces the dance — the approved action replays with its *current* args, only read-only follow-ons replay, and any failure degrades to the full dance. `LEARNING_ENABLED` env flag, default off, absent = unwired. Suggestion review is API-only — no CLI/Slack UI yet.

### 0.3 Promised but not built in v1

The "no hardcoded values" grep test; `PolicyEngine` hot-reload
on promotion (the store promotes; a new engine instance is constructed per
deployment); Slash-command approvals; per-tool rate limits; cancellation;
multi-tenant policy (still a non-goal).

---

## 1. Context and motivation

The repo (`src/support-voice-agent/`) is a *meeting etiquette state machine with
optional LLM co-pilot* — strict port-based layering, no hardcoded config, honest
degradation, hard-gated guardrails. On top of it now sits a four-layer agentic
orchestration:

1. **Understanding** (learned, memory-driven)
2. **Governance** (declared, policy-driven)
3. **Execution** (adaptive, tool-driven)
4. **Learning** (self-improving, outcome-driven, online with human gates, bounded by guardrails)

The result is a **full support engineer platform**: live meeting participation,
async/on-call work (webhook triage), and proactive discovery. The Learning layer
is online, human-gated, and SafetyNet-bounded; SafetyNet checks live in code, not
policy. The multi-agent shape lives inside Execution (Triage / Investigator /
Executor / Reviewer under one SupervisorAgent).

**The legacy agent is not deleted.** It remains the etiquette engine (mute/wake/
barge-in/confirmations), the deterministic fallback when the platform fails, and
the host of the meeting surface. See §15.

## 2. Non-goals

- Not an LLM framework; no generic agent SDK. The domain is support engineering.
- No new vector DB, no new policy language: Zod at boundaries, YAML policies, JSONL events.
- Integrations are not rewritten: Jira/Logs/Runbook/Slack clients unchanged.
- SafetyNet is not overridable from policy. It is code.
- No multi-tenant policy isolation in v1.

## 3. Top-level architecture

```
┌──────────────────────────────────────────────────────────────┐
│  UNDERSTANDING  (src/understanding/)                         │
│  • IntentClassifier (LLM-backed; Zod-validated envelope;     │
│    honest degradation, optional correlationId join)          │
│  • LegacyClassifierAdapter (today's heuristics as floor)     │
│  • EpisodicMemory (per-meeting TTL + cross-meeting)          │
│  • ContextAssembler → ContextBundle                          │
└──────────────────────────────────────────────────────────────┘
                              │ IntentEnvelope + ContextBundle
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  GOVERNANCE  (src/governance/)                               │
│  • PolicyEngine (YAML rules, strict DSL, default-deny)       │
│  • ApprovalGate (Slack text + M-of-N signatures + timeouts)  │
│  • SafetyNet (RBAC, injection, loop, cost, PII — code only)  │
│  • PolicyStore (SQLite versions + content-addressed YAML;    │
│    PromotionGate is the only writer)                         │
└──────────────────────────────────────────────────────────────┘
                              │ GovernedAction
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  EXECUTION  (src/execution/)                                 │
│  • SupervisorAgent (caps + learned-procedure shortcut)        │
│  • Triage / Investigator / Executor / Reviewer (LlmAgents)   │
│  • ToolRunner (governed-only → SafetyNet → Zod → idempotency │
│    → retry/timeout → tool_call event)                        │
│  • verifier (deterministic checks, reuses OutputFilters)     │
└──────────────────────────────────────────────────────────────┘
                              │ Outcome
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  LEARNING  (src/learning/, off unless LEARNING_ENABLED)      │
│  • OutcomeRecorder (var/outcomes/<cid>.json)                 │
│  • SuggestionQueue (v1 heuristic → PolicySuggestion)         │
│  • EvalRunner (+ policies/eval/*.yaml)                       │
│  • PromotionGate (candidate eval + SafetyNet regression +    │
│    M-of-N; only PolicyStore writer; policy_promoted event)   │
│  • KnowledgeExtractor (successful tool sequences →           │
│    ProcedureSpecs in cross-meeting memory)                   │
│  • EfficacyTracker (procedure vs pipeline stats; live        │
│    success-rate feedback; retires weak procedures)           │
│  • LearningLoop (cron bootstrap: extract → scan → feedback   │
│    → library refresh on a schedule; stage-failure tolerant)  │
└──────────────────────────────────────────────────────────────┘

Wiring (src/pipeline/): OrchestratedPipeline owns the legacy agent and routes
per §15. **Composition root (src/bootstrap.ts): `createPlatform` builds the
whole platform — integrations, policy, SafetyNet (unknown speaker = guest,
`approver` = admin), durable learning — and `scripts/serve.ts` runs it as a
console host with a `:learning tick` command and an optional HTTP surface
(`HTTP_TOKEN`-gated, fail-closed — see §3.1).** Event spine (src/event-log/):
append-only JSONL under var/events/. Surfaces (src/surface/): async
(jira/slack/cron parsers) + proactive (anomaly).
```

### 3.1 Surface modes

| Mode | Entry point | Status |
|------|-------------|--------|
| **Live meeting** | `OrchestratedPipeline.processUtterance` → classifier → route (§15); bridge/STT unchanged | Implemented |
| **Async ticket** | `parseJiraWebhook` / `parseSlackMention` / `buildCronEnvelope` → `processEnvelope`; `POST /slack/events` accepts verified Slack Events deliveries (v0 HMAC + `event_id` dedupe); `POST /envelope` (bearer auth) dispatches structured deliveries through `buildEnvelope` (`src/surface/dispatch.ts`): sources `jira`, `anomaly`, `slack-mention`, `cron` — every §3.1 parser now has an HTTP ingress. Parser-rejected payloads are dropped (`accepted: false`), unknown sources 400, and caller-supplied `proposed` actions are refused: policy picks the action | Implemented — parsers + `/slack/events` + `/envelope` (all sources) |
| **HTTP API** | `createHttpServer` (`src/http/server.ts`): `POST /utterance` → `processUtterance`, `POST /approvals/:id/{sign,execute}`, `GET /healthz`, `POST /slack/events` (routes `reaction_added` to the ApprovalGate for emoji sign-off) | Implemented — bearer-token auth (fail-closed: no tokens configured → 503, never an open surface), body-size cap, roles always resolve server-side from the speakerId (never client-asserted) |
| **Approval UX** | ApprovalGate posts via bot-token `chat.postMessage` (`slack-bot.ts`, message refs → per-approval correlation; webhook posters fall back to single-pending correlation). Emoji reactions on the security channel count as signatures: 🛡️ admin, 🔧 engineer, 👀 / ✅ viewer, ❌ deny (names or glyphs; `reactionRoleMap` overridable). A reaction is a *claim* — it counts only if the reactor's server-resolved role is at least the mapped role; dedupe by user id; removals never change state. Lifecycle changes land on the ORIGINAL message via a capability ladder: `updateMessage` (chat.update — grant, per-signature progress like `1/2`, deny, timeout) → `postReply` (in-thread) → standalone channel post (deny/timeout only; grant/progress are threaded-only and stay silent for webhook-era posters, who keep the plain-post behavior). Fire-and-forget throughout so Slack outages never block governance; the pending window is `APPROVAL_TIMEOUT_MS` (≥ 1000, default 5 min). **Block Kit cards**: rich-capable clients (`postRichMessage`/`updateRichMessage` on the port) post state-colored attachments — ⚠️ warning pending (with Approve/Deny buttons whose `action_id` embeds the approval id), 🟢 good granted, 🔴 danger denied, 🟠 warning timeout; resolved states drop the buttons. Button clicks arrive at `POST /slack/interactive` (form-encoded, HMAC over the raw body) and flow through `ApprovalGate.handleAction`, sharing the reaction role-gate (approve = admin) and per-user dedupe; the embedded id correlates clicks even with several pending. Text-only clients keep the exact pre-card behavior. **Abuse resistance**: per-credential token buckets (`rateLimitPerMinute`, default 120/min; bearer routes key on the validated token, Slack routes on source IP, health + 401s exempt) return 429 + `Retry-After`; dispatch routes honor `Idempotency-Key` (replay of stored 2xx with `idempotent-replay: true`, concurrent same-key requests coalesce into one execution, non-2xx not cached, TTL-bound), and `POST /approvals/:id/execute` auto-coalesces by credential+path+body within `executeReplayTtlMs` (default 5 min) so rapid re-execution cannot double-run a governed action | Implemented (`handleReaction` + `handleAction` + `SlackLike.postMessageWithRef?`/`updateMessage?`/`postReply?`/`postRichMessage?`/`updateRichMessage?` + threaded lifecycle + Block Kit cards + rate limiting + idempotency) |
| **Proactive** | `anomalyToEnvelope` (`isIncidentWorthy`: P0/P1 = incident, else anomaly) → `processEnvelope` | Implemented |

### 3.2 Event spine

Append-only `DecisionEvent` log; every layer emits; Learning, the pipeline's
recent-events window, and audits read. v1 stores JSONL segmented daily under
`var/events/` (gitignored), serialized per-process writes, streaming filtered
queries (`kind/layer/source/correlationId/from/to`). Same `EventLog` interface;
pluggable to Postgres/Kafka later.

## 4. Layer 1 — Understanding (intent + memory)

### 4.1 Components

**`IntentClassifier`** (`understanding/intent-classifier.ts`) — LLM-backed,
Zod-validated `IntentEnvelope` (union as drafted, plus the additive
`entities.runbookDestructive?: boolean` flag — see §5.1). Degradation is honest:
unwired LLM / unparseable output / schema-invalid output → deterministic
fallback (each fallback reason recorded in the emitted event's
`contextBundleRef: via:<reason>`); transport failures **propagate**.
`classify(input, { correlationId })` lets a caller stamp the emitted
`understanding` event with the request's correlation id so the trail joins.

**`LegacyClassifierAdapter`** — ports today's heuristics; order: mute → critical
→ feedback → complaint → **runbook offer** → direct question → wake → unknown.
(Offers before questions: "can you restart X?" is both; the offer is more
specific.)

**`EpisodicMemory`** — per-meeting (TTL 30d default, `{ meetingId, recordedAt }`
stamps, real `purgeMeeting`) + cross-meeting (persistent, holds procedures).
Local `hashEmbedder` default; `Embedder` port for swaps. The cross scope is
durable when constructed with `crossPath`: `FileBackedVectorMemory` persists a
JSON snapshot (atomic tmp+rename, corrupt-file fail-open) so learned
procedures survive restarts; the embedder must be stable across restarts
(persisted vectors). `perMeeting` stays intentionally ephemeral.

**`ContextAssembler`** → `ContextBundle { envelope, episodes, recent, knowledge? }` from the
envelope, top-K recall (`topK=5, minScore=0.3` default), and a recent-decision
window. *No policy summary component in v1.*

**`FileBackedKnowledgeBase`** (`understanding/knowledge/`) — the hybrid retrieval
substrate (RAG): semantic section-boundary **chunking** (`chunker.ts`, overlap on
oversized sections, heading + doc metadata as provenance), **Okapi BM25**
lexical index + cosine **vector** index fused by **reciprocal-rank fusion**
(k=60, union of top-20 candidates per signal), then a deterministic
**re-rank** (vector score as base; term coverage/density as boosts — a
zero-lexical-overlap paraphrase must survive; a cross-encoder replaces it
behind the same seam). **Query-time metadata filters** (`where: {source,
tags, …}`) pre-filter candidates before scoring. Storage mirrors
`FileBackedVectorMemory` (atomic snapshot, corrupt-file fail-open) at
`var/knowledge/kb.json`; hosts ingest via `knowledge.ingest({id, text,
metadata})` or `scripts/knowledge-cli.ts` (seed/ingest/search/list). Hits
flow into the bundle as `knowledge?: KnowledgeHit[]` with full provenance
(`docId, index, heading, metadata`) — the citation layer's substrate.
`evaluateRetrieval` + `assertQualityGate` (`retrieval-eval.ts`) grade
golden sets on **hit rate / MRR**; `scripts/retrieval-eval.ts` (`npm run
eval:retrieval`) is a CI **gate step** next to the policy eval — it seeds a
fresh KB when the snapshot is absent, or grades a real snapshot via `--kb`,
with tunable thresholds; the shipped seed corpus + 9-case golden set
(`fixtures/retrieval-golden-set.ts`) runs in the suite and fails loudly on
retrieval regressions.

**Embeddings** — the `EmbedderLike` port accepts sync (hash) and async
(cloud/local) backends. `OpenAiCompatibleEmbedder` (`memory/embedders/openai.ts`)
batches, caches per (model, text), L2-normalizes, and deterministically
folds oversized vectors to `EMBEDDINGS_DIM`; `EMBEDDINGS_BASE_URL/_API_KEY/
_MODEL` are all-or-nothing (partial config throws). **`LocalEmbedder`**
(`memory/embedders/local.ts`) runs all-MiniLM-L6-v2 in-process via
transformers.js — real semantic vectors with no key and no second provider
(inferX serves chat models only, verified against its `/models` catalog and
docs). Lazy singleton pipeline (dynamic import, first-embed load, ~25MB
cached), batching, dim folding, honest `EmbeddingError('model_load'|
'inference')`. Config is provider-discriminated: `EMBEDDINGS_PROVIDER=local`
(optional `EMBEDDINGS_MODEL`, `EMBEDDINGS_DIM`) vs `remote` (the legacy
implicit default); a single **`embedderFromConfig` factory**
(`memory/embedders/factory.ts`) is the only construction site — bootstrap,
`knowledge-cli`, and both eval scripts — so a migrated KB is always queried
under its own vector backend (mixing backends silently would corrupt
retrieval). Swapping backends is a one-time migration: `reindex()` re-embeds
every record in place (docs and BM25 untouched), also exposed as
`knowledge-cli reindex`. Concurrency note: the KB tracks in-flight vector
adds and `search()` settles them first — async embedders make indexing
genuinely concurrent with queries, and an unsettled boot race silently
drops the semantic signal (BM25 survives, vector-only queries return
nothing).

**`GroundedAnswerer`** (`understanding/grounded-answerer.ts`) — the
hallucination-reduction layer over the KB: empty/near-zero retrieval →
**refuse without calling the LLM** (guessing from nothing is structurally
impossible); otherwise a numbered-context prompt ("answer ONLY from the
context, cite the numbers, state facts directly — never 'the context says'"
— meta-framing judges as unsupported even when true), a Zod-validated
`{answer, citations[]}` reply with citations filtered to numbers that
actually exist, and an honest extractive floor (top-chunk sentences, still
cited) when the LLM is unwired, invalid, or uncited. **Claim-verification
guard** (`claimJudge`, the `FaithfulnessJudge` contract reused in-request):
when configured (bootstrap wires `LlmClaimJudge` whenever the LLM is
wired), every sentence of an LLM answer must be entailed by its cited
context — any unsupported claim (or judge failure) fails CLOSED to the
extractive floor; hallucination prevention, not detection-after-the-fact.
Answers report `llmVerified` so consumers know whether an LLM answer was
verified or the deterministic floor served. Exposed as `platform.answerer`
and **`POST /ask`** on the HTTP surface (`{question, topK?, where?}`,
bearer auth + rate limit + idempotent replay like every dispatch route;
refusals are 200 — an honest answer, not an error).

**Voice grounding (live path)** — the pipeline tries the answerer FIRST for
`question` intents, at a stricter **0.4 floor** (spoken answers must be
genuinely about the corpus; measured separation: on-topic ≈ 1.45, off-topic
≈ 0.29). A grounded hit is delivered via `deliverSpeech` with citations,
emits a **`grounded_answer`** DecisionEvent (added to the event log's
runtime `KINDS` allowlist — `append()` rejects unknown kinds at runtime
even when the TS union compiles), and returns
`answer`/`answerSource: 'knowledge'` with no tool calls. A KB refusal
falls through to the governed `query_logs` path unchanged, marked
`answerSource: 'logs'`; without an answerer wired, behavior is unchanged
(no new fields). Trade-off, by design: a question with real lexical
overlap gets the corpus answer instead of a live log fetch.

**Faithfulness eval** (`understanding/faithfulness-eval.ts`) — the
generation-quality complement to hit-rate/MRR: answers are split into
claims and each claim is judged against its cited context text.
`LexicalClaimJudge` (content-word overlap, conservative — a floor, never
a ceiling) is deterministic and LLM-free; `LlmClaimJudge` upgrades
verdicts via LLM-as-judge (Zod-validated `{verdict}`, per-claim fallback
to the lexical floor). Refusals are graded: correct when `expectRefusal`,
zero when over-refusal. Per-case **`servedBy`** (`llm` | `llm-rejected` |
`extractive` | `refusal`) makes the guard's swaps visible — a guard that
silently replaced LLM answers with the floor could not green-wash the
gate. `GroundedAnswer.sources` carry the chunk text so judges and `/ask`
clients can verify claims without re-reading the KB. The eval grades at
the production 0.4 floor with the same claim guard production ships
(`scripts/faithfulness-eval.ts` constructs the answerer identically to
bootstrap); `npm run eval:faithfulness` prints per-case OK/FAIL lines and
exits below threshold like the retrieval gate.

### 4.2 Boundary discipline

Understanding describes; it never calls tools or decides policy. A classifier
bug cannot directly cause a Jira write.

## 5. Layer 2 — Governance (policy-as-data)

### 5.1 Components

**`PolicyEngine`** — loads one YAML bundle; rules are Zod-validated with
**strict objects** (unknown keys throw at load). Supported predicate keys:

```yaml
rules:
  - id: destructive_runbook_requires_admin_approval
    when:
      intent_subKind: runbook_offer       # + optional intent_kind
      runbook_destructive: true           # provider flag first, id heuristic fallback
      tools_in: [execute_runbook_script]
    effect: require_approval              # allow | deny | require_approval | transform
    approver_role: admin
    approver_count: 2
    timeout_seconds: 300
    on_timeout: deny

  - id: p01_alert_auto_incident
    when:
      intent_kind: proactive_alert
      severity_in: [P0, P1]
      tools_in: [jira_create_issue, meeting_interrupt]
    effect: allow

  - id: never_emit_credit_card
    when:
      output_matches_regex: '\b(?:\d[ -]*?){13,19}\b'
    effect: deny
```

Semantics: **first matching rule wins; no match = default-deny.** Matching is
against `(IntentEnvelope, ProposedAction)`; `output_matches_regex` tests the
serialized action args. Approval constraints ride on the returned
`GovernanceDecision` (`approverRole/approverCount/timeoutSeconds/onTimeout`).

**Destructiveness resolution:** `runbook_destructive: true` matches when
`entities.runbookDestructive === true` (provider-confirmed — set by the pipeline
from the runbook catalog); if the flag is `false` the rule cannot match; if
absent, the fallback heuristic checks ids for `all|prod` scope markers.

**`ApprovalGate`** — stages approvals: posts a plain-text Slack message (tool,
args, M-of-N count), tracks signatures (`sign(id, role, signerId?)` — dedupes by
signer when `signerId` is given), `deny` is terminal (signing cannot resurrect),
`checkTimeouts()` expires pending approvals (default 5 min) and emits
`approval_timeout`. Emits `approval_request` / `approval_granted` events.
*Block Kit buttons and slash commands are not in v1.*

**`SafetyNet`** — always-on code (constructor options only, never policy):
`Rbac` (destructive tools need approver roles; unknown speakers = guest — ports
`Guardrails`), `Injection` (delegates to `isPromptInjection`), `LoopDetector`
(**stateful per correlationId**; veto when a call would exceed 3 identical
`(tool, args)` executions), `CostCap` (50k tokens default), `OutputFilters`
(credit cards, AWS keys, JWTs — veto, not redact). `runAll()` runs every check;
any veto wins over any policy allow; the result carries
`unconditionalSafetyNetCheck: true`.

**`PolicyStore`** — SQLite (better-sqlite3, WAL): `policy_versions` (sha256,
content-addressed YAML path, author, signer, parent lineage, promotion metadata)
+ `policy_current` (single-row pointer, FK-enforced). `save`/`promote` are
async; `promote` requires ≥1 signer, an evalRunId, and `safetyNetPassed: true`
(Zod-enforced) in one transaction. PromotionGate is the only production writer.

### 5.2 Boundary with Execution

`GovernedAction = execute | request_approval | deny` exactly as drafted;
`ToolRunner.run(governed, ctx)` accepts nothing else — an unresolved
`request_approval` throws.

### 5.3 Boundary with the legacy repo

`guardrails.ts` RBAC → `safety-net/rbac.ts` (the original Guardrails class
remains for the legacy path). "Destructive requires admin" is data in
`policies/default.yaml`, parity-tested: read-only allow; destructive runbook →
2-admin/300s/deny-on-timeout; non-destructive stays allowed; PII hard-denied;
P0/P1 alerts auto-allowed; unknown tools default-deny.

## 6. Layer 3 — Execution (multi-agent)

### 6.1 Components

**`SupervisorAgent`** — pipeline per request: Triage → Investigator plan
(read-only) → Reviewer → **the governed action** → Executor plan (side-effects)
→ final Review. Every step runs through the ToolRunner and `verifyResult`;
any failed verification ends the request `ok=false` with the root cause in
`reason`. Caps (fail-closed): `maxHops=8`, `maxTokens=50k`, `maxWallClockMs=60s`,
`maxIdenticalToolCalls=3` (reuses the SafetyNet's LoopDetector per
correlationId). Emits `agent_outcome` (summary + hops + toolCalls + `via:pipeline|procedure`)
with additive `stats` (`source`, `hops`, `toolCalls`, `wallClockMs`,
`procedureId`, `fallbackFrom` on degraded attempts) consumed by the
EfficacyTracker.
When a `ProcedureLibrary` is wired, a learned procedure matching the governed
action **replaces the dance**: the action replays with its current approved
args (never historical ones), read-only follow-ons replay, mutating follow-ons
are skipped (policy approved *this* request, not the procedure's history), and
any failure degrades to the full dance. Output carries
`source: 'pipeline' | 'procedure'`. Deny and
unresolved-approval inputs fail closed without executing. *Reviewer-fail →
retry-with-feedback is not in v1; a `fail` verdict ends the request.*

**Sub-agents** — `LlmAgent` base: focused system prompt, Zod-validated JSON
output, `source: 'llm' | 'fallback'` on every result; unwired/invalid →
deterministic fallback; transport errors propagate. Tool constraints live in
each schema (Triage suggests from the real `ToolName` enum; Investigator plans
only `query_logs`/`invoke_human_on_slack`; Executor plans only mutating tools;
Reviewer has none).

**`ToolRunner`** — the single path to integrations:

1. GovernedAction check (`deny` → failure; `request_approval` → throw).
2. SafetyNet re-check (defense in depth).
3. Registry lookup (typed `satisfies Record<ToolName, ToolEntry>`).
4. Zod arg validation.
5. Idempotency dedupe (optional key, 5-min TTL, injectable clock).
6. Execute with **per-attempt timeout (30s default)** and **retry with
   exponential backoff on thrown errors** (3 attempts default).

Error contract: tools **throw** transport failures (retryable) and return
`ToolResult` for handled failures (validation, provider-reported errors, unwired
ports). The runner never throws across its boundary for validation/execution
failures. Exactly one `tool_call` event per run (final result, attempts, latency).
*Per-tool rate limiting and `Retry-After` support: not in v1.*

**`verifier`** — deterministic checks (Jira key shape, per-tool ok, PII output
filter via SafetyNet `OutputFilters`) and surfaces the underlying error string
(e.g. a SafetyNet veto) in the failure reason.

### 6.2 Boundary with the legacy repo

`tools/handlers.ts` behavior is preserved inside `execution/tools/*` (same
result shaping and wording); the original handlers remain for the legacy path.
The LLM `LlmOrchestrator` and `maxRounds` remain only inside the legacy agent.
**`processUtterance` is NOT deleted** — see §15.

## 7. Layer 4 — Learning (online, human-gated, SafetyNet-bounded)

### 7.1 Components

**`OutcomeRecorder`** — joins events per correlationId:

```ts
type OutcomeRecord = {
  correlationId: string;
  toolCalls: ToolCallEvent[];
  finalResult?: { ok: boolean; summary: string };
  approvals: ApprovalGrantedEvent[];
  ts: number;
};
```

Persisted to `var/outcomes/<correlationId>.json`. (Leaner than drafted: no
intent/decisions/feedback/token fields in v1.)

**`SuggestionQueue`** — `scan()` over outcome files; v1 heuristic: ≥ threshold
(default 5) outcomes with destructive-runbook approvals → one suggestion
`modify_rule destructive_runbook_requires_admin_approval { approver_count: 1 }`,
**risk: high**, evidence-carrying, malformed-file tolerant. Suggestions are
proposals only; they never touch the store.

**`EvalRunner`** — runs `policies/eval/scenarios.yaml` (8 scenarios) against a
bundle; scenario files are Zod-validated (fail loud). Ships with
`policies/eval/safety_net_regression.yaml` (3 must-still-veto scenarios).

**`PromotionGate`** — the only PolicyStore writer. Order of operations:
signature count (default 2) → optional `hasPolicyAdminRole` check → suggestion
Zod validation (**`tighten_safety_net` and `add_procedure` are refused outright**
— SafetyNet is code; procedures belong in memory) → build candidate bundle
(add/modify rules via yaml round-trip; unknown ruleId throws) → **evaluate the
CANDIDATE** with EvalRunner (a regression-causing patch is refused before
landing) → run SafetyNet regression (must veto, and veto for the expected
check) → atomic save+promote with lineage → emit `policy_promoted` (bundleSha,
promotedBy). *No hot-reload of a long-lived engine in v1; construct engines per
deployment or after promotion.*

**`KnowledgeExtractor`** — offline/nightly; clusters outcomes by the ordered
sequence of **successful** tool calls (min cluster 2); failures never inflate a
procedure's `successRate` (1.0 by construction). Produces `ProcedureSpec
{ id, trigger (tool sequence), steps, successRate, sampleSize }` into
cross-meeting episodic memory.*Procedures are consumed at runtime by the Supervisor's `ProcedureLibrary` short-circuit (§6.1).*

**`EfficacyTracker`** — the measurement half of the loop. Aggregates the
Supervisor's `agent_outcome.stats` into a per-procedure + pipeline-baseline
snapshot (persisted to `var/stats/procedure-stats.json`), then
`applyFeedback()` blends live outcomes into each stored spec's `successRate`
— `(extracted·rate + liveOk) / (extracted + liveServed)` — so one failure
dents strong evidence instead of destroying it, and retires procedures whose
blended rate falls below `minLiveSuccessRate` (default 0.9) from cross-meeting
memory, returning those requests to the full dance.

**`LearningLoop`** — the cron bootstrap that operates the loop
(`scripts/learning-cron.ts`, opt-in via `LEARNING_ENABLED`, interval via
`LEARNING_INTERVAL_MS`, default 15 min). One tick runs extract → scan →
feedback → library refresh; every stage is individually failure-tolerant
(errors are collected, the tick never throws), a reentrancy guard stops slow
extractions from overlapping, and `start()` is idempotent. The loop owns the
**durable** `EpisodicMemory` (`var/memory/procedures.json`) and its
`library` is what the composition root passes to the SupervisorAgent as
`procedures` — so procedures and retirements survive restarts.

### 7.2 SafetyNet-bounded invariants

As drafted, all holds: SafetyNet in code; caps in code; PromotionGate in code;
regression suite required per promotion; **`LEARNING_ENABLED` defaults to false**
(absent = unwired, consistent with the config module's empty-env contract);
PromotionGate cannot be promoted around.

## 8. Event spine — `DecisionEventLog`

As drafted (§8 union), with these as-built notes: all events carry
`correlationId/ts/layer/source`; `tool: ToolName` binds the **real** union;
`approval_granted.signerRole` is `string` (roles are gate-level, not the legacy
`SpeakerRole` type); helpers `isDecisionEvent()` and
`DecisionEventOf<K>` exist for narrowing. The `understanding` event's
`contextBundleRef` doubles as the classification-path marker (`via:llm`,
`via:unwired`, `via:parse_error`, `via:schema_invalid`).

## 9. Repo file layout (as built)

```
policies/
├── default.yaml                     # shipped defaults; parity-tested
└── eval/
    ├── scenarios.yaml               # 8 eval scenarios
    └── safety_net_regression.yaml   # 3 must-veto scenarios

src/
├── event-log/        # log.ts (JSONL impl), types.ts (union), correlation.ts
├── understanding/    # intent-classifier, context-assembler,
│   ├── legacy/classifier-adapter.ts
│   ├── memory/       # episodic, kv, vector, file-backed, embedders/hash
│   └── knowledge/    # chunker, bm25, knowledge-base (hybrid RAG), retrieval-eval
├── governance/       # decision, policy-engine, policy-store, approval-gate,
│   └── safety-net/   # rbac, injection, loop-detector, cost-cap, output-filters
├── execution/        # supervisor, tool-runner, verifier, procedure-library,
│   ├── agents/       # base, triage, investigator, executor, reviewer
│   └── tools/        # schemas, registry, jira, logs, runbook, slack, memory
├── learning/         # outcome-recorder, suggestion-queue, eval-runner,
│                     # promotion-gate, knowledge-extractor, efficacy-tracker,
│                     # learning-loop
├── surface/          # async/{jira-webhook, slack-mention, cron},
│                     # proactive/anomaly-detector
├── pipeline/         # agent-pipeline.ts (OrchestratedPipeline)
├── http/             # server.ts — HTTP surface (utterances, approvals, Slack events)
├── bootstrap.ts      # createPlatform — the production composition root
├── support-voice-agent/   # UNCHANGED legacy agent + bridge + integrations (+ slack-bot.ts)
├── fixtures/         # pre-existing test fixtures (legacy)
├── index.ts          # pre-existing legacy export surface
├── config.ts         # + learningEnabledFromEnv (LEARNING_ENABLED, default off)
└── env.ts

scripts/              # eval.ts, check-sqlite.ts, learning-cron.ts, serve.ts (console + optional HTTP host)
.githooks/pre-push        # blocks pushes of regressed policy bundles (see §16)
.github/workflows/ci.yml  # CI: typecheck + tests + eval, Node 22/24 (see §16)
tests/                # 67 files, 519 tests (original 150 = regression floor)
var/                  # runtime data (gitignored): events/, outcomes/
```

Not built from the drafted layout: `src/llm/`, top-level `src/integrations/`,
`src/surface/meeting/*` (bridge stays put), `policies/{security,meeting}.yaml`,
`embedders/openai.ts`, `demo/scripted/*`.

## 10. Cross-cutting concerns

As drafted, plus: Zod at every boundary (envelope, tool args, policy rules,
scenarios, suggestions, promotion inputs); honest-degradation doctrine
everywhere (unwired = configured condition; invalid output = fallback;
transport failure = propagate, except at pipeline edges where legacy takes
over — §15). Not built: CI eval wiring; the hardcoded-value grep test.

## 11. Phasing (completed)

1. Event spine (14 tests) ✅  2. Understanding (29) ✅  3. Governance (45) ✅
4. Execution (42) ✅  5. Learning + surfaces (33) ✅  — plus the wiring phase
(10) ✅ and the enforcement phase (eval CLI + CI workflow + pre-push hook +
learned-procedure short-circuit + efficacy feedback + learning cron
bootstrap + production composition root (createPlatform/serve), 53 new
tests) ✅. Every
phase ended typecheck-clean with the full suite green.

## 12. Open questions (unchanged in substance)

1. Eval-suite size before enabling online promotion (8 shipped; 50+ recommended pre-enable).
2. Cross-meeting memory persistence: **resolved for procedures** —
   `EpisodicMemory({ crossPath })` persists via `FileBackedVectorMemory`
   (JSON snapshot under the deployment's data dir). Larger-scale vector
   stores (Postgres/pgvector) remain future work behind the same port.
3. Multi-tenant policy: deferred (non-goal).
4. Non-OpenAI-compatible LLM adapters: `LlmClient` port ready; none shipped.

## 13. Success criteria — verified

- Typecheck clean; **510/510 tests** (150-test regression floor intact). ✅
- Zero hardcoded hosts/tokens/keys in `src/`. ✅ (by convention; grep test not built)
- Every tool call requires a `GovernedAction`; SafetyNet re-checks every call; vetoes beat allow-all policy (tested). ✅
- Promotion requires M-of-N + candidate eval + SafetyNet regression (tested, including a refused regression-causing patch). ✅
- `policies/default.yaml` reproduces today's guard behavior (parity suite). ✅
- Learning off by default (tested). ✅
- Full-trail correlation: one utterance → `understanding` → `governance` → `tool_call` → `agent_outcome` under one correlationId, outcome persisted (tested). ✅
- Legacy fallback under pipeline failure (tested). ✅

## 14. Appendix — event reference

See `src/event-log/types.ts` for the authoritative union; §8 for notes.

## 15. The wiring: composition over replacement (the big one)

The draft said `processUtterance` would be **deleted**. Built instead:
`OrchestratedPipeline` (`src/pipeline/agent-pipeline.ts`) **owns** an untouched
`SupportVoiceAgent` and routes by classified intent:

- **Etiquette intents** (`mute`, `wake`, `critical`, `complaint`, `feedback`) and
  **unknown chatter** → straight into the legacy cascade. The pipeline never
  duplicates mute/wake/confirmation state machines; it asks the agent.
- **Content intents** (`question`, `runbook_offer`) → Understanding → Governance
  → Execution under one correlationId. Runbook offers resolve against the real
  provider catalog; the provider's `destructive` flag (additively carried as
  `entities.runbookDestructive`) — not text guessing — drives the approval
  policy. Granted approvals execute via `executeApproved` after M-of-N.
- **Any pipeline failure** (LLM transport, store, gate) → the utterance is
  re-dispatched into the legacy cascade. The meeting never hangs on the platform.
- **Webhook/proactive envelopes** enter via `processEnvelope` with the same
  governance; P0/P1 anomalies speak through the agent's urgent barge-in.

The legacy agent therefore remains: the etiquette engine, the deterministic
floor, and the blast radius limiter. This is the system's most important
property and the draft's biggest miss.

## 16. Policy enforcement ladder (added after the as-built revision)

Policy behavior is gated at three stages, all running the same scenarios:

1. **Local, every push** — `.githooks/pre-push` (activated via `core.hooksPath`
   + the npm `prepare` script) runs the eval CLI against the **committed**
   `policies/default.yaml` of every pushed ref that touches `policies/` —
   never the dirty worktree — and blocks the push on failure. Ref deletions
   and non-policy pushes skip; new branches validate their tip;
   `git push --no-verify` remains the manual bypass.
2. **CI, every push/PR** — `.github/workflows/ci.yml` (Node 22 + 24):
   typecheck, full test suite, `npm run eval`. better-sqlite3 is probed right
   after install (`scripts/check-sqlite.ts`); a missing/stale prebuild falls
   back to an in-job source rebuild, which fails the job only if it cannot
   fix the binary.
3. **Promotion time** — the PromotionGate re-runs eval + SafetyNet regression
   against the candidate bundle before any store write (§7.1).

The first two share `scripts/eval.ts` (`npm run eval [--bundle <path>]`):
every eval scenario + every must-veto SafetyNet regression scenario, exit 1
on any failure, malformed scenario files fail loud. A regressed committed
bundle now fails on the developer's machine before review — not in CI, and
not as the base of a PromotionGate promotion.
