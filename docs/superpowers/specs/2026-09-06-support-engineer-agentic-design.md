# Support Engineer — Agentic Orchestration Design

**Status:** Draft for user review
**Date:** 2026-09-06
**Repo:** `support_engineer` (Freebuff Desktop / Support Voice Agent)
**Scope:** Replace the deterministic etiquette brain with a four-layer agentic orchestration; port the good parts forward.

---

## 1. Context and motivation

The current repo (`src/support-voice-agent/`) is a *meeting etiquette state machine with optional LLM co-pilot*. It is well-architected — strict port-based layering, no hardcoded config, honest degradation, hard-gated guardrails — but it is not a **fully agentic system**.

The user has approved a four-layer model:

1. **Understanding** (learned, memory-driven)
2. **Governance** (declared, policy-driven)
3. **Execution** (adaptive, tool-driven)
4. **Learning** (self-improving, outcome-driven, **online with human gates, bounded by guardrails**)

The new system is a **full support engineer platform**: live meeting participation, async/on-call work (ticket triage, runbook execution without a meeting, on-call rotations, incident response), and proactive discovery.

The Learning layer is **online, with human-gated promotion, and bounded by the SafetyNet**. SafetyNet checks live in code, not policy; code changes go through normal PR review, never through the Learning promotion gate.

The multi-agent shape lives **inside the Execution layer** (Triage / Investigator / Executor / Reviewer), supervised by a single SupervisorAgent.

---

## 2. Non-goals

- This is **not** an LLM framework. We do not build a generic agent SDK. The agent's domain is support engineering.
- We do **not** add a new vector DB or a new policy language. We use existing primitives (Zod for schema, JSON Schema for tool definitions, YAML for policies, JSONL for the event log).
- We do **not** rewrite integrations. Jira/Logs/Runbook/Slack clients move forward unchanged.
- We do **not** make the SafetyNet overridable from policy. SafetyNet is code, not data.
- We do **not** ship v1 with multi-tenant policy isolation. Single-tenant is fine.

---

## 3. Top-level architecture

```
┌──────────────────────────────────────────────────────────────┐
│  UNDERSTANDING  (intent + memory, learned)                   │
│  • IntentClassifier (LLM-backed; Zod-validated envelope)     │
│  • EpisodicMemory (vector + KV, per-meeting + cross-meeting) │
│  • ContextAssembler (envelope + episodes + recent decisions) │
└──────────────────────────────────────────────────────────────┘
                              │ IntentEnvelope + ContextBundle
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  GOVERNANCE  (policy-as-data, declared)                      │
│  • PolicyEngine (loads YAML rules; allow/deny/require/       │
│    approval/transform)                                       │
│  • ApprovalGate (human-in-the-loop via Slack; M-of-N)        │
│  • SafetyNet (RBAC, injection, loop detect, cost cap,        │
│    output PII/secrets filters; always-on, code-only)         │
│  • PolicyStore (versioned, signed, diffable; PromotionGate   │
│    is the only writer)                                       │
└──────────────────────────────────────────────────────────────┘
                              │ GovernedAction
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  EXECUTION  (multi-agent, adaptive)                          │
│  • SupervisorAgent (loop, retry, verify, escalate)           │
│  • TriageAgent      (classify, decide urgency)               │
│  • InvestigatorAgent (pull logs, query Jira, gather data)    │
│  • ExecutorAgent    (create tickets, run runbooks, Slack)    │
│  • ReviewerAgent    (verifies outcome; pure critic)          │
│  • ToolRunner (schema-validate → RBAC → rate-limit →         │
│    idempotency → retry → exec → log)                         │
└──────────────────────────────────────────────────────────────┘
                              │ Outcome
                              ▼
┌──────────────────────────────────────────────────────────────┐
│  LEARNING  (online, human-gated, SafetyNet-bounded)          │
│  • OutcomeRecorder (joins events per correlationId)          │
│  • SuggestionQueue (clusters outcomes → PolicySuggestion)    │
│  • PromotionGate (human + eval suite + SafetyNet regression; │
│    only writer to PolicyStore)                               │
│  • KnowledgeExtractor (extracts reusable ProcedureSpecs)     │
└──────────────────────────────────────────────────────────────┘

Event spine (shared): DecisionEventLog (append-only JSONL v1)
Surface modes: meeting | async (webhooks/cron) | proactive (anomaly tick)
```

