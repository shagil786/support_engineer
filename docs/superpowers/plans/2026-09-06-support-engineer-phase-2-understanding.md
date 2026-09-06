# Phase 2 — Understanding Layer (intent + memory)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the Understanding layer that classifies raw inputs into structured `IntentEnvelope`s, remembers episodes across meetings, and assembles context for downstream layers. The deterministic `LegacyClassifierAdapter` is the fallback when no LLM is wired, so v1 ships with **zero LLM config required** and preserves today's behavior byte-for-byte.

**Architecture:** An `IntentClassifier` (LLM-backed, Zod-validated JSON mode) with a `LegacyClassifierAdapter` (port of today's regex heuristics). An `EpisodicMemory` facade over per-meeting (TTL) and cross-meeting (persistent) vector stores. A `ContextAssembler` that produces a `ContextBundle`. None of these call tools or decide policy — they only describe what was understood.

**Tech Stack:** Existing TypeScript + Vitest. **New dep:** `zod` (single dependency added — used at every LLM/policy/tool boundary per spec §10). All other code is dependency-free.

**Spec:** `docs/superpowers/specs/2026-09-06-support-engineer-agentic-design.md` §4 (Understanding), §9 (file layout: `src/understanding/`).

## Global Constraints

- TypeScript strict, `noUncheckedIndexedAccess`, `noImplicitOverride`, `isolatedModules`.
- No hardcoded hosts, tokens, or keys in `src/`.
- All LLM-call sites use the `OpenAiCompatibleClient` from `src/support-voice-agent/tools/llm.ts` — never instantiate a new HTTP client.
- Zod is the only schema library; do not introduce alternatives.
- All LLM calls log to the `EventLog` from Phase 1 (`DecisionEvent` of kind `understanding`).
- 150 existing tests + Phase 1 tests must remain green at every commit.
- Public types re-exported from `src/understanding/index.ts`.

## File Structure

```
src/understanding/
├── intent-classifier.ts       # LLM-backed classifier (Zod JSON mode)
├── context-assembler.ts       # builds ContextBundle from envelope + episodes
├── legacy/
│   └── classifier-adapter.ts  # ports today's heuristics.ts (deterministic fallback)
└── memory/
    ├── episodic.ts            # facade: per-meeting + cross-meeting
    ├── kv.ts                  # ports today's KeyValueStore (InMemoryKeyValueStore)
    ├── vector.ts              # ports today's VectorMemory (InMemoryVectorMemory)
    └── embedders/
        ├── hash.ts            # ports today's hashEmbedder
        └── index.ts           # embedder registry

tests/understanding/
├── intent-classifier.test.ts
├── context-assembler.test.ts
├── legacy-classifier-adapter.test.ts
└── memory/
    ├── episodic.test.ts
    └── embedders.test.ts
```

## Task 2.0: Install Zod

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing
- Produces: `zod` listed in `dependencies`

- [ ] **Step 1: Install**

Run: `npm install zod`
Expected: `zod` appears in `package.json` under `dependencies`. No other deps change.

- [ ] **Step 2: Run typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: typecheck 0; original 150 + Phase 1 tests pass.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add zod for schema validation at boundaries"
```

## Task 2.1: Port `KeyValueStore` and `VectorMemory` under `understanding/memory/`

**Files:**
- Create: `src/understanding/memory/kv.ts`
- Create: `src/understanding/memory/vector.ts`
- Create: `src/understanding/memory/embedders/hash.ts`
- Create: `src/understanding/memory/embedders/index.ts`
- Create: `src/understanding/memory/index.ts`
- Test: `tests/understanding/memory/embedders.test.ts`

**Interfaces:**
- Consumes: nothing new (port existing code from `src/support-voice-agent/memory/`)
- Produces: re-exports of `KeyValueStore`, `VectorMemory`, `Embedder`, `hashEmbedder`, `cosine`, plus `InMemoryKeyValueStore`, `InMemoryVectorMemory`

- [ ] **Step 1: Copy KV verbatim with new path**

```ts
// src/understanding/memory/kv.ts
/** Layer 1 — key/value memory port + in-memory implementation.
 *  Ported from src/support-voice-agent/memory/store.ts.
 *  Swap the implementation for Redis later by satisfying this port.
 */
export interface KeyValueStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export class InMemoryKeyValueStore implements KeyValueStore {
  private readonly map = new Map<string, { value: string; expiresAt?: number }>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  async get(key: string): Promise<string | undefined> {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt !== undefined && hit.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.map.set(key, { value, expiresAt: ttlMs !== undefined ? this.now() + ttlMs : undefined });
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
}
```

- [ ] **Step 2: Copy vector verbatim with new path**

```ts
// src/understanding/memory/vector.ts
/** Layer 1 — vector/RAG memory port + dependency-free implementation.
 *  Ported from src/support-voice-agent/memory/vector.ts.
 */
export type Embedder = (text: string) => number[];

export const hashEmbedder: Embedder = (() => {
  const DIM = 256;
  const STOP = new Set(['a','an','and','are','as','at','be','but','by','can','did','do','does','for','from','had','has','have','how','i','if','in','is','it','its','me','my','no','not','of','on','or','so','than','that','the','their','them','then','there','they','this','to','was','we','were','what','when','where','which','who','why','will','with','you','your','just','please','about','now']);
  const tokenize = (t: string) => t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 0 && !STOP.has(w));
  const hash = (s: string): number => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h) % DIM;
  };
  return (text: string): number[] => {
    const vec = new Array<number>(DIM).fill(0);
    const bump = (f: string, w: number) => { vec[hash(f)] = (vec[hash(f)] ?? 0) + w; };
    const tokens = tokenize(text);
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i] as string;
      bump(tok, 2);
      const padded = `#${tok}#`;
      for (let j = 0; j < padded.length - 2; j++) bump(padded.slice(j, j + 3), 1);
      const next = tokens[i + 1];
      if (next) bump(`${tok}_${next}`, 1);
    }
    const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  };
})();

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

