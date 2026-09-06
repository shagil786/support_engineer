# Support Engineer — Agentic Orchestration Design

**Status:** Implemented (v1) — this document describes the system **as built**
**Date:** 2026-09-06 (revised after implementation)
**Repo:** `support_engineer` (Freebuff Desktop / Support Voice Agent)
**Suite at time of writing:** typecheck clean, **323/323 tests green** across 42 files (the original 150 remain as the regression floor)

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
- **Phase 5 (Learning + surfaces)** — `OutcomeRecord` is lean: `correlationId`, `toolCalls`, `finalResult?`, `approvals[]`, `ts` (no intent/feedback/token fields in v1). `SuggestionQueue` v1 = one threshold heuristic (destructive approvals → propose relaxing `approver_count`, **risk: high**). `PromotionGate` evaluates the **candidate** bundle (better than the draft's "current + proposed": a regression-causing patch is refused before it lands) and refuses `tighten_safety_net`/`add_procedure` suggestions outright. `ProcedureSpec.trigger` is the tool-sequence string, not an `IntentMatch`; **procedures are stored but not yet short-circuited on** (§7.1's "skip the multi-agent dance" is future work). `LEARNING_ENABLED` env flag, default off, absent = unwired. Suggestion review is API-only — no CLI/Slack UI yet.

### 0.3 Promised but not built in v1

Eval-in-CI wiring; the "no hardcoded values" grep test; `PolicyEngine` hot-reload
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
│  • SupervisorAgent (caps: hops/tokens/wall-clock/loop)       │
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
└──────────────────────────────────────────────────────────────┘

Wiring (src/pipeline/): OrchestratedPipeline owns the legacy agent and routes
per §15. Event spine (src/event-log/): append-only JSONL under var/events/.
Surfaces (src/surface/): async (jira/slack/cron parsers) + proactive (anomaly).
```

### 3.1 Surface modes

| Mode | Entry point | Status |
|------|-------------|--------|
| **Live meeting** | `OrchestratedPipeline.processUtterance` → classifier → route (§15); bridge/STT unchanged | Implemented |
| **Async ticket** | `parseJiraWebhook` / `parseSlackMention` / `buildCronEnvelope` → `processEnvelope` | Parsers implemented; HTTP listeners are host responsibility |
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
Local `hashEmbedder` default; `Embedder` port for swaps.

**`ContextAssembler`** → `ContextBundle { envelope, episodes, recent }` from the
envelope, top-K recall (`topK=5, minScore=0.3` default), and a recent-decision
window. *No policy summary component in v1.*

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
correlationId). Emits `agent_outcome` (summary + hops + toolCalls). Deny and
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
cross-meeting episodic memory. *Procedures are stored but not yet used to
short-circuit execution — future work.*

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
│   └── memory/       # episodic, kv, vector, embedders/hash
├── governance/       # decision, policy-engine, policy-store, approval-gate,
│   └── safety-net/   # rbac, injection, loop-detector, cost-cap, output-filters
├── execution/        # supervisor, tool-runner, verifier,
│   ├── agents/       # base, triage, investigator, executor, reviewer
│   └── tools/        # schemas, registry, jira, logs, runbook, slack, memory
├── learning/         # outcome-recorder, suggestion-queue, eval-runner,
│                     # promotion-gate, knowledge-extractor
├── surface/          # async/{jira-webhook, slack-mention, cron},
│                     # proactive/anomaly-detector
├── pipeline/         # agent-pipeline.ts (OrchestratedPipeline)
├── support-voice-agent/   # UNCHANGED legacy agent + bridge + integrations
├── fixtures/         # pre-existing test fixtures (legacy)
├── index.ts          # pre-existing legacy export surface
├── config.ts         # + learningEnabledFromEnv (LEARNING_ENABLED, default off)
└── env.ts

tests/                # 42 files, 323 tests (original 150 = regression floor)
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
(10) ✅. Every phase ended typecheck-clean with the full suite green.

## 12. Open questions (unchanged in substance)

1. Eval-suite size before enabling online promotion (8 shipped; 50+ recommended pre-enable).
2. Cross-meeting memory persistence beyond in-memory + JSONL outcomes.
3. Multi-tenant policy: deferred (non-goal).
4. Non-OpenAI-compatible LLM adapters: `LlmClient` port ready; none shipped.

## 13. Success criteria — verified

- Typecheck clean; **323/323 tests** (150-test regression floor intact). ✅
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