### 3.1 Surface modes

| Mode | Trigger | Latency budget |
|------|---------|----------------|
| **Live meeting** | STT line from a meeting bridge | Barge-in budget: 1.5s for direct, 3s for tool calls |
| **Async ticket** | Jira webhook, Slack mention, scheduled cron | 5 min default; configurable |
| **Proactive** | Anomaly detector tick (logs, metrics) | 30s default; suppressed unless severity ≥ threshold |

A single trigger always flows: `SourceAdapter → Understanding → Governance → Execution → Learning`.

### 3.2 Event spine

A single append-only `DecisionEvent` log carries every cross-layer event. Every layer emits; only Learning, the Supervisor's "recent decisions" window, and the SafetyNet audit replay read from it. v1 stores JSONL files segmented daily under `./var/events/`. Same `EventLog` interface; pluggable to Postgres/Kafka later.

---

## 4. Layer 1 — Understanding (intent + memory)

### 4.1 Components

**`IntentClassifier`** — LLM-backed classifier producing a structured `IntentEnvelope`:

```ts
type IntentEnvelope = {
  intent:
    | { kind: 'meeting_response';  subKind: 'question' | 'feedback' | 'runbook_offer' | 'complaint' | 'critical' | 'mute' | 'wake' }
    | { kind: 'async_triage';      subKind: 'incident' | 'service_request' | 'question' | 'fyi' }
    | { kind: 'proactive_alert';   subKind: 'incident' | 'anomaly' | 'slo_breach' }
    | { kind: 'human_action';      subKind: 'approval' | 'rejection' | 'edit' | 'answer' }
    | { kind: 'unknown' };
  confidence: number;             // 0..1
  entities: {
    ticketKeys?: string[];
    runbookIds?: string[];
    services?: string[];
    severity?: Severity;
    speakerId?: string;
  };
  rawContext: { source: 'meeting' | 'jira' | 'slack' | 'cloudwatch' | 'splunk' | 'cron'; ts: number; payload: unknown };
};
```

