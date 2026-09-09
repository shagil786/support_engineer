/** Band-calibration eval (ADR-0006): re-measures the hybrid scorer's score
 *  distribution on catalog-shaped probes and asserts the resolver's
 *  RUNBOOK_BANDS still sit inside the measured true/wrong-winner gap.
 *
 *  This is the recalibration ADR-0002 and ADR-0006 both flag: the bands are
 *  calibrated constants, not self-tuning, so if the engine's scale drifts
 *  (different reranker, fusion, or embedder), the resolver would mis-sort
 *  real utterances. This eval fails first — deterministically, in CI, with
 *  the measured scores and the recalibration instruction. Runs against the
 *  REAL engine (FileBackedKnowledgeBase + runbookToDoc, the production
 *  wiring), not a mock. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileBackedKnowledgeBase } from '../../../src/understanding/knowledge/knowledge-base';
import { assertBandsInGap, type BandCase } from '../../../src/understanding/knowledge/retrieval-eval';
import { runbookToDoc } from '../../../src/bootstrap/runbooks-kb';
import { RUNBOOK_BANDS } from '../../../src/pipeline/runbook-resolver';
import type { RunbookAction } from '../../../src/support-voice-agent/integrations/runbook';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'band-eval-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Five-action catalog shaped like a real one: sibling pod restarts (the
 *  mix-up family), a destructive drill, a cache flush, a frontend rollout. */
const CATALOG: RunbookAction[] = [
  { id: 'restart-checkout-pod', name: 'Checkout pod restart', description: 'restart the checkout pod', destructive: false },
  { id: 'restart-payment-pod', name: 'Payment pod restart', description: 'restart the payment pod', destructive: false },
  { id: 'db-restart-drill', name: 'Database restart drill', description: 'restart the primary database', destructive: true },
  { id: 'clear-api-cache', name: 'API cache flush', description: 'clear the api cache', destructive: false },
  { id: 'redeploy-web-frontend', name: 'Web frontend rollout', description: 'redeploy the web frontend', destructive: false },
];

const whereRunbooks = { source: 'runbooks' } as const;

/** Calibrated probes, measured against the live engine at the time the
 *  bands were pinned (measured: TRUE 1.179–1.528, WRONG ≤ 1.060,
 *  UNRELATED ≤ 0.259, sub-strong-destructive 0.532). */
const CASES: BandCase[] = [
  // TRUE matches: must clear the strong band — auto-resolve territory.
  { id: 'true-checkout', query: 'please restart the checkout pod now', targetDocId: 'runbook:restart-checkout-pod', min: RUNBOOK_BANDS.strong, where: whereRunbooks },
  { id: 'true-payment', query: 'please restart the payment pod now', targetDocId: 'runbook:restart-payment-pod', min: RUNBOOK_BANDS.strong, where: whereRunbooks },
  { id: 'true-cache', query: 'please clear the api cache now', targetDocId: 'runbook:clear-api-cache', min: RUNBOOK_BANDS.strong, where: whereRunbooks },
  { id: 'true-frontend', query: 'please redeploy the web frontend now', targetDocId: 'runbook:redeploy-web-frontend', min: RUNBOOK_BANDS.strong, where: whereRunbooks },
  { id: 'true-database', query: 'please restart the primary database now', targetDocId: 'runbook:db-restart-drill', min: RUNBOOK_BANDS.strong, where: whereRunbooks },
  // WRONG winners: near-miss phrasings — the top hit must stay below the
  // strong band (fail-safe bands decide, never auto-execution).
  { id: 'wrong-staging-pod', query: 'please restart the staging pod now', max: RUNBOOK_BANDS.strong, where: whereRunbooks },
  { id: 'wrong-session-cache', query: 'please clear the user session cache now', max: RUNBOOK_BANDS.strong, where: whereRunbooks },
  { id: 'wrong-billing-frontend', query: 'please redeploy the billing frontend now', max: RUNBOOK_BANDS.strong, where: whereRunbooks },
  // UNRELATED chatter: the top hit must stay below the floor — no least-bad
  // guess.
  { id: 'unrelated-ticket', query: 'what is the status of SUPPORT-7', max: RUNBOOK_BANDS.floor, where: whereRunbooks },
  { id: 'unrelated-oncall', query: 'who is on call this week', max: RUNBOOK_BANDS.floor, where: whereRunbooks },
  { id: 'unrelated-summary', query: 'can you summarize the meeting', max: RUNBOOK_BANDS.floor, where: whereRunbooks },
  // Sub-strong destructive: must stay at-or-above the floor so the
  // destructive staging rung still catches it (the gate decides).
  { id: 'substrong-failover', query: 'please failover the database now', targetDocId: 'runbook:db-restart-drill', min: RUNBOOK_BANDS.floor, where: whereRunbooks },
];

describe('runbook band calibration (ADR-0006)', () => {
  it('the resolver bands sit inside the measured true/wrong-winner gap', async () => {
    const kb = new FileBackedKnowledgeBase({ path: join(dir, 'kb.json') });
    for (const a of CATALOG) kb.ingest(runbookToDoc(a));
    const result = await assertBandsInGap(kb, CASES);
    expect(result.cases).toBe(CASES.length);
    expect(result.measurements.every((m) => m.ok)).toBe(true);
  });

  it('fails loudly when the distribution no longer fits the bands', async () => {
    const kb = new FileBackedKnowledgeBase({ path: join(dir, 'kb.json') });
    for (const a of CATALOG) kb.ingest(runbookToDoc(a));
    // A case whose band is impossible on the real distribution: unrelated
    // chatter pinned at-or-above the strong band.
    const broken: BandCase[] = [
      { id: 'impossible', query: 'who is on call this week', min: RUNBOOK_BANDS.strong, where: whereRunbooks },
    ];
    await expect(assertBandsInGap(kb, broken)).rejects.toThrow(/band calibration failed/);
  });
});
