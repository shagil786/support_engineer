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

/** Ten-action catalog shaped like a real one: sibling pod restarts (the
 *  mix-up family), a destructive drill, a cache flush, a frontend rollout,
 *  plus one action per verb the deterministic classifier now claims
 *  (promote/drain/rotate/flush/scale) — the band pin travels with the
 *  floor's claim surface. */
const CATALOG: RunbookAction[] = [
  { id: 'restart-checkout-pod', name: 'Checkout pod restart', description: 'restart the checkout pod', destructive: false },
  { id: 'restart-payment-pod', name: 'Payment pod restart', description: 'restart the payment pod', destructive: false },
  { id: 'db-restart-drill', name: 'Database restart drill', description: 'restart the primary database', destructive: true },
  { id: 'clear-api-cache', name: 'API cache flush', description: 'clear the api cache', destructive: false },
  { id: 'redeploy-web-frontend', name: 'Web frontend rollout', description: 'redeploy the web frontend', destructive: false },
  { id: 'promote-db-replica', name: 'Database replica promotion', description: 'promote the standby replica to primary', destructive: true },
  { id: 'drain-conn-pool', name: 'Connection pool drain', description: 'drain and restart the connection pool', destructive: true },
  { id: 'rotate-tls-cert', name: 'TLS cert rotation', description: 'rotate the TLS certificate on the gateway', destructive: false },
  { id: 'flush-session-cache', name: 'Session cache flush', description: 'flush the user session cache', destructive: false },
  { id: 'scale-worker-pool', name: 'Worker pool scale-up', description: 'scale the worker pool up to the next tier', destructive: false },
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
  { id: 'wrong-billing-frontend', query: 'please redeploy the billing frontend now', max: RUNBOOK_BANDS.strong, where: whereRunbooks },
  // A synonym-verb match, pinned as TRUE: with flush-session-cache in the
  // catalog, "clear the user session cache" scores 1.138 against it (clear ≈
  // flush, same noun phrase) — confident resolution of a non-destructive
  // action is the designed behavior. Without that action in the catalog the
  // same query measures 0.82 and refuses; the pin travels with the catalog.
  { id: 'true-clear-synonym', query: 'please clear the user session cache now', targetDocId: 'runbook:flush-session-cache', min: RUNBOOK_BANDS.strong, where: whereRunbooks },
  // UNRELATED chatter: the top hit must stay below the floor — no least-bad
  // guess.
  { id: 'unrelated-ticket', query: 'what is the status of SUPPORT-7', max: RUNBOOK_BANDS.floor, where: whereRunbooks },
  { id: 'unrelated-oncall', query: 'who is on call this week', max: RUNBOOK_BANDS.floor, where: whereRunbooks },
  { id: 'unrelated-summary', query: 'can you summarize the meeting', max: RUNBOOK_BANDS.floor, where: whereRunbooks },
  // Sub-strong destructive: must stay at-or-above the floor so the
  // destructive staging rung still catches it (the gate decides).
  { id: 'substrong-failover', query: 'please failover the database now', targetDocId: 'runbook:db-restart-drill', min: RUNBOOK_BANDS.floor, where: whereRunbooks },
  // New verb family (floor now claims promote/drain/rotate/flush/scale).
  // Measured on the live engine: rotate/flush/scale clear the strong band;
  // drain clears it; promote measures 1.044 — below strong, overlapping the
  // wrong-winner band — so it is pinned as the destructive staging rung's
  // living case: sub-strong + destructive top candidate resolves into
  // approval, never auto-execution.
  { id: 'true-rotate', query: 'please rotate the TLS cert', targetDocId: 'runbook:rotate-tls-cert', min: RUNBOOK_BANDS.strong, where: whereRunbooks },
  { id: 'true-flush', query: 'would you flush the user session cache', targetDocId: 'runbook:flush-session-cache', min: RUNBOOK_BANDS.strong, where: whereRunbooks },
  { id: 'true-scale', query: 'please scale the worker pool up', targetDocId: 'runbook:scale-worker-pool', min: RUNBOOK_BANDS.strong, where: whereRunbooks },
  { id: 'true-drain', query: 'could you drain the connection pool', targetDocId: 'runbook:drain-conn-pool', min: RUNBOOK_BANDS.strong, where: whereRunbooks },
  { id: 'substrong-destructive-promote', query: 'can you promote the standby to primary', targetDocId: 'runbook:promote-db-replica', min: RUNBOOK_BANDS.floor, max: RUNBOOK_BANDS.strong, where: whereRunbooks },
  // Wrong winners for the new family: near-miss phrasings stay sub-strong.
  { id: 'wrong-billing-drain', query: 'could you drain the billing pool', max: RUNBOOK_BANDS.strong, where: whereRunbooks },
  { id: 'wrong-app-cert-rotate', query: 'please rotate the app signing cert', max: RUNBOOK_BANDS.strong, where: whereRunbooks },
  { id: 'wrong-batch-scale', query: 'please scale the batch workers up', max: RUNBOOK_BANDS.strong, where: whereRunbooks },
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