- Output is JSON mode + Zod-validated at the LLM boundary. Failed parse → `LegacyClassifierAdapter` (today's regex heuristics) as fallback.
- This is **two-path by design**: LLM is the ceiling, deterministic heuristics is the floor. With zero LLM config, the system still works.

**`EpisodicMemory`** — two stores behind one interface:

- **Per-meeting** episodes: vector-indexed, TTL-bounded (default 30 days), keyed by meetingId. Holds utterances, alerts, decisions, outcomes.
- **Cross-meeting** knowledge: persistent vector store, no TTL. Holds `ProcedureSpec`s extracted by `KnowledgeExtractor`.

Embeddings: today's `hashEmbedder` is the local default; real cloud embedder is a swappable `Embedder` (same port).

**`ContextAssembler`** — builds the LLM prompt from:

1. `IntentEnvelope`
2. Retrieved episodes (`episodic.search(intent, topK=5, minScore=0.3)`)
3. Recent decisions (sliding window from `DecisionEvent` log)
4. Policy summary

Output: `ContextBundle`, the single thing Execution's sub-agents consume.

### 4.2 Boundary discipline

Understanding produces `IntentEnvelope` + `ContextBundle`. **It does not call tools and does not decide policy** — only describes what was understood. A bug in the classifier can never directly cause a Jira write.

### 4.3 Boundary with the current repo

- Today's `heuristics.ts` → `src/understanding/legacy/classifier-adapter.ts`.
- Today's `InMemoryVectorMemory` / `InMemoryKeyValueStore` → `src/understanding/memory/`.

---

## 5. Layer 2 — Governance (policy-as-data)

### 5.1 Components

**`PolicyEngine`** — loads rules from a **versioned policy bundle** (default path: `./policies/*.yaml`, overridable via `POLICY_PATH`). Rules are *data*, not code.

Rule shape (YAML):

```yaml
- id: destructive_runbook_requires_admin_approval
  when:
    intent.kind: meeting_response
    intent.subKind: runbook_offer
    entities.runbookIds.exists: true
    runbook.destructive: true
  effect: require_approval
  approver_role: admin
  approver_count: 2
  timeout_seconds: 300
  on_timeout: deny

- id: p1_alert_auto_incident_in_jira
  when:
    intent.kind: proactive_alert
    entities.severity: [P0, P1]
  effect: allow
  tools: [jira.createIssue, slack.postMessage]
  constraints:
    jira.issueType: Incident
    jira.priority_max: P1

- id: never_emit_credit_card_data
  when: { any_output.matches_regex: '\b(?:\d[ -]*?){13,19}\b' }
  effect: deny
  reason: 'PII guard'
```

Engine exposes one method:

```ts
evaluate(envelope: IntentEnvelope, proposedAction: ProposedAction): Decision;
```

Effects: `allow | deny | require_approval | transform`. Every evaluation emits a `DecisionEvent`.

**`ApprovalGate`** — for `require_approval` decisions:

- Posts a Slack message to the configured approver channel with Block Kit `✅ Approve` / `❌ Deny` buttons.
- Slash fallback: `/approve <policyId>` / `/deny <policyId>`.
- Tracks approvals as signatures against the policy's `approver_count`. M-of-N required.
- On timeout: `deny`, emits `ApprovalTimeoutEvent`.

Approvers are RBAC-resolved through the SafetyNet speaker registry (today's `Guardrails.roleOf` — moves to `governance/safety-net/rbac.ts`).

**`SafetyNet`** — always-on, cannot be disabled by policy. This is the floor below which the agent will not go, no matter what Learning promotes.

Owns:
- RBAC (port from today's `Guardrails`).
- Prompt-injection detection (port from today's `isPromptInjection`).
- **Loop detector** — per-request tool-call graph; flags repeated identical calls (`> 3` identical `(tool, args)` tuples) → `deny`.
- **Cost cap** — per-request LLM token ceiling (configurable, default 50k tokens) → `deny`.
- **Output filters** — regex-based PII/secret redaction (credit cards, AWS keys, JWTs, etc.) → `deny` or `transform`.

SafetyNet vetoes **always win** over Policy `allow`. This is enforced in two layers:

- **Type system**: tool handlers take `GovernedAction` (not raw `ProposedAction`) as their first argument, so `ToolRunner` cannot be invoked without a prior Governance evaluation.
- **Runtime**: `ToolRunner` re-invokes `SafetyNet.check()` on every call as a defense-in-depth pass; the check returns an `unconditionalSafetyNetCheck: true` flag in the resulting `Decision` that downstream code is required to honor.

**`PolicyStore`** — local v1: YAML files + SQLite index (`policy_versions`, `policy_promotions`, `audit_trail`). Every bundle has `version`, `sha256`, `authored_by`, `signed_by`, `promoted_at`, `eval_run_id`. PromotionGate is the only writer.

### 5.2 Boundary with Execution

Governance produces:

```ts
type GovernedAction =
  | { kind: 'execute';         action: ProposedAction; decision: Decision }
  | { kind: 'request_approval'; action: ProposedAction; decision: Decision; approvalId: string }
  | { kind: 'deny';             decision: Decision };
```

Execution **cannot** call a tool without `GovernedAction` of kind `execute` or a resolved `request_approval`. Type system enforces this: tool handlers take `GovernedAction` as their first argument.

### 5.3 Boundary with the current repo

- Today's `guardrails.ts` becomes the *minimum* SafetyNet (RBAC + injection + escalation). New SafetyNet adds loop detection, cost caps, output filters.
- Today's `pageSecurity` / `pageInfra` → `SafetyNet` + `ApprovalGate` (same `SlackNotifier` port).
- The hardcoded "destructive requires admin" rule (in old `Guardrails.checkDestructive`) becomes the **default policy** in `policies/default.yaml`. Old repo's behavior is the shipped default bundle.

---

## 6. Layer 3 — Execution (multi-agent)

### 6.1 Components

**`SupervisorAgent`** — entry point for every `GovernedAction` of kind `execute`. Owns the *agent loop*:

- Pick a sub-agent, hand it the action, watch for `verify` signals, decide continue / retry / escalate / hand off.
- **Hard caps at supervisor level:**
  - `maxSubAgentHopsPerRequest` (default 8)
  - `maxTotalTokensPerRequest` (SafetyNet also enforces)
  - `maxWallClockMsPerRequest` (default 60s for live meeting, 5min for async)
  - **Loop detection at supervisor level**: same `(tool, args)` tuple called >3 times → SafetyNet veto, hard stop.
- Supervisor never calls tools directly. Only orchestrates sub-agents. This is the architectural fix for the "the brain knows too much" smell in the current `agent.ts`.

**Sub-agents** (each is a focused `LlmAgent` with its own system prompt, tool whitelist, verifier):

| Agent | Purpose | Tools | Verifier |
|-------|---------|-------|----------|
| **TriageAgent** | First hop. Classify, decide urgency, decide if investigation needed. | `intent.refine`, `memory.search` | ReviewerAgent checks "is this an incident or noise?" |
| **InvestigatorAgent** | Gather data. Read-only. | `jira.getIssue`, `logs.query`, `memory.search`, `runbook.describe` | ReviewerAgent checks "did we actually get data?" |
| **ExecutorAgent** | Side-effects. | `jira.createIssue`, `jira.transition`, `jira.addComment`, `runbook.execute`, `slack.postMessage` | ReviewerAgent checks "did the side-effect land?" |
| **ReviewerAgent** | Reads the sub-agent's tool-call trace + outputs, returns `pass` / `fail` / `reask`. No tools. Pure critic. | (none) | n/a |

Why these four: Triage/Investigate/Execute is standard incident response shape; Reviewer-as-critic is the cheapest way to catch hallucinated tool calls before they become wrong Jira tickets.

**`ToolRunner`** (shared, single instance) — every tool call goes through this pipeline:

1. **Schema validate args** against `ToolSchema.parameters` (Zod) — fixes today's `JSON.parse` with no validation.
2. **RBAC check** (SafetyNet) — speakerId/role against tool's required role.
3. **Rate-limit check** — per-tool QPS (default 5/s destructive, 20/s read-only).
4. **Idempotency** — every mutating tool takes `idempotencyKey`; dedupes against 5-min TTL store.
5. **Retry with exponential backoff** — `5xx` / network errors only; max 3 attempts; respects `Retry-After`.
6. **Timeout** — per-tool configurable; default 30s.
7. **Execute** through the existing integration port (Jira, Splunk, CloudWatch, Runbook, Slack).
8. **Emit `ToolCallEvent`** (start + end) with: tool name, args, result, latency, attempt count, correlationId.

Returns `ToolResult` — never throws across the boundary.

**`Verifier`** — `ReviewerAgent` (LLM critic) + lightweight non-LLM checks:

- `jira.createIssue` must return a key matching `^[A-Z][A-Z0-9_]+-\d+$`.
- `slack.postMessage` must return `ok: true`.
- `runbook.execute` must report `ok: true`.

On `fail` → Supervisor retries with Reviewer's feedback appended to next prompt. After `maxRetries` (default 2) → escalate to human via `ApprovalGate` with reason `"executor failed verification N times"`.

### 6.2 Boundary with the current repo

- Today's `tools/handlers.ts` → `ToolRunner`.
- Today's `tools/orchestrator.ts` → `SupervisorAgent`. `maxRounds` and `fallbackToDeterministic` semantics carry over (now means "fall back to deterministic Triage heuristic").
- Today's `processUtterance` is **deleted**; the bridge hands a `TranscriptLine` to `SourceAdapter.meeting()`, which flows through Understanding → Governance → Execution.

### 6.3 Cross-cutting in Execution

- **Cancellation**: every agent's `abort()` cancels in-flight tool calls and LLM streams. Required for live-meeting barge-in.
- **Concurrency**: tool calls inside one sub-agent are parallel (`Promise.all`); sub-agents run sequentially.
- **Determinism in tests**: every LLM call goes through injectable `request: typeof fetch`; optional `LlmStub` for fixture-based tests.

---

## 7. Layer 4 — Learning (online, human-gated, SafetyNet-bounded)

### 7.1 Components

**`OutcomeRecorder`** — subscribes to `agent_outcome` + `approval_*` + `tool_call` events. Joins them by `correlationId` into `OutcomeRecord`:

```ts
type OutcomeRecord = {
  correlationId: string;
  intent: IntentEnvelope;
  decisions: Decision[];
  toolCalls: ToolCallEvent[];
  finalResult: { ok: boolean; summary: string };
  userFeedback?: 'thumbs_up' | 'thumbs_down' | 'edit';
  implicitFeedback?: { wasOverridden: boolean; wasApproved: boolean; retries: number };
  wallClockMs: number;
  tokens: { prompt: number; completion: number };
  ts: number;
};
```

Persisted to `./var/outcomes/<correlationId>.json`.

**`SuggestionQueue`** — background job (cron or on-append trigger) that mines `OutcomeRecord`s and emits `PolicySuggestion`s:

```ts
type PolicySuggestion = {
  id: string;
  rationale: string;
  evidence: { outcomeIds: string[]; sampleSize: number; confidence: number };
  proposedChange:
    | { type: 'add_rule'; rule: PolicyRule }
    | { type: 'modify_rule'; ruleId: string; patch: PolicyPatch }
    | { type: 'tighten_safety_net'; check: SafetyNetCheck }
    | { type: 'add_procedure'; procedure: ProcedureSpec };
  risk: 'low' | 'medium' | 'high';
  estimatedImpact: { outcomeMetric: string; expectedDelta: string };
};
```

Suggestions go into a queue, **not** into the live `PolicyStore`. They are proposals, not changes.

**`PromotionGate`** — the **only** writer to `PolicyStore`. Workflow:

1. Human opens the Suggestion Queue UI (CLI / Slack thread for v1).
2. For each suggestion: **approve**, **reject**, **edit**, or **defer**.
3. On approve:
   - Run **eval suite** (`./tests/eval/scenarios.yaml`) against sandboxed current + proposed policy.
   - Run **SafetyNet regression suite** (SafetyNet must still veto the same things it vetoed before).
   - Require `approver_count: 2` from humans with `policy_admin` role.
   - On pass: write new versioned policy bundle to `PolicyStore`, emit `PolicyPromotedEvent`, hot-reload `PolicyEngine`.

Promotion **cannot be silent**. `PolicyPromotedEvent` is auditable forever.

**`KnowledgeExtractor`** — separate, **offline by default** (nightly). Mines `OutcomeRecord`s for **procedures**:

```ts
type ProcedureSpec = {
  id: string;
  trigger: IntentMatch;
  steps: Array<{ agent: 'triage' | 'investigator' | 'executor'; tool?: ToolName; args?: unknown }>;
  successRate: number;
  sampleSize: number;
};
```

Procedures live in cross-meeting episodic memory. The next time a similar intent comes in, the Supervisor can short-circuit by invoking the procedure directly (skipping the multi-agent dance for known-good patterns). This is the **only** form of "online behavior change" Learning does without going through PromotionGate — and it's bounded: procedures only suggest tool sequences that already passed policy once.

### 7.2 SafetyNet-bounded invariants

These are the architectural guarantees that make Learning safe:

- **SafetyNet checks live in code, not policy.** Code changes require a normal PR review (humans, not Learning).
- `maxRoundsPerRequest`, `maxTokensPerRequest`, `maxWallClockMsPerRequest`, the loop detector, the PII output filter are **all in code**.
- The PromotionGate itself is in code. Learning **cannot** promote its own promotion rules.
- The SafetyNet regression suite is required for every promotion.
- v1 ships the Learning layer with the SuggestionQueue + PromotionGate **disabled by default** behind `LEARNING_ENABLED=false`. Operators opt in.

---

## 8. Event spine — `DecisionEventLog`

```ts
interface EventLog {
  append(event: DecisionEvent): Promise<void>;
  query(filter: EventFilter): AsyncIterable<DecisionEvent>;
}

type DecisionEvent = DiscriminatedUnion<{
  understanding:  { envelope: IntentEnvelope; contextBundleRef: string };
  governance:     { intent: IntentEnvelope; decision: Decision };
  safety_net:     { vetoed: boolean; check: string; reason: string };
  approval_request:  { approvalId: string; policyId: string; approver_count: number };
  approval_granted:  { approvalId: string; signerRole: SpeakerRole };
  approval_timeout:  { approvalId: string };
  tool_call:      { tool: ToolName; args: unknown; result: ToolResult; latencyMs: number; attempts: number; correlationId: string };
  agent_outcome:  { correlationId: string; finalResult: { ok: boolean; summary: string } };
  policy_suggested:  { suggestionId: string };
  policy_promoted:   { policyId: string; bundleSha: string; promotedBy: SpeakerRole[] };
  knowledge_extracted: { procedureId: string };
}>;
```

v1: JSONL files segmented daily under `./var/events/`. Pluggable to Postgres/Kafka later via same interface.

---

## 9. Repo file layout

```
support-engineer/
├── policies/                              # policy bundles (data, versioned)
│   ├── default.yaml                       # shipped defaults; preserves today's behavior
│   ├── security.yaml
│   ├── meeting.yaml
│   └── eval/                              # eval scenarios for PromotionGate
│       ├── scenarios.yaml
│       └── safety_net_regression.yaml
├── src/
│   ├── understanding/                     # Layer 1
│   │   ├── intent-classifier.ts
│   │   ├── context-assembler.ts
│   │   ├── legacy/
│   │   │   └── classifier-adapter.ts      # ports today's heuristics.ts
│   │   └── memory/
│   │       ├── episodic.ts                # cross-meeting + per-meeting
│   │       ├── kv.ts                      # ports today's KeyValueStore
│   │       ├── vector.ts                  # ports today's VectorMemory
│   │       └── embedders/
│   │           ├── hash.ts                # ports today's hashEmbedder
│   │           └── openai.ts              # cloud-backed (optional)
│   ├── governance/                        # Layer 2
│   │   ├── policy-engine.ts
│   │   ├── policy-store.ts
│   │   ├── approval-gate.ts
│   │   ├── safety-net/
│   │   │   ├── rbac.ts                    # ports today's Guardrails
│   │   │   ├── injection.ts
│   │   │   ├── loop-detector.ts
│   │   │   ├── cost-cap.ts
│   │   │   └── output-filters.ts          # PII, secrets
│   │   └── decision.ts                    # Decision, GovernedAction types
│   ├── execution/                         # Layer 3
│   │   ├── supervisor.ts
│   │   ├── agents/
│   │   │   ├── triage.ts
│   │   │   ├── investigator.ts
│   │   │   ├── executor.ts
│   │   │   └── reviewer.ts
│   │   ├── tool-runner.ts
│   │   ├── tools/
│   │   │   ├── registry.ts                # tool schemas + handlers
│   │   │   ├── jira.ts
│   │   │   ├── logs.ts
│   │   │   ├── runbook.ts
│   │   │   ├── slack.ts
│   │   │   └── memory.ts                  # tools for EpisodicMemory
│   │   └── verifier.ts
│   ├── learning/                          # Layer 4
│   │   ├── outcome-recorder.ts
│   │   ├── suggestion-queue.ts
│   │   ├── promotion-gate.ts
│   │   ├── knowledge-extractor.ts
│   │   └── eval-runner.ts
│   ├── event-log/                         # shared substrate
│   │   ├── log.ts                         # EventLog interface + JSONL impl
│   │   ├── types.ts                       # DecisionEvent discriminated union
│   │   └── correlation.ts                 # correlationId generator
│   ├── surface/                           # how inputs enter the system
│   │   ├── meeting/
│   │   │   ├── bridge.ts
│   │   │   ├── ports.ts                   # ports today's MeetingBridge
│   │   │   ├── session.ts                 # ports today's createVoiceSession
│   │   │   └── fakes.ts
│   │   ├── async/
│   │   │   ├── jira-webhook.ts
│   │   │   ├── slack-mention.ts
│   │   │   └── cron.ts
│   │   └── proactive/
│   │       └── anomaly-detector.ts
│   ├── llm/                               # the one LLM client, shared
│   │   ├── client.ts                      # ports today's OpenAiCompatibleClient
│   │   ├── error.ts                       # ports today's LlmError
│   │   └── schemas.ts                     # Zod schemas + JSON schema export
│   ├── integrations/                      # ported from today, unchanged
│   │   ├── jira.ts
│   │   ├── logs.ts
│   │   ├── runbook.ts
│   │   └── slack.ts
│   ├── config.ts                          # ported from today, expanded
│   ├── env.ts                             # ported from today
│   └── index.ts                           # public surface
├── tests/
│   ├── unit/
│   ├── eval/
│   └── e2e/
├── demo/
│   ├── cli.ts
│   └── scripted/
│       ├── meeting.ts
│       ├── async-ticket.ts
│       └── proactive-anomaly.ts
├── var/                                   # runtime data (gitignored)
│   ├── events/
│   ├── outcomes/
│   └── policies/                          # promotion candidates live here
├── docs/
│   └── superpowers/
│       └── specs/
│           └── 2026-09-06-support-engineer-agentic-design.md
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

### 9.1 What survives verbatim

`env.ts`, `integrations/{jira,logs,runbook,slack}.ts`, `JiraClient` / `SplunkProvider` / `CloudWatchProvider` / `InMemoryRunbookProvider` / `SlackWebhookNotifier`, the typed emitter, the demo CLI shape, `tsconfig.json`, `vitest.config.ts`. The 150 existing tests remain as a **regression floor**.

### 9.2 What's deleted

- `processUtterance` (replaced by Understanding + Governance + Execution).
- `tools/handlers.ts` switch (replaced by `ToolRunner` + per-tool files).
- LLM `maxRounds` as the only iteration cap (replaced by supervisor-level caps + loop detector).
- Hardcoded destructive-action check in `Guardrails` (replaced by `policies/default.yaml`).
- Bare regex classifier as the *primary* path (now `LegacyClassifierAdapter`, only on LLM failure).

---

## 10. Cross-cutting concerns

- **TypeScript**: strict, `noUncheckedIndexedAccess`, `noImplicitOverride`, `isolatedModules`. Banned-types lint: `any`, `unknown` only with documented reason.
- **Telemetry**: every LLM call logs prompt/response/tokens/model/latency/correlationId. `DecisionEvent` log is the single audit substrate.
- **Schema validation at the boundary**: Zod-validated `IntentEnvelope`, Zod-validated tool args, Zod-validated policy rules on load.
- **No hardcoded values**: every host, token, project key, channel, threshold, policy path, eval path comes from config. Default policy bundle is data, not code.
- **Eval as a first-class artifact**: `policies/eval/scenarios.yaml` required before any policy promotion. PromotionGate runs them; CI runs them on every PR.
- **Backward compatibility**: v1 ships with the **deterministic legacy path as the default** (no LLM required to start). The agentic layers activate as integrations and config land.

---

## 11. Phasing and migration

The implementation is broken into five independent plans, each ending in a green test + a working demo:

1. **Event spine + DecisionEventLog** — substrate, no behavior change.
2. **Understanding layer** — `IntentClassifier` + `EpisodicMemory` + `LegacyClassifierAdapter` fallback. Replaces `processUtterance`'s classification step.
3. **Governance layer** — `PolicyEngine` + `SafetyNet` + `ApprovalGate` + `policies/default.yaml`. Every existing deterministic action now passes through policy.
4. **Execution layer (multi-agent)** — `SupervisorAgent` + 4 sub-agents + `ToolRunner`. Replaces `tools/orchestrator.ts` + `tools/handlers.ts`.
5. **Learning layer + Surface modes** — `OutcomeRecorder` + `SuggestionQueue` + `PromotionGate` + `KnowledgeExtractor`. New async + proactive surfaces.

Each plan is gated by the existing 150-test regression floor + a new eval scenario suite.

---

## 12. Open questions

1. **Eval suite scope for v1**: how many scenarios in `policies/eval/scenarios.yaml` before Learning can ship? (Recommend: 50+ before any online promotion, 200+ before `LEARNING_ENABLED=true` default.)
2. **Cross-meeting memory persistence**: local JSONL v1, Postgres when? (Recommend: when `var/outcomes/` exceeds 10k records or 1GB, whichever comes first.)
3. **Multi-tenant policy**: deferred per non-goal. Reopen when first enterprise customer asks.
4. **LLM provider beyond OpenAI-compatible**: pluggable via `LlmClient` interface. Anthropic, Bedrock adapters are follow-up work.

---

## 13. Success criteria

- **Typecheck clean**: `npm run typecheck` exits 0 on every plan's PR.
- **All 150 existing tests still pass** at every plan boundary (regression floor).
- **Zero hardcoded hosts/tokens/keys** anywhere in `src/` — enforced by a unit test that greps for common patterns.
- **Every consequential action passes through Governance** — enforced by a test that intercepts the tool-call stream and asserts no tool runs without a `GovernedAction`.
- **Every LLM call logged** with prompt/response/tokens/latency — enforced by a test that fails any LLM call without a logged event.
- **SafetyNet cannot be disabled by policy** — enforced by a test that loads `policies/disable-safety-net.yaml` and asserts the SafetyNet still vetoes.
- **Promotion requires M-of-N human approval + eval + SafetyNet regression** — enforced by tests against `PromotionGate`.
- **Default bundle (`policies/default.yaml`) reproduces today's behavior byte-for-byte** for the 150 existing test scenarios.

---

## 14. Appendix — DecisionEvent type reference

See section 8 for the full discriminated union. All events carry `correlationId` (string), `ts` (epoch ms), `layer` (one of `understanding | governance | execution | learning | surface`), and `source` (`meeting | jira | slack | cloudwatch | splunk | cron | internal`).
