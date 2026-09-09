#!/usr/bin/env node
/** llm-chaos-probe — scheduled failure injection for the LLM degradation ladder.
 *
 *  Boots the REAL platform against a local, deliberately broken provider and
 *  asserts the ladder's contract end to end (the same wiring serve.ts uses;
 *  only the provider endpoint is fake):
 *
 *    S1 saturate   every completion answers 429 → the retry ladder exhausts
 *                  (via:http_error), the saturation breaker trips
 *                  (via:circuit_open), and utterances STILL complete through
 *                  the deterministic floor — saturation costs fidelity, not
 *                  availability.
 *    S2 recover    the provider heals → the half-open probe succeeds, the
 *                  breaker resets, and the LLM path is live again
 *                  (via:llm on the spine; usedLlm on /ask).
 *    S3 drop       the provider destroys connections → network faults
 *                  (via:network) and the floor still serves the utterance.
 *
 *  Evidence comes from outcomes and the audit spine (understanding events'
 *  contextBundleRef), not from unit seams — this is the probe that would
 *  have caught "pipeline failed: LLM HTTP 429" the day it shipped.
 *
 *    npm run probe:llm-chaos           # realistic ladder (~15s)
 *    npm run probe:llm-chaos -- --quick  # short ladder + fast breaker (~3s)
 *
 *  Exit 0 = every check passed; exit 1 = a check failed (cron/CI gate).
 *  Schedule it every 15 minutes:
 *    "cd /srv/agent && npm run probe:llm-chaos -- --quick"
 */
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform, type Platform } from '../src/bootstrap.js';
import type { RunbookAction } from '../src/support-voice-agent/integrations/runbook.js';

/** Provider mode: what the fake does with the next completion request. */
type ProviderMode = 'saturate' | 'recover' | 'drop';

interface Check {
  name: string;
  ok: boolean;
  evidence: string;
}

const checks: Check[] = [];
function check(name: string, ok: boolean, evidence: string): void {
  checks.push({ name, ok, evidence });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${evidence}`);
}

const CATALOG: RunbookAction[] = [
  { id: 'restart-payment-pod', name: 'Restart payment pod', description: 'restart the payment pod', destructive: false },
  { id: 'db-failover', name: 'Database failover', description: 'fail the database over to the standby replica', destructive: true },
];

/** The fake OpenAI-compatible provider. `mode` is flipped between phases. */
function startBrokenProvider(): Promise<{ server: Server; url: string; setMode(m: ProviderMode): void }> {
  let mode: ProviderMode = 'saturate';
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c));
    req.on('end', () => {
      if (mode === 'drop') {
        req.socket.destroy();
        return;
      }
      if (mode === 'saturate') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' });
        res.end(JSON.stringify({ error: { message: 'all replicas at capacity', type: 'rate_limit' } }));
        return;
      }
      // recover: a valid completion. Two shapes, by system prompt:
      //  - classification prompts ("You classify support-engineer inputs")
      //    get an intent envelope;
      //  - everything else (grounded-answer synthesis, supervisor agents)
      //    gets a plain context-grounded answer, so /ask's claim judge can
      //    verify it against the retrieved catalog chunk.
      let parsed: { messages?: Array<{ content?: string }> } = {};
      try {
        parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> };
      } catch {
        parsed = {};
      }
      const system = parsed.messages?.[0]?.content ?? '';
      const user = parsed.messages?.[parsed.messages.length - 1]?.content ?? '';
      let content: string;
      if (system.includes('You classify')) {
        const envelope = /restart|failover/i.test(user)
          ? { intent: { kind: 'meeting_response', subKind: 'runbook_offer' }, confidence: 0.97, entities: {}, rawContext: { source: 'meeting', ts: 1, payload: {} } }
          : { intent: { kind: 'meeting_response', subKind: 'question' }, confidence: 0.93, entities: { ticketKeys: ['SUPPORT-7'] }, rawContext: { source: 'meeting', ts: 1, payload: {} } };
        content = JSON.stringify(envelope);
      } else if (system.includes('You verify whether a CLAIM')) {
        // Claim judge: a supported verdict (the fake's answers quote the
        // catalog context verbatim). An invalid verdict fails CLOSED — the
        // answerer drops to the extractive floor — so this must be valid.
        content = JSON.stringify({ verdict: 'supported' });
      } else {
        // Grounded synthesis: the answerer's schema requires JSON with at
        // least one valid citation, else it falls back to the extractive
        // floor. The answer quotes the catalog chunk so the claim judge's
        // entailed-verdict is truthful.
        content = JSON.stringify({
          answer: 'Restart the payment pod using the runbook action with action id restart-payment-pod. This action is non-destructive.',
          citations: [1],
        });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'cmpl-chaos',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 40, completion_tokens: 30 },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/v1`, setMode: (m) => (mode = m) });
    });
  });
}

