import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { EvidenceGraph } from '../../src/evidence/graph';
import {
  assessImpact,
  attachHypotheses,
  awaitApproval,
  beginInvestigation,
  createIncident,
  FileBackedIncidentMemory,
  FileBackedIncidentStore,
  proposeFix,
} from '../../src/incident-support';

let dir: string;
let recordsPath: string;
let casesPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'incident-durable-'));
  recordsPath = join(dir, 'incidents', 'records.json');
  casesPath = join(dir, 'memory', 'incident-cases.json');
});

afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* platform flake (EACCES/ENOENT on cleanup) — next run gets a fresh tmpdir */
  }
});

const INC = {
  id: 'INC-1842',
  service: 'checkout-service',
  severity: 'P1',
  symptoms: ['checkout 500', 'payment timeout'],
  hypothesesAttempted: ['PR #481'],
  failedActions: ['restart checkout pod'],
  rootCause: 'Redis connection exhaustion',
  remediation: 'raise pool + restart',
  mttrMs: 42 * 60_000,
};

function recordAt(id: string, ts: number) {
  let r = createIncident(id, ts);
  r = assessImpact(r, { service: 'checkout-service', severity: 'P1', summary: 'checkout 500s' }, ts + 1);
  r = beginInvestigation(r, ts + 2);
  return r;
}

describe('FileBackedIncidentStore', () => {
  it('persists records across restarts and lets a resumed lifecycle continue', () => {
    const store = new FileBackedIncidentStore({ path: recordsPath });
    const g = new EvidenceGraph();
    g.upsert({ id: 'svc:checkout', kind: 'service', label: 'checkout-service' });
    let r = createIncident('INC-1', 1000);
    r = assessImpact(r, { service: 'checkout-service', severity: 'P1', summary: 'checkout 500s' }, 1001);
    r = beginInvestigation(r, 1002);
    r = attachHypotheses(r, g, [{ claim: 'PR #481', evidence: ['svc:checkout'] }], 1003);
    store.save(r);
    store.save(recordAt('INC-2', 2000));

    const reborn = new FileBackedIncidentStore({ path: recordsPath });
    expect(reborn.size()).toBe(2);
    // The deserialized record is a real brain record: the lifecycle accepts
    // it and continues (awaitApproval requires phase === 'proposed'... first
    // proposeFix, which requires root_cause).
    const resumed = reborn.get('INC-1');
    expect(resumed?.phase).toBe('root_cause');
    const proposed = proposeFix(resumed!, 'rollback checkout-service to v2.40', 1004);
    const next = awaitApproval(proposed, 'appr-1', 1005);
    expect(next.phase).toBe('awaiting_approval');
    expect(next.approvalId).toBe('appr-1');
  });

  it('keeps upsert semantics: saving the same id replaces, not duplicates', () => {
    const store = new FileBackedIncidentStore({ path: recordsPath });
    store.save(recordAt('INC-1', 1000));
    store.save(recordAt('INC-1', 5000));
    expect(store.size()).toBe(1);
    // Upsert: the second save's timeline (3 entries), not the first's.
    expect(store.get('INC-1')?.timeline.length).toBe(3);
  });

  it('creates parent directories on first save and the snapshot stays human-inspectable', () => {
    const store = new FileBackedIncidentStore({ path: join(dir, 'a/b/c/records.json') });
    store.save(recordAt('INC-1', 1000));
    const raw = readFileSync(join(dir, 'a/b/c/records.json'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(raw).toContain('"INC-1"');
  });

  it('fails open on a corrupt snapshot: empty store, repaired on next save', () => {
    mkdirSync(dirname(recordsPath), { recursive: true });
    writeFileSync(recordsPath, '{not json', 'utf8');
    const store = new FileBackedIncidentStore({ path: recordsPath });
    expect(store.size()).toBe(0);
    store.save(recordAt('INC-1', 1000));
    expect(new FileBackedIncidentStore({ path: recordsPath }).size()).toBe(1);
  });

  it('drops on-disk entries that fail validation instead of failing the boot', () => {
    const good = recordAt('INC-good', 1000);
    const bad = { id: 42, phase: 'nope', timeline: 'not-an-array' };
    mkdirSync(dirname(recordsPath), { recursive: true });
    writeFileSync(recordsPath, JSON.stringify([JSON.parse(JSON.stringify(good)), bad]), 'utf8');
    const store = new FileBackedIncidentStore({ path: recordsPath });
    expect(store.size()).toBe(1);
    expect(store.get('INC-good')).toBeDefined();
  });
});

describe('FileBackedIncidentMemory', () => {
  it('recalls past incidents learned in a previous process lifetime', () => {
    const first = new FileBackedIncidentMemory({ path: casesPath });
    first.store(INC);
    first.store({
      id: 'INC-1900',
      service: 'search-service',
      severity: 'P3',
      symptoms: ['slow autocomplete'],
      hypothesesAttempted: [],
      failedActions: [],
    });

    const reborn = new FileBackedIncidentMemory({ path: casesPath });
    expect(reborn.size()).toBe(2);
    const line = reborn.recallLine({
      id: 'INC-new',
      service: 'checkout-service',
      severity: 'P1',
      symptoms: ['checkout 500s', 'payment timeouts'],
      hypothesesAttempted: [],
      failedActions: [],
    });
    expect(line).toMatch(/INC-1842/);
    expect(line).toMatch(/Redis connection exhaustion/);
  });

  it('fails open on a corrupt case snapshot and repairs on the next store', () => {
    mkdirSync(dirname(casesPath), { recursive: true });
    writeFileSync(casesPath, ']]corrupt[[', 'utf8');
    const mem = new FileBackedIncidentMemory({ path: casesPath });
    expect(mem.size()).toBe(0);
    mem.store(INC);
    expect(new FileBackedIncidentMemory({ path: casesPath }).size()).toBe(1);
  });

  it('updates (not duplicates) a case with the same id', () => {
    const mem = new FileBackedIncidentMemory({ path: casesPath });
    mem.store(INC);
    mem.store({ ...INC, rootCause: 'updated cause' });
    expect(mem.size()).toBe(1);
    const reborn = new FileBackedIncidentMemory({ path: casesPath });
    expect(reborn.size()).toBe(1);
    expect(reborn.findSimilar({ ...INC, id: 'INC-query' })[0]?.signature.rootCause).toBe('updated cause');
  });
});