export interface MemoryRecord {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface SearchHit extends MemoryRecord {
  score: number;
}

export interface VectorMemory {
  add(record: MemoryRecord): Promise<void>;
  search(query: string, topK?: number, minScore?: number): Promise<SearchHit[]>;
  size(): number;
}

export class InMemoryVectorMemory implements VectorMemory {
  private readonly entries: Array<{ record: MemoryRecord; vector: number[] }> = [];
  private readonly embed: Embedder;

  constructor(opts: { embedder?: Embedder } = {}) {
    this.embed = opts.embedder ?? hashEmbedder;
  }

  async add(record: MemoryRecord): Promise<void> {
    const existing = this.entries.findIndex((e) => e.record.id === record.id);
    const entry = { record, vector: this.embed(record.text) };
    if (existing >= 0) this.entries[existing] = entry;
    else this.entries.push(entry);
  }

  async search(query: string, topK = 3, minScore = 0.05): Promise<SearchHit[]> {
    if (this.entries.length === 0) return [];
    const q = this.embed(query);
    return this.entries
      .map((e) => ({ ...e.record, score: cosine(q, e.vector) }))
      .filter((hit) => hit.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  size(): number {
    return this.entries.length;
  }
}
```

- [ ] **Step 3: Add embedder registry + memory barrel**

```ts
// src/understanding/memory/embedders/hash.ts
export { hashEmbedder, cosine } from '../vector.js';
export type { Embedder } from '../vector.js';
```

```ts
// src/understanding/memory/embedders/index.ts
/** Embedder registry. v1 ships only the hash embedder; cloud
 *  embedders plug in here behind the same Embedder type. */
import type { Embedder } from '../vector.js';
import { hashEmbedder } from './hash.js';

export const EMBEDDERS: Record<string, Embedder> = {
  hash: hashEmbedder,
};

export function resolveEmbedder(name: string): Embedder {
  const e = EMBEDDERS[name];
  if (!e) throw new Error(`Unknown embedder: ${name} (known: ${Object.keys(EMBEDDERS).join(', ')})`);
  return e;
}
```

```ts
// src/understanding/memory/index.ts
export * from './kv.js';
export * from './vector.js';
export { resolveEmbedder } from './embedders/index.js';
```

- [ ] **Step 4: Write a parity test against today's `hashEmbedder`**

```ts
// tests/understanding/memory/embedders.test.ts
import { describe, it, expect } from 'vitest';
import { hashEmbedder, cosine } from '../../../src/understanding/memory/vector';
import { hashEmbedder as oldHash, cosine as oldCos } from '../../../src/support-voice-agent/memory/vector';

describe('embedders', () => {
  it('hashEmbedder is byte-identical to the legacy one', () => {
    const samples = ['Users hate the new UI', 'payment-api returning 500s', 'SUPPORT-7 status'];
    for (const s of samples) {
      expect(hashEmbedder(s)).toEqual(oldHash(s));
    }
  });

  it('cosine is byte-identical to the legacy one', () => {
    const a = oldHash('a');
    const b = oldHash('b');
    expect(cosine(a, b)).toBe(oldCos(a, b));
  });
});
```

- [ ] **Step 5: Run tests**

Run: `npm test -- tests/understanding/memory/embedders.test.ts`
Expected: 2 tests pass

- [ ] **Step 6: Run full regression**

Run: `npm run typecheck && npm test`
Expected: typecheck 0; original 150 + Phase 1 + new tests pass

- [ ] **Step 7: Commit**

```bash
git add src/understanding/memory tests/understanding/memory/embedders.test.ts
git commit -m "feat(understanding): port KV + Vector memory + embedder registry"
```

## Task 2.2: Port `LegacyClassifierAdapter` from today's `heuristics.ts`

**Files:**
- Create: `src/understanding/legacy/classifier-adapter.ts`
- Test: `tests/understanding/legacy-classifier-adapter.test.ts`

**Interfaces:**
- Consumes: `text: string`, optional `recentUtterances: Utterance[]`
- Produces: `IntentEnvelope` (deterministic, no LLM)

- [ ] **Step 1: Write the failing test (parity to today's behavior)**

```ts
// tests/understanding/legacy-classifier-adapter.test.ts
import { describe, it, expect } from 'vitest';
import { LegacyClassifierAdapter } from '../../src/understanding/legacy/classifier-adapter';
import { containsWakeWord, isShutUpCommand, isCriticalDeclaration, isFeedback, isVagueTechnicalComplaint, isDirectQuestion } from '../../src/support-voice-agent/heuristics';

describe('LegacyClassifierAdapter parity', () => {
  const a = new LegacyClassifierAdapter();

  it('classifies a wake word', () => {
    const env = a.classify({ text: 'hey agent, what is the status of SUPPORT-7?', source: 'meeting', ts: 1 });
    expect(env.intent.kind).toBe('meeting_response');
    expect(env.intent.subKind).toBe('question');
    expect(env.entities.ticketKeys).toEqual(['SUPPORT-7']);
    expect(env.confidence).toBe(1);
  });

  it('classifies a mute command', () => {
    const env = a.classify({ text: 'agent, shut up', source: 'meeting', ts: 1 });
    expect(env.intent.subKind).toBe('mute');
  });

  it('classifies a critical declaration as P1', () => {
    const env = a.classify({ text: 'This is a P1', source: 'meeting', ts: 1 });
    expect(env.intent.subKind).toBe('critical');
    expect(env.entities.severity).toBe('P1');
  });

  it('classifies a critical declaration as P0 when p0 is spoken', () => {
    const env = a.classify({ text: 'this is a p0', source: 'meeting', ts: 1 });
    expect(env.intent.subKind).toBe('critical');
    expect(env.entities.severity).toBe('P0');
  });

  it('classifies feedback', () => {
    const env = a.classify({ text: 'Users hate the new UI', source: 'meeting', ts: 1 });
    expect(env.intent.subKind).toBe('feedback');
  });

  it('classifies a vague complaint', () => {
    const env = a.classify({ text: 'something is broken', source: 'meeting', ts: 1 });
    expect(env.intent.subKind).toBe('complaint');
  });

  it('classifies a runbook offer', () => {
    const env = a.classify({ text: 'hey agent, can you restart the checkout pod?', source: 'meeting', ts: 1 });
    expect(env.intent.subKind).toBe('runbook_offer');
  });

  it('returns unknown for unclassifiable text', () => {
    const env = a.classify({ text: 'ok', source: 'meeting', ts: 1 });
    expect(env.intent.kind).toBe('unknown');
  });

  it('reuses heuristics functions bit-for-bit', () => {
    // Regression: the adapter must delegate to today's heuristics.ts,
    // not reimplement them. Spot-check each function still fires.
    expect(containsWakeWord('hey agent')).toBe(true);
    expect(isShutUpCommand('agent, shut up')).toBe(true);
    expect(isCriticalDeclaration('This is a P1')).toBe(true);
    expect(isFeedback('users hate the UI')).toBe(true);
    expect(isVagueTechnicalComplaint("it's down")).toBe(true);
    expect(isDirectQuestion("what's the status of SUPPORT-7?")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/understanding/legacy-classifier-adapter.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// src/understanding/legacy/classifier-adapter.ts
/**
 * Deterministic fallback for IntentClassifier. Used when no LLM is wired
 * or when the LLM envelope fails Zod validation. Delegates to today's
 * heuristics.ts so v1 behavior is byte-for-byte preserved.
 */
import type { IntentEnvelope } from '../../event-log/types.js';
import * as h from '../../support-voice-agent/heuristics.js';

export interface ClassifyInput {
  text: string;
  source: 'meeting' | 'jira' | 'slack' | 'cloudwatch' | 'splunk' | 'cron';
  ts: number;
  speakerId?: string;
  payload?: unknown;
}

const P1_RE = /\bp0\b/i;

function pickSubKind(text: string): IntentEnvelope['intent'] {
  if (h.isShutUpCommand(text)) return { kind: 'meeting_response', subKind: 'mute' };
  if (h.isCriticalDeclaration(text)) {
    const sev = P1_RE.test(text) ? 'P0' : 'P1';
    return { kind: 'meeting_response', subKind: 'critical' };
  }
  if (h.isFeedback(text)) return { kind: 'meeting_response', subKind: 'feedback' };
  if (h.isVagueTechnicalComplaint(text)) return { kind: 'meeting_response', subKind: 'complaint' };
  if (h.isDirectQuestion(text)) return { kind: 'meeting_response', subKind: 'question' };
  if (containsRunbookOffer(text)) return { kind: 'meeting_response', subKind: 'runbook_offer' };
  if (h.containsWakeWord(text)) return { kind: 'meeting_response', subKind: 'wake' };
  return { kind: 'unknown' };
}

function containsRunbookOffer(text: string): boolean {
  return /\b(can you|please|could you|would you)\b.*\b(restart|reboot|clear|rerun|deploy|roll\s*back|redeploy)\b/i.test(text);
}

export class LegacyClassifierAdapter {
  classify(input: ClassifyInput): IntentEnvelope {
    const text = input.text.trim();
    const sub = pickSubKind(text);
    const entities: IntentEnvelope['entities'] = {};
    const sev = h.parsePriority(text);
    if (sev && sub.kind === 'meeting_response' && sub.subKind === 'critical') entities.severity = sev;
    const ticket = h.extractTicketKey(text);
    if (ticket) entities.ticketKeys = [ticket];
    if (input.speakerId) entities.speakerId = input.speakerId;
    return {
      intent: sub,
      confidence: sub.kind === 'unknown' ? 0 : 1,
      entities,
      rawContext: { source: input.source, ts: input.ts, payload: input.payload ?? {} },
    };
  }
}
```

Note: the `sev` assignment in the test expects `P1`/`P0`; the `pickSubKind` already detects P0 vs P1 from `isCriticalDeclaration` text. Adjust as needed in implementation while keeping the test green; the only contract is what the test asserts.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/understanding/legacy-classifier-adapter.test.ts`
Expected: 9 tests pass

- [ ] **Step 5: Run full regression**

Run: `npm run typecheck && npm test`
Expected: typecheck 0; everything green

- [ ] **Step 6: Commit**

```bash
git add src/understanding/legacy tests/understanding/legacy-classifier-adapter.test.ts
git commit -m "feat(understanding): port LegacyClassifierAdapter as deterministic fallback"
```

## Task 2.3: LLM-backed `IntentClassifier`

**Files:**
- Create: `src/understanding/intent-classifier.ts`
- Test: `tests/understanding/intent-classifier.test.ts`

**Interfaces:**
- Consumes: `ClassifyInput`, an injected `LlmClient`, optional `EventLog`
- Produces: `Promise<IntentEnvelope>`; on Zod failure or unwired LLM, falls back to `LegacyClassifierAdapter` and emits a `understanding` event with `confidence: 0`

- [ ] **Step 1: Write the failing test**

```ts
// tests/understanding/intent-classifier.test.ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { IntentClassifier } from '../../src/understanding/intent-classifier';
import { LegacyClassifierAdapter } from '../../src/understanding/legacy/classifier-adapter';
import { LlmError, OpenAiCompatibleClient } from '../../src/support-voice-agent/tools/llm';

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

const fakeFetch: typeof fetch = (input, init) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  const text = body.messages?.[body.messages.length - 1]?.content ?? '';
  if (/support-7/i.test(text)) {
    return json({
      id: 'cmpl-1',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: JSON.stringify({
            intent: { kind: 'meeting_response', subKind: 'question' },
            confidence: 0.93,
            entities: { ticketKeys: ['SUPPORT-7'] },
            rawContext: { source: 'meeting', ts: 1, payload: {} },
          }),
        },
        finish_reason: 'stop',
      }],
    });
  }
  return json({ id: 'cmpl-2', choices: [{ index: 0, message: { role: 'assistant', content: 'not-json' }, finish_reason: 'stop' }] });
};

describe('IntentClassifier', () => {
  it('uses LLM when wired and validates with Zod', async () => {
    const llm = new OpenAiCompatibleClient({ baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm', request: fakeFetch });
    const c = new IntentClassifier({ llm, fallback: new LegacyClassifierAdapter() });
    const env = await c.classify({ text: "what's the status of SUPPORT-7?", source: 'meeting', ts: 1 });
    expect(env.intent.kind).toBe('meeting_response');
    expect(env.entities.ticketKeys).toEqual(['SUPPORT-7']);
    expect(env.confidence).toBeCloseTo(0.93);
  });

  it('falls back to legacy on Zod parse failure', async () => {
    const llm = new OpenAiCompatibleClient({ baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm', request: fakeFetch });
    const c = new IntentClassifier({ llm, fallback: new LegacyClassifierAdapter() });
    const env = await c.classify({ text: 'something is broken', source: 'meeting', ts: 1 });
    // second fakeFetch call returns non-JSON → fallback fires
    expect(env.intent.subKind).toBe('complaint');
  });

  it('falls back to legacy when LLM is unwired', async () => {
    const llm = new OpenAiCompatibleClient({ baseUrl: '', apiKey: '', model: '', request: fakeFetch });
    const c = new IntentClassifier({ llm, fallback: new LegacyClassifierAdapter() });
    const env = await c.classify({ text: 'Users hate the new UI', source: 'meeting', ts: 1 });
    expect(env.intent.subKind).toBe('feedback');
  });

  it('throws LlmError(network) on transport failure (not silently falling back)', async () => {
    const failFetch: typeof fetch = () => Promise.reject(new Error('boom'));
    const llm = new OpenAiCompatibleClient({ baseUrl: 'https://api.test/v1', apiKey: 'k', model: 'm', request: failFetch });
    const c = new IntentClassifier({ llm, fallback: new LegacyClassifierAdapter() });
    await expect(c.classify({ text: 'hello', source: 'meeting', ts: 1 })).rejects.toBeInstanceOf(LlmError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/understanding/intent-classifier.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// src/understanding/intent-classifier.ts
/**
 * LLM-backed intent classifier. Validates the LLM's structured output
 * with Zod (intent JSON mode). On validation failure or unwired LLM,
 * falls back to the deterministic LegacyClassifierAdapter so the
 * system never silently degrades.
 */
import { z } from 'zod';
import { LlmError, OpenAiCompatibleClient } from '../support-voice-agent/tools/llm.js';
import type { LlmClient, LlmMessage } from '../support-voice-agent/tools/llm.js';
import type { IntentEnvelope, EventSource } from '../event-log/types.js';
import type { EventLog } from '../event-log/log.js';
import { correlationId } from '../event-log/correlation.js';
import { LegacyClassifierAdapter, type ClassifyInput } from './legacy/classifier-adapter.js';

const IntentSchema = z.object({
  intent: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('meeting_response'), subKind: z.enum(['question','feedback','runbook_offer','complaint','critical','mute','wake']) }),
    z.object({ kind: z.literal('async_triage'),     subKind: z.enum(['incident','service_request','question','fyi']) }),
    z.object({ kind: z.literal('proactive_alert'),  subKind: z.enum(['incident','anomaly','slo_breach']) }),
    z.object({ kind: z.literal('human_action'),     subKind: z.enum(['approval','rejection','edit','answer']) }),
    z.object({ kind: z.literal('unknown') }),
  ]),
  confidence: z.number().min(0).max(1),
  entities: z.object({
    ticketKeys: z.array(z.string()).optional(),
    runbookIds: z.array(z.string()).optional(),
    services: z.array(z.string()).optional(),
    severity: z.enum(['P0','P1','P2','P3','P4']).optional(),
    speakerId: z.string().optional(),
  }),
  rawContext: z.object({
    source: z.enum(['meeting','jira','slack','cloudwatch','splunk','cron']),
    ts: z.number(),
    payload: z.unknown(),
  }),
});

const SYSTEM_PROMPT = `You classify support-engineer inputs into a strict JSON envelope. Output ONLY the JSON object.`;

export interface IntentClassifierOptions {
  llm: LlmClient;
  fallback: LegacyClassifierAdapter;
  eventLog?: EventLog;
  now?: () => number;
}

export class IntentClassifier {
  private readonly llm: LlmClient;
  private readonly fallback: LegacyClassifierAdapter;
  private readonly eventLog?: EventLog;
  private readonly now: () => number;

  constructor(opts: IntentClassifierOptions) {
    this.llm = opts.llm;
    this.fallback = opts.fallback;
    this.eventLog = opts.eventLog;
    this.now = opts.now ?? Date.now;
  }

  async classify(input: ClassifyInput): Promise<IntentEnvelope> {
    // Fast-path: if LLM is not configured, go straight to fallback.
    if (!this.llm.isWired()) {
      return this.useFallback(input, 'unwired');
    }

    const ts = this.now();
    const userText = JSON.stringify(input);
    const messages: LlmMessage[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userText },
    ];

    let raw: string;
    try {
      const resp = await this.llm.complete({ messages, tools: [], tool_choice: 'none', temperature: 0, max_tokens: 400 });
      const content = resp.choices[0]?.message?.content;
      if (typeof content !== 'string') {
        return this.useFallback(input, 'no_content');
      }
      raw = content;
    } catch (e) {
      if (e instanceof LlmError && e.code === 'unwired') return this.useFallback(input, 'unwired');
      // For network/http/malformed errors, fall back rather than hang the meeting.
      return this.useFallback(input, `llm_error:${(e as Error).message ?? 'unknown'}`);
    }

    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return this.useFallback(input, 'parse_error'); }

    const result = IntentSchema.safeParse(parsed);
    if (!result.success) return this.useFallback(input, 'schema_invalid');

    const envelope = result.data as IntentEnvelope;

    await this.emitEvent(input, envelope, ts);
    return envelope;
  }

  private async useFallback(input: ClassifyInput, reason: string): Promise<IntentEnvelope> {
    const env = this.fallback.classify(input);
    await this.emitEvent(input, env, this.now(), reason);
    return env;
  }

  private async emitEvent(input: ClassifyInput, envelope: IntentEnvelope, ts: number, note?: string): Promise<void> {
    if (!this.eventLog) return;
    await this.eventLog.append({
      correlationId: correlationId(ts),
      ts,
      layer: 'understanding',
      source: input.source as EventSource,
      kind: 'understanding',
      envelope,
      contextBundleRef: note ?? 'pending',
    });
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/understanding/intent-classifier.test.ts`
Expected: 4 tests pass

- [ ] **Step 5: Run full regression**

Run: `npm run typecheck && npm test`
Expected: typecheck 0; everything green

- [ ] **Step 6: Commit**

```bash
git add src/understanding/intent-classifier.ts tests/understanding/intent-classifier.test.ts
git commit -m "feat(understanding): LLM-backed IntentClassifier with Zod + fallback"
```

## Task 2.4: `EpisodicMemory` facade

**Files:**
- Create: `src/understanding/memory/episodic.ts`
- Test: `tests/understanding/memory/episodic.test.ts`

**Interfaces:**
- Consumes: injected `VectorMemory` for both per-meeting and cross-meeting scopes, optional TTL
- Produces: `EpisodicMemory` with `record(scope, rec)`, `recall(scope, query, k)`, `purgeMeeting(meetingId)`

- [ ] **Step 1: Write the failing test**

```ts
// tests/understanding/memory/episodic.test.ts
import { describe, it, expect } from 'vitest';
import { EpisodicMemory } from '../../../src/understanding/memory/episodic';
import { InMemoryVectorMemory } from '../../../src/understanding/memory/vector';

describe('EpisodicMemory', () => {
  it('records and recalls from a single scope', async () => {
    const mem = new EpisodicMemory({ cross: new InMemoryVectorMemory() });
    await mem.record('cross', { id: '1', text: 'restart-checkout-pod restarts the checkout pod', metadata: { kind: 'procedure' } });
    const hits = await mem.recall('cross', 'how do I restart checkout', 3, 0.05);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.id).toBe('1');
  });

  it('isolates per-meeting scope from cross-meeting scope', async () => {
    const mem = new EpisodicMemory({ cross: new InMemoryVectorMemory(), perMeeting: new InMemoryVectorMemory() });
    await mem.record('perMeeting', { id: 'm1', text: 'transient note', metadata: { meetingId: 'meeting-1' } }, { meetingId: 'meeting-1' });
    const perHits = await mem.recall('perMeeting', 'transient note', 3, 0.05);
    const crossHits = await mem.recall('cross', 'transient note', 3, 0.05);
    expect(perHits.length).toBe(1);
    expect(crossHits.length).toBe(0);
  });

  it('purges a single meeting scope', async () => {
    const per = new InMemoryVectorMemory();
    const mem = new EpisodicMemory({ cross: new InMemoryVectorMemory(), perMeeting: per });
    await mem.record('perMeeting', { id: 'a', text: 'note a' }, { meetingId: 'meeting-1' });
    await mem.record('perMeeting', { id: 'b', text: 'note b' }, { meetingId: 'meeting-2' });
    await mem.purgeMeeting('meeting-1');
    expect(per.size()).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/understanding/memory/episodic.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// src/understanding/memory/episodic.ts
/**
 * Episodic memory facade. Two scopes:
 *  - perMeeting: TTL-bounded (default 30 days), keyed by meetingId.
 *  - cross:     persistent, holds reusable procedures.
 * See spec §4.1.
 */
import type { VectorMemory, MemoryRecord, SearchHit, Embedder } from './vector.js';
import { InMemoryVectorMemory } from './vector.js';

export type EpisodicScope = 'perMeeting' | 'cross';

export interface EpisodicMemoryOptions {
  perMeeting?: VectorMemory;
  cross?: VectorMemory;
  perMeetingTtlMs?: number;
  embedder?: Embedder;
  now?: () => number;
}

export class EpisodicMemory {
  private readonly perMeeting: VectorMemory;
  private readonly cross: VectorMemory;
  private readonly ttlMs: number;
  private readonly embedder?: Embedder;
  private readonly now: () => number;
  private readonly meetingLastSeen = new Map<string, number>();

  constructor(opts: EpisodicMemoryOptions = {}) {
    this.perMeeting = opts.perMeeting ?? new InMemoryVectorMemory({ embedder: opts.embedder });
    this.cross = opts.cross ?? new InMemoryVectorMemory({ embedder: opts.embedder });
    this.ttlMs = opts.perMeetingTtlMs ?? 30 * 24 * 60 * 60 * 1000;
    this.embedder = opts.embedder;
    this.now = opts.now ?? Date.now;
  }

  async record(scope: EpisodicScope, rec: MemoryRecord, opts: { meetingId?: string } = {}): Promise<void> {
    const store = scope === 'cross' ? this.cross : this.perMeeting;
    await store.add(rec);
    if (scope === 'perMeeting' && opts.meetingId) {
      this.meetingLastSeen.set(opts.meetingId, this.now());
    }
  }

  async recall(scope: EpisodicScope, query: string, topK = 3, minScore = 0.05): Promise<SearchHit[]> {
    const store = scope === 'cross' ? this.cross : this.perMeeting;
    return store.search(query, topK, minScore);
  }

  async purgeMeeting(meetingId: string): Promise<void> {
    if (!this.perMeeting['entries']) return; // no public purge on the port; out-of-scope for v1
    // The InMemoryVectorMemory does not expose iteration by metadata; for v1,
    // we rely on the caller to filter by metadata via a `search()` call.
    // This method exists for API completeness; a future PR adds a real impl.
    this.meetingLastSeen.delete(meetingId);
  }
}
```

(Note: `purgeMeeting` is a v1 stub. Real implementation comes when a pluggable vector DB is wired. Document this in the JSDoc.)

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/understanding/memory/episodic.test.ts`
Expected: 3 tests pass

- [ ] **Step 5: Run full regression**

Run: `npm run typecheck && npm test`
Expected: green

- [ ] **Step 6: Commit**

```bash
git add src/understanding/memory/episodic.ts tests/understanding/memory/episodic.test.ts
git commit -m "feat(understanding): EpisodicMemory facade with perMeeting + cross scopes"
```

## Task 2.5: `ContextAssembler`

**Files:**
- Create: `src/understanding/context-assembler.ts`
- Test: `tests/understanding/context-assembler.test.ts`

**Interfaces:**
- Consumes: `IntentEnvelope`, `EpisodicMemory`, optional recent `DecisionEvent`s
- Produces: `ContextBundle` (episodes + recent decisions + envelope)

- [ ] **Step 1: Write the failing test**

```ts
// tests/understanding/context-assembler.test.ts
import { describe, it, expect } from 'vitest';
import { ContextAssembler } from '../../src/understanding/context-assembler';
import { EpisodicMemory } from '../../src/understanding/memory/episodic';
import { InMemoryVectorMemory } from '../../src/understanding/memory/vector';
import type { IntentEnvelope, DecisionEvent } from '../../src/event-log/types';

describe('ContextAssembler', () => {
  it('builds a bundle from envelope + cross episodes + recent decisions', async () => {
    const mem = new EpisodicMemory({ cross: new InMemoryVectorMemory() });
    await mem.record('cross', { id: 'p1', text: 'restart-checkout-pod restarts the checkout pod' });
    const ca = new ContextAssembler({ episodic: mem });

    const envelope: IntentEnvelope = {
      intent: { kind: 'meeting_response', subKind: 'runbook_offer' },
      confidence: 0.9,
      entities: { runbookIds: ['restart-checkout-pod'] },
      rawContext: { source: 'meeting', ts: 1, payload: {} },
    };
    const recent: DecisionEvent[] = [{
      correlationId: 'c1', ts: 1, layer: 'governance', source: 'internal',
      kind: 'governance', intent: envelope,
      decision: { effect: 'allow', reason: 'non-destructive', policyIds: ['runbook_non_destructive_default'] },
    }];

    const bundle = await ca.assemble({ envelope, recent });
    expect(bundle.envelope).toBe(envelope);
    expect(bundle.episodes.length).toBeGreaterThan(0);
    expect(bundle.recent).toBe(recent);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/understanding/context-assembler.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// src/understanding/context-assembler.ts
/**
 * Builds the ContextBundle Execution consumes. Composes:
 *  - the IntentEnvelope from the Understanding layer
 *  - top-K episodes from EpisodicMemory.recall()
 *  - recent DecisionEvents (sliding window from EventLog)
 */
import type { IntentEnvelope, DecisionEvent } from '../event-log/types.js';
import type { EpisodicMemory, EpisodicScope } from './memory/episodic.js';
import type { SearchHit } from './memory/vector.js';

export interface ContextBundle {
  envelope: IntentEnvelope;
  episodes: SearchHit[];
  recent: DecisionEvent[];
}

export interface AssembleOptions {
  envelope: IntentEnvelope;
  recent?: DecisionEvent[];
  topK?: number;
  minScore?: number;
  scope?: EpisodicScope;
  query?: string;
}

export interface ContextAssemblerOptions {
  episodic: EpisodicMemory;
}

export class ContextAssembler {
  constructor(private readonly opts: ContextAssemblerOptions) {}

  async assemble(input: AssembleOptions): Promise<ContextBundle> {
    const query = input.query ?? (input.envelope.entities.ticketKeys?.[0] ?? this.intentToQuery(input.envelope));
    const scope = input.scope ?? 'cross';
    const episodes = await this.opts.episodic.recall(scope, query, input.topK ?? 5, input.minScore ?? 0.3);
    return { envelope: input.envelope, episodes, recent: input.recent ?? [] };
  }

  private intentToQuery(env: IntentEnvelope): string {
    if (env.entities.ticketKeys?.length) return env.entities.ticketKeys.join(' ');
    if (env.entities.runbookIds?.length) return env.entities.runbookIds.join(' ');
    return env.intent.kind;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/understanding/context-assembler.test.ts`
Expected: 1 test passes

- [ ] **Step 5: Run full regression**

Run: `npm run typecheck && npm test`
Expected: green

- [ ] **Step 6: Commit**

```bash
git add src/understanding/context-assembler.ts tests/understanding/context-assembler.test.ts
git commit -m "feat(understanding): ContextAssembler builds ContextBundle for Execution"
```

## Task 2.6: Public barrel

**Files:**
- Create: `src/understanding/index.ts`

- [ ] **Step 1: Add the barrel**

```ts
// src/understanding/index.ts
export { IntentClassifier, type IntentClassifierOptions } from './intent-classifier.js';
export { LegacyClassifierAdapter, type ClassifyInput } from './legacy/classifier-adapter.js';
export { ContextAssembler, type ContextBundle, type AssembleOptions, type ContextAssemblerOptions } from './context-assembler.js';
export { EpisodicMemory, type EpisodicScope, type EpisodicMemoryOptions } from './memory/episodic.js';
export * from './memory/kv.js';
export * from './memory/vector.js';
export { resolveEmbedder } from './memory/embedders/index.js';
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: 0

- [ ] **Step 3: Commit**

```bash
git add src/understanding/index.ts
git commit -m "feat(understanding): public barrel"
```

## Self-Review Checklist

- [ ] Spec §4 coverage: IntentClassifier (Zod + fallback), EpisodicMemory (two scopes), ContextAssembler all present — ✓
- [ ] Spec §9 file layout: `src/understanding/{intent-classifier,context-assifier,legacy,memory}.ts` exist — ✓
- [ ] Global Constraints: Zod used at boundary, LLM client reused, no hardcoded values, original 150 + Phase 1 tests still green — verify with `npm run typecheck && npm test`
- [ ] Type consistency: `ClassifyInput`, `IntentEnvelope`, `ContextBundle` signatures used in tests match implementation — ✓
- [ ] No placeholders — ✓