/** Read every understanding event recorded on the spine so far. */
interface SpineEvent {
  kind: string;
  correlationId: string;
  contextBundleRef?: string;
}

function readSpine(dataDir: string): SpineEvent[] {
  const eventsDir = join(dataDir, 'events');
  let files: string[] = [];
  try {
    files = readdirSync(eventsDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const out: SpineEvent[] = [];
  for (const f of files) {
    for (const line of readFileSync(join(eventsDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as SpineEvent;
        if (e.kind === 'understanding') out.push(e);
      } catch {
        // torn tail line mid-write: skip
      }
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runProbe(quick: boolean): Promise<boolean> {
  const dataDir = mkdtempSync(join(tmpdir(), 'llm-chaos-'));
  const { server, url, setMode } = await startBrokenProvider();
  let platform: Platform | undefined;
  try {
    // Realistic ladder by default (2 retries, 500ms base — the production
    // shape); --quick shortens it for CI cadence. The breaker's threshold
    // and cooldown are tightened in both modes so the probe stays minutes-
    // free while exercising the same trip/half-open/reset mechanics.
    platform = createPlatform({
      dataDir,
      llm: {
        baseUrl: url,
        apiKey: 'probe-key',
        model: 'chaos-model',
        ...(quick ? { maxRetries: 0, retryBackoffMs: 1 } : {}),
        breakerThreshold: 2,
        breakerBaseCooldownMs: quick ? 400 : 2_000,
      },
      runbooks: CATALOG,
      speakerRole: (id) => (id === 'probe-admin' ? 'admin' : undefined),
      deliverSpeech: (text) => console.log(`    [speech] ${text}`),
    });
    await platform.ready();
    const utter = (text: string) => platform!.pipeline.processUtterance('probe-admin', text);
    const via = () => readSpine(dataDir).map((e) => e.contextBundleRef ?? '');

    console.log('S1: provider saturated (every completion 429s)');
    setMode('saturate');
    let sawHttpError = false;
    let sawCircuitOpen = false;
    const saturationUtterances = quick ? 2 : 4;
    for (let i = 0; i < saturationUtterances; i++) {
      const r = await utter('please restart the payment pod now');
      const served = r.routed === 'pipeline' && (r.ok === true || r.approvalId !== undefined);
      check(
        `saturation: utterance ${i + 1} still completes through the floor`,
        served,
        JSON.stringify({ routed: r.routed, ok: r.ok, reason: r.reason }),
      );
    }
    const refs = via();
    sawHttpError = refs.includes('via:http_error');
    sawCircuitOpen = refs.includes('via:circuit_open');
    check('saturation: ladder exhaustion recorded as via:http_error', sawHttpError, `${refs.filter((r) => r === 'via:http_error').length} event(s)`);
    check('saturation: open breaker recorded as via:circuit_open', sawCircuitOpen, `${refs.filter((r) => r === 'via:circuit_open').length} event(s)`);
    const neverSilent = via().length >= saturationUtterances;
    check('saturation: every classification carries provenance (nothing silent)', neverSilent, `${via().length} understanding event(s) for ${saturationUtterances} utterance(s)`);

    console.log('S2: provider recovers');
    setMode('recover');
    await sleep(quick ? 600 : 2_400); // breaker cooldown → half-open probe
    await utter('please restart the payment pod now');
    const recovered = via().includes('via:llm');
    check('recovery: breaker reset, LLM ceiling serving again (via:llm)', recovered, 'half-open probe succeeded after cooldown');
    const ask = await platform.answerer.answer('how do I restart the payment pod?', {});
    check('recovery: /ask verified by the live LLM again', ask.usedLlm === true, `usedLlm=${String(ask.usedLlm)}`);

    console.log('S3: provider drops connections mid-request');
    setMode('drop');
    const r3 = await utter('please restart the payment pod now');
    const served3 = r3.routed === 'pipeline' && (r3.ok === true || r3.approvalId !== undefined);
    check('network drop: utterance still completes through the floor', served3, JSON.stringify({ routed: r3.routed, ok: r3.ok, reason: r3.reason }));
    check('network drop: fault recorded as via:network', via().includes('via:network'), 'spine provenance');

    console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
    return checks.every((c) => c.ok);
  } finally {
    platform?.stopLearning();
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const quick = process.argv.includes('--quick');
console.log(`llm-chaos-probe (${quick ? 'quick' : 'realistic'} ladder)`);
runProbe(quick)
  .then((ok) => {
    console.log(ok ? 'PROBE PASSED' : 'PROBE FAILED');
    process.exit(ok ? 0 : 1);
  })
  .catch((e) => {
    console.error('probe crashed:', e instanceof Error ? e.stack : e);
    process.exit(1);
  });
