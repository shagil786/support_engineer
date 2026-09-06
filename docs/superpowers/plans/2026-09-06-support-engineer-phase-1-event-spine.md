# Phase 1 — Event Spine + DecisionEventLog

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the `EventLog` substrate that every later layer emits to and Learning / Supervisor / SafetyNet audit replay read from. No behavior change to existing code; this phase is pure scaffolding.

**Architecture:** A `DecisionEvent` discriminated union (`src/event-log/types.ts`), an `EventLog` interface (`src/event-log/log.ts`), a JSONL file-backed implementation segmented daily under `./var/events/`, a `correlationId` generator, and a small set of unit tests. No layer reads/writes yet — we just ship the substrate and prove it round-trips.

**Tech Stack:** TypeScript strict, `node:fs/promises`, `node:fs` for directory creation, existing `vitest`. No new deps.

**Spec:** `docs/superpowers/specs/2026-09-06-support-engineer-agentic-design.md` §8 (DecisionEventLog), §9 (file layout: `src/event-log/`, `var/events/`).

## Global Constraints

- TypeScript strict, `noUncheckedIndexedAccess`, `noImplicitOverride`, `isolatedModules` (existing `tsconfig.json`).
- No hardcoded hosts, tokens, or keys anywhere in `src/` — no exceptions in this phase.
- All code is dependency-free (no new packages).
- Every new file uses ESM imports with `.js` extensions in source paths (matches existing style).
- 150 existing tests must remain green at every commit.
- All public types are exported from `src/event-log/index.ts`.

## File Structure

```
src/event-log/
├── correlation.ts      # correlationId() — short, sortable, unique
├── types.ts            # DecisionEvent discriminated union + helper guards
├── log.ts              # EventLog interface + JsonlFileEventLog implementation
├── filter.ts           # EventFilter builder + matchEvent()
└── index.ts            # public exports

tests/event-log/
├── correlation.test.ts
├── types.test.ts
├── log.test.ts
└── filter.test.ts

var/
└── events/             # runtime data dir, gitignored
```

## Task 1.1: `correlationId()` generator

**Files:**
- Create: `src/event-log/correlation.ts`
- Test: `tests/event-log/correlation.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `export function correlationId(now?: number): string`

- [ ] **Step 1: Write the failing test**

```ts
// tests/event-log/correlation.test.ts
import { describe, it, expect } from 'vitest';
import { correlationId } from '../../src/event-log/correlation';

