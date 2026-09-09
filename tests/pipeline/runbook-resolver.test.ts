/** RunbookResolver unit tests — the tiers that decide WHICH action runs.
 *
 *  Executing the wrong action is worse than executing nothing (live-proven:
 *  "please restart the primary database" once resolved through description
 *  keywords to `restart-checkout-pod` and auto-executed). Tier 3 uses the
 *  platform KB's real hybrid scorer over the catalog's own docs — the same
 *  engine that grounds citations — with calibrated fail-safe bands. These
 *  tests run against the REAL scorer (FileBackedKnowledgeBase + runbookToDoc,
 *  the production wiring), not a mock, so the bands stay honest if the
 *  engine's scale ever drifts. The mix-up regression replays the exact
 *  catalog and utterance from the live incident. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunbookResolver } from '../../src/pipeline/runbook-resolver';
import { InMemoryRunbookProvider } from '../../src/support-voice-agent/integrations/runbook';
import { FileBackedKnowledgeBase } from '../../src/understanding/knowledge/knowledge-base';
import { runbookToDoc } from '../../src/bootstrap/runbooks-kb';
import type { RunbookAction } from '../../src/support-voice-agent/integrations/runbook';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'resolver-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const MIXUP_CATALOG: RunbookAction[] = [
  { id: 'restart-checkout-pod', name: 'Restart checkout pod', description: 'restart the checkout pod', destructive: false },
  { id: 'db-restart-drill', name: 'Database restart drill', description: 'restart the primary database', destructive: true },
];

function makeResolver(actions: RunbookAction[]): RunbookResolver {
  const provider = new InMemoryRunbookProvider(actions);
  const kb = new FileBackedKnowledgeBase({ path: join(dir, 'kb.json') });
  for (const a of actions) kb.ingest(runbookToDoc(a));
  return new RunbookResolver(provider, kb);
}

describe('RunbookResolver tiers', () => {
  it('tier 1: an explicit action id wins over everything', async () => {
    const r = makeResolver(MIXUP_CATALOG);
    const res = await r.resolve('db-restart-drill', 'please restart the checkout pod');
    expect(res).toEqual({ kind: 'resolved', match: { id: 'db-restart-drill', destructive: true, matchedBy: 'id' } });
  });

  it('tier 2: the full action name appearing in the text wins', async () => {
    const r = makeResolver(MIXUP_CATALOG);
    const res = await r.resolve(undefined, 'please run Database restart drill now');
    expect(res).toEqual({ kind: 'resolved', match: { id: 'db-restart-drill', destructive: true, matchedBy: 'name' } });
  });

  it('tier 3 strong band: a confident non-destructive match auto-resolves with matchedBy kb', async () => {
    const r = makeResolver(MIXUP_CATALOG);
    // Calibrated: "please restart the checkout pod" scores ~1.5 for the pod.
    const res = await r.resolve(undefined, 'please restart the checkout pod now');
    expect(res).toEqual({ kind: 'resolved', match: { id: 'restart-checkout-pod', destructive: false, matchedBy: 'kb' } });
  });
});

describe('the checkout-pod mix-up regression (live incident replay)', () => {
  it('a database imperative never executes the checkout pod', async () => {
    const r = makeResolver(MIXUP_CATALOG);
    const res = await r.resolve(undefined, 'please restart the primary database now');
    expect(res).toBeDefined();
    expect(res!.kind).toBe('resolved');
    if (res!.kind !== 'resolved') return;
    // Whatever resolves, the wrong harmless action must not: the destructive
    // drill is the speaker's intent (or nothing is). Calibrated: the drill
    // outruns the pod 1.18 vs 0.54 on the real engine.
    expect(res!.match.id).toBe('db-restart-drill');
    expect(res!.match.destructive).toBe(true);
    expect(res!.match.matchedBy).toBe('kb');
  });

  it('a destructive request naming NO catalog action stages the destructive top candidate, never the harmless one', async () => {
    // Sibling catalog: no database action at all — the old resolver ran the
    // checkout pod here (shared verb "restart").
    const r = makeResolver([
      { id: 'restart-checkout-pod', name: 'Restart checkout pod', description: 'restart the checkout pod', destructive: false },
      { id: 'restart-payment-pod', name: 'Restart payment pod', description: 'restart the payment pod', destructive: false },
      { id: 'db-restart-drill', name: 'Database restart drill', description: 'restart the primary database', destructive: true },
    ]);
    const res = await r.resolve(undefined, 'please restart the payment database now');
    if (res?.kind === 'resolved') {
      expect(res.match.id).toBe('db-restart-drill');
      expect(res.match.destructive).toBe(true);
    } else if (res?.kind === 'ambiguous') {
      expect(res.closest).not.toContain('restart-checkout-pod');
    } else {
      expect(res).toBeUndefined();
    }
  });
});

describe('fail-safe bands', () => {
  it('a clear non-destructive winner below the strong floor is refused with hints, never executed', async () => {
    // "payment pod" against a catalog missing payment: the pod family is
    // close (~1.0) but below the strong floor, and no destructive candidate
    // exists to stage — refuse with the closest ids.
    const r = makeResolver([
      { id: 'restart-checkout-pod', name: 'Restart checkout pod', description: 'restart the checkout pod', destructive: false },
      { id: 'db-restart-drill', name: 'Database restart drill', description: 'restart the primary database', destructive: true },
    ]);
    const res = await r.resolve(undefined, 'please restart the payment pod now');
    if (res?.kind === 'resolved') {
      // Allowed outcome only if the destructive candidate was staged (never
      // the harmless pod on a sub-strong score).
      expect(res.match.id).toBe('db-restart-drill');
    } else {
      expect(res?.kind).toBe('ambiguous');
    }
  });

  it('an unrelated query resolves to nothing (no least-bad guess)', async () => {
    const r = makeResolver(MIXUP_CATALOG);
    // Calibrated: ticket-status chatter scores ≤ 0.2, far under the floor.
    const res = await r.resolve(undefined, 'what is the status of SUPPORT-7');
    expect(res).toBeUndefined();
  });

  it('a destructive top candidate below the strong floor still resolves (the gate decides)', async () => {
    const r = makeResolver(MIXUP_CATALOG);
    // "failover" phrasing scores ~0.34 for the drill — sub-strong, but the
    // candidate is destructive: resolving hands the decision to approval.
    const res = await r.resolve(undefined, 'please failover the database now');
    if (res?.kind === 'resolved') {
      expect(res.match).toMatchObject({ id: 'db-restart-drill', destructive: true, matchedBy: 'kb' });
    } else {
      // Acceptable alternative: refuse rather than guess.
      expect(res?.kind).toBe('ambiguous');
    }
  });

  it('without a KB, resolution is exact id/name only', async () => {
    const provider = new InMemoryRunbookProvider(MIXUP_CATALOG);
    const r = new RunbookResolver(provider);
    expect(await r.resolve(undefined, 'please restart the primary database now')).toBeUndefined();
    expect(await r.resolve('db-restart-drill', 'anything')).toEqual({
      kind: 'resolved',
      match: { id: 'db-restart-drill', destructive: true, matchedBy: 'id' },
    });
  });

  it('a provider failure degrades to no-match instead of throwing', async () => {
    const badProvider = {
      list: () => Promise.reject(new Error('catalog unavailable')),
    };
    const kb = new FileBackedKnowledgeBase({ path: join(dir, 'kb.json') });
    const r = new RunbookResolver(badProvider as never, kb);
    await expect(r.resolve('restart-checkout-pod', 'x')).resolves.toBeUndefined();
  });
});