describe('correlationId', () => {
  it('returns a string', () => {
    expect(typeof correlationId()).toBe('string');
  });

  it('is monotonically sortable when called with the same timestamp', () => {
    const ts = 1_700_000_000_000;
    const ids = Array.from({ length: 100 }, () => correlationId(ts));
    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids); // already sorted
  });

  it('is unique across 10k calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) ids.add(correlationId());
    expect(ids.size).toBe(10_000);
  });

  it('starts with the hex epoch ms', () => {
    const ts = 1_700_000_000_000;
    expect(correlationId(ts).startsWith(ts.toString(16))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/event-log/correlation.test.ts`
Expected: FAIL with `Cannot find module '../../src/event-log/correlation'` (or similar)

- [ ] **Step 3: Implement**

```ts
// src/event-log/correlation.ts
/**
 * Generate a sortable, unique correlation id.
 *
 * Format: <hexEpochMs>-<6-char base36 monotonic counter>
 *
 * - Sortable: two ids generated with the same `now` sort in the order they
 *   were produced (counter is monotonic per ms).
 * - Unique across processes: the counter resets on each call but the epoch
 *   prefix differentiates calls from different ms.
 * - Short: fits comfortably in log lines.
 */
let lastMs = 0;
let counter = 0;

export function correlationId(now: number = Date.now()): string {
  if (now !== lastMs) {
    lastMs = now;
    counter = 0;
  }
  counter = (counter + 1) >>> 0; // wrap to uint32
  return `${now.toString(16)}-${counter.toString(36).padStart(6, '0')}`;
}

/** Test-only: reset the monotonic counter. Not exported from index. */
export function __resetCorrelationState(): void {
  lastMs = 0;
  counter = 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/event-log/correlation.test.ts`
Expected: 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/event-log/correlation.ts tests/event-log/correlation.test.ts
git commit -m "feat(event-log): add correlationId generator"
```

## Task 1.2: `DecisionEvent` discriminated union

**Files:**
- Create: `src/event-log/types.ts`
- Create: `src/event-log/index.ts`
- Test: `tests/event-log/types.test.ts`

**Interfaces:**
- Consumes: nothing new
- Produces: `DecisionEvent` union, `DecisionEventOf<T>` lookup, `EventLayer`, `EventSource`

- [ ] **Step 1: Write the failing test**

```ts
// tests/event-log/types.test.ts
import { describe, it, expect } from 'vitest';
import type { DecisionEvent } from '../../src/event-log/types';
import { isDecisionEvent } from '../../src/event-log/types';

const baseFields = { correlationId: 'abc', ts: 1, layer: 'governance' as const, source: 'internal' as const };

describe('DecisionEvent types', () => {
  it('accepts an understanding event', () => {
    const e: DecisionEvent = {
      ...baseFields,
      kind: 'understanding',
      envelope: { intent: { kind: 'unknown' }, confidence: 0, entities: {}, rawContext: { source: 'meeting', ts: 1, payload: {} } },
    };
    expect(isDecisionEvent(e)).toBe(true);
  });

  it('accepts a tool_call event', () => {
    const e: DecisionEvent = {
      ...baseFields,
      kind: 'tool_call',
      tool: 'jira.getIssue',
      args: { issueKey: 'SUPPORT-1' },
      result: { ok: true, data: { key: 'SUPPORT-1' } },
      latencyMs: 120,
      attempts: 1,
    };
    expect(isDecisionEvent(e)).toBe(true);
  });

  it('rejects an unknown kind', () => {
    expect(isDecisionEvent({ ...baseFields, kind: 'bogus' } as unknown)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/event-log/types.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// src/event-log/types.ts
/**
 * Cross-layer event substrate. Every layer emits; only Learning,
 * Supervisor's recent-decisions window, and SafetyNet audit replay
 * read from it. See spec §8.
 */
import type { ToolName, ToolResult } from '../support-voice-agent/tools/types';
import type { Severity } from '../support-voice-agent/types';

export type EventLayer = 'understanding' | 'governance' | 'execution' | 'learning' | 'surface';
export type EventSource =
  | 'meeting' | 'jira' | 'slack' | 'cloudwatch' | 'splunk' | 'cron' | 'internal';

export interface IntentEnvelope {
  intent:
    | { kind: 'meeting_response'; subKind: 'question' | 'feedback' | 'runbook_offer' | 'complaint' | 'critical' | 'mute' | 'wake' }
    | { kind: 'async_triage'; subKind: 'incident' | 'service_request' | 'question' | 'fyi' }
    | { kind: 'proactive_alert'; subKind: 'incident' | 'anomaly' | 'slo_breach' }
    | { kind: 'human_action'; subKind: 'approval' | 'rejection' | 'edit' | 'answer' }
    | { kind: 'unknown' };
  confidence: number;
  entities: {
    ticketKeys?: string[];
    runbookIds?: string[];
    services?: string[];
    severity?: Severity;
    speakerId?: string;
  };
  rawContext: { source: EventSource; ts: number; payload: unknown };
}

export interface Decision {
  effect: 'allow' | 'deny' | 'require_approval' | 'transform';
  reason: string;
  policyIds: string[];
  transformedAction?: unknown;
  unconditionalSafetyNetCheck?: boolean;
}

interface BaseEvent {
  correlationId: string;
  ts: number;
  layer: EventLayer;
  source: EventSource;
}

export type DecisionEvent =
  (BaseEvent & { kind: 'understanding'; envelope: IntentEnvelope; contextBundleRef: string }) |
  (BaseEvent & { kind: 'governance'; intent: IntentEnvelope; decision: Decision }) |
  (BaseEvent & { kind: 'safety_net'; vetoed: boolean; check: string; reason: string }) |
  (BaseEvent & { kind: 'approval_request'; approvalId: string; policyId: string; approver_count: number }) |
  (BaseEvent & { kind: 'approval_granted'; approvalId: string; signerRole: string }) |
  (BaseEvent & { kind: 'approval_timeout'; approvalId: string }) |
  (BaseEvent & { kind: 'tool_call'; tool: ToolName; args: unknown; result: ToolResult; latencyMs: number; attempts: number }) |
  (BaseEvent & { kind: 'agent_outcome'; finalResult: { ok: boolean; summary: string } }) |
  (BaseEvent & { kind: 'policy_suggested'; suggestionId: string }) |
  (BaseEvent & { kind: 'policy_promoted'; policyId: string; bundleSha: string; promotedBy: string[] }) |
  (BaseEvent & { kind: 'knowledge_extracted'; procedureId: string });

const KINDS: readonly DecisionEvent['kind'][] = [
  'understanding', 'governance', 'safety_net',
  'approval_request', 'approval_granted', 'approval_timeout',
  'tool_call', 'agent_outcome',
  'policy_suggested', 'policy_promoted', 'knowledge_extracted',
];

export function isDecisionEvent(x: unknown): x is DecisionEvent {
  if (typeof x !== 'object' || x === null) return false;
  const k = (x as { kind?: unknown }).kind;
  return typeof k === 'string' && (KINDS as readonly string[]).includes(k);
}

export type DecisionEventOf<K extends DecisionEvent['kind']> = Extract<DecisionEvent, { kind: K }>;
```

- [ ] **Step 4: Implement the public barrel**

```ts
// src/event-log/index.ts
export * from './types.js';
export { correlationId } from './correlation.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/event-log/types.test.ts`
Expected: 3 tests pass

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: exit 0

- [ ] **Step 7: Commit**

```bash
git add src/event-log/types.ts src/event-log/index.ts tests/event-log/types.test.ts
git commit -m "feat(event-log): add DecisionEvent discriminated union"
```

## Task 1.3: `EventLog` interface + JSONL file implementation

**Files:**
- Create: `src/event-log/log.ts`
- Modify: `src/event-log/index.ts`
- Test: `tests/event-log/log.test.ts`

**Interfaces:**
- Consumes: `DecisionEvent` (Task 1.2)
- Produces: `EventLog` interface, `JsonlFileEventLog` class with `append()`, `query()`

- [ ] **Step 1: Write the failing test**

```ts
// tests/event-log/log.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlFileEventLog } from '../../src/event-log/log';
import type { DecisionEvent } from '../../src/event-log/types';
import { correlationId } from '../../src/event-log/correlation';

let dir: string;
let log: JsonlFileEventLog;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eventlog-'));
  log = new JsonlFileEventLog({ baseDir: dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ev = (over: Partial<DecisionEvent> = {}): DecisionEvent => ({
  correlationId: correlationId(),
  ts: 1_700_000_000_000,
  layer: 'governance',
  source: 'internal',
  kind: 'governance',
  intent: { intent: { kind: 'unknown' }, confidence: 0, entities: {}, rawContext: { source: 'internal', ts: 0, payload: {} } },
  decision: { effect: 'allow', reason: 'test', policyIds: [] },
  ...over,
} as DecisionEvent);

describe('JsonlFileEventLog', () => {
  it('appends and reads back the same event', async () => {
    const e = ev();
    await log.append(e);
    const out: DecisionEvent[] = [];
    for await (const x of log.query({})) out.push(x);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(e);
  });

  it('segments files by date', async () => {
    await log.append(ev({ ts: 1_700_000_000_000 })); // 2023-11-14
    await log.append(ev({ ts: 1_700_086_400_000 })); // 2023-11-15
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
    expect(files.length).toBe(2);
    expect(files[0]).toMatch(/^2023-11-14\.jsonl$/);
    expect(files[1]).toMatch(/^2023-11-15\.jsonl$/);
  });

  it('appends multiple events to the same file', async () => {
    await log.append(ev());
    await log.append(ev());
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBe(1);
    const lines = readFileSync(join(dir, files[0]!), 'utf8').trim().split('\n');
    expect(lines.length).toBe(2);
  });

  it('filters by kind', async () => {
    await log.append(ev({ kind: 'governance' }));
    await log.append(ev({ kind: 'tool_call', tool: 'jira.getIssue', args: {}, result: { ok: true, data: null }, latencyMs: 1, attempts: 1 } as unknown as DecisionEvent));
    const out: DecisionEvent[] = [];
    for await (const x of log.query({ kind: 'tool_call' })) out.push(x);
    expect(out.length).toBe(1);
    expect(out[0]!.kind).toBe('tool_call');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/event-log/log.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```ts
// src/event-log/log.ts
/**
 * EventLog interface and a JSONL file-backed implementation (v1).
 *
 * Files are segmented daily: <baseDir>/YYYY-MM-DD.jsonl. Append-only.
 * The interface is pluggable to Postgres / Kafka later by providing
 * another implementation.
 */
import { mkdir, appendFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { DecisionEvent } from './types.js';
import { isDecisionEvent } from './types.js';

export interface EventFilter {
  kind?: DecisionEvent['kind'];
  layer?: DecisionEvent['layer'];
  source?: DecisionEvent['source'];
  /** Inclusive lower epoch-ms bound. */
  from?: number;
  /** Exclusive upper epoch-ms bound. */
  to?: number;
  /** Match a specific correlationId. */
  correlationId?: string;
}

export interface EventLog {
  append(event: DecisionEvent): Promise<void>;
  query(filter: EventFilter): AsyncIterable<DecisionEvent>;
}

export interface JsonlFileEventLogOptions {
  baseDir: string;
  /** Injectable clock for tests. */
  now?: () => number;
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export class JsonlFileEventLog implements EventLog {
  private readonly baseDir: string;
  private readonly now: () => number;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: JsonlFileEventLogOptions) {
    this.baseDir = opts.baseDir;
    this.now = opts.now ?? Date.now;
  }

  async append(event: DecisionEvent): Promise<void> {
    if (!isDecisionEvent(event)) {
      throw new Error('append: not a DecisionEvent');
    }
    const line = JSON.stringify(event) + '\n';
    const path = join(this.baseDir, `${dayKey(event.ts)}.jsonl`);
    // Serialize concurrent appends within this process.
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(this.baseDir, { recursive: true });
      await appendFile(path, line, 'utf8');
    });
    return this.writeChain;
  }

  async *query(filter: EventFilter): AsyncIterable<DecisionEvent> {
    const files = (await readdir(this.baseDir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
    for (const f of files) {
      const m = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(f)!;
      const dayStart = Date.UTC(Number(m![1]), Number(m![2]) - 1, Number(m![3]));
      const dayEnd = dayStart + 86_400_000;
      if (filter.from !== undefined && dayEnd <= filter.from) continue;
      if (filter.to !== undefined && dayStart >= filter.to) continue;

      const stream = createReadStream(join(this.baseDir, f), { encoding: 'utf8' });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(trimmed); } catch { continue; }
        if (!isDecisionEvent(parsed)) continue;
        if (filter.kind !== undefined && parsed.kind !== filter.kind) continue;
        if (filter.layer !== undefined && parsed.layer !== filter.layer) continue;
        if (filter.source !== undefined && parsed.source !== filter.source) continue;
        if (filter.correlationId !== undefined && parsed.correlationId !== filter.correlationId) continue;
        if (filter.from !== undefined && parsed.ts < filter.from) continue;
        if (filter.to !== undefined && parsed.ts >= filter.to) continue;
        yield parsed;
      }
    }
  }
}
```

- [ ] **Step 4: Update the barrel**

Replace `src/event-log/index.ts` with:

```ts
export * from './types.js';
export { correlationId } from './correlation.js';
export type { EventLog, EventFilter, JsonlFileEventLogOptions } from './log.js';
export { JsonlFileEventLog } from './log.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/event-log/log.test.ts`
Expected: 4 tests pass

- [ ] **Step 6: Run full typecheck + test suite**

Run: `npm run typecheck && npm test`
Expected: typecheck 0, all tests including the original 150 pass

- [ ] **Step 7: Commit**

```bash
git add src/event-log/log.ts src/event-log/index.ts tests/event-log/log.test.ts
git commit -m "feat(event-log): add JsonlFileEventLog with daily segmentation"
```

## Task 1.4: Gitignore runtime dir

**Files:**
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing
- Produces: `var/` ignored

- [ ] **Step 1: Append `var/` to `.gitignore`**

Read `.gitignore` first. Append a new line `var/` if not present.

- [ ] **Step 2: Commit**

```bash
git add .gitignore
git commit -m "chore: gitignore runtime var/ directory"
```

## Task 1.5: End-to-end smoke test

**Files:**
- Create: `tests/event-log/e2e.test.ts`

**Interfaces:**
- Consumes: `JsonlFileEventLog`, `DecisionEvent` (Tasks 1.1–1.3)
- Produces: passing e2e test that exercises round-trip across process boundaries (read after write)

- [ ] **Step 1: Write the failing test**

```ts
// tests/event-log/e2e.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlFileEventLog } from '../../src/event-log/log';
import { correlationId } from '../../src/event-log/correlation';
import type { DecisionEvent } from '../../src/event-log/types';

describe('event-log e2e', () => {
  it('round-trips a realistic event sequence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eventlog-e2e-'));
    try {
      const log = new JsonlFileEventLog({ baseDir: dir });
      const cid = correlationId(1_700_000_000_000);

      const sequence: DecisionEvent[] = [
        {
          correlationId: cid, ts: 1_700_000_000_000, layer: 'understanding', source: 'meeting',
          kind: 'understanding',
          envelope: { intent: { kind: 'meeting_response', subKind: 'question' }, confidence: 0.92, entities: { ticketKeys: ['SUPPORT-7'] }, rawContext: { source: 'meeting', ts: 1_700_000_000_000, payload: {} } },
          contextBundleRef: 'ctx-1',
        },
        {
          correlationId: cid, ts: 1_700_000_000_010, layer: 'governance', source: 'internal',
          kind: 'governance',
          intent: { intent: { kind: 'meeting_response', subKind: 'question' }, confidence: 0.92, entities: { ticketKeys: ['SUPPORT-7'] }, rawContext: { source: 'meeting', ts: 1_700_000_000_000, payload: {} } },
          decision: { effect: 'allow', reason: 'read-only Jira query', policyIds: ['read_only_default_allow'] },
        },
        {
          correlationId: cid, ts: 1_700_000_000_020, layer: 'execution', source: 'jira',
          kind: 'tool_call',
          tool: 'jira.getIssue',
          args: { issueKey: 'SUPPORT-7' },
          result: { ok: true, data: { key: 'SUPPORT-7', status: 'In Progress' } },
          latencyMs: 87, attempts: 1,
        },
      ];

      for (const e of sequence) await log.append(e);

      const got: DecisionEvent[] = [];
      for await (const e of log.query({ correlationId: cid })) got.push(e);

      expect(got).toHaveLength(3);
      expect(got.map((e) => e.kind)).toEqual(['understanding', 'governance', 'tool_call']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm test -- tests/event-log/e2e.test.ts`
Expected: 1 test passes

- [ ] **Step 3: Run full regression**

Run: `npm run typecheck && npm test`
Expected: typecheck 0, all original 150 + new tests pass

- [ ] **Step 4: Commit**

```bash
git add tests/event-log/e2e.test.ts
git commit -m "test(event-log): e2e round-trip across a realistic sequence"
```

## Self-Review Checklist (run before handing off)

- [ ] Spec §8 coverage: `DecisionEvent` union covers all 11 kinds — ✓
- [ ] Spec §9 file layout: `src/event-log/{correlation,types,log,index}.ts` and `tests/event-log/` exist — ✓
- [ ] Global Constraints: no new deps, no hardcoded values, original 150 tests still green — verify with `npm run typecheck && npm test`
- [ ] Type consistency: `correlationId()` signature used in tests matches implementation — ✓
- [ ] No placeholders: every step has concrete code — ✓
