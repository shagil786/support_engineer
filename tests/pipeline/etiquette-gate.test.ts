/**
 * The EtiquetteGate: mute/wake moved out of the legacy cascade into a
 * pipeline-owned stage (two-brain consolidation, pass one). Pinned
 * semantics — identical outcomes to the legacy cascade's mute/wake steps,
 * but the mute STATE has one owner (the gate) in orchestrated mode:
 *
 *  - "agent, shut up" mutes in the pipeline; the legacy agent never sees it.
 *  - While muted, only the wake word gets through: bare wake greets,
 *    wake-wrapped content re-arms without being answered.
 *  - Mute expires after muteDurationMs.
 *  - Unmuted bare wake greets through the gate.
 *  - Non-etiquette utterances pass through untouched (routing unchanged).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SupportVoiceAgent } from '../../src/support-voice-agent/agent';
import { InMemoryRunbookProvider } from '../../src/support-voice-agent/integrations/runbook';
import { OpenAiCompatibleClient } from '../../src/support-voice-agent/tools/llm';
import { OrchestratedPipeline } from '../../src/pipeline/agent-pipeline';
import { LegacyClassifierAdapter } from '../../src/understanding/legacy/classifier-adapter';
import { IntentClassifier } from '../../src/understanding/intent-classifier';
import { EpisodicMemory } from '../../src/understanding/memory/episodic';
import { ContextAssembler } from '../../src/understanding/context-assembler';
import { PolicyEngine } from '../../src/governance/policy-engine';
import { SafetyNet } from '../../src/governance/safety-net';
import { ApprovalGate } from '../../src/governance/approval-gate';
import { SupervisorAgent } from '../../src/execution/supervisor';
import { ToolRunner } from '../../src/execution/tool-runner';
import { TriageAgent } from '../../src/execution/agents/triage';
import { InvestigatorAgent } from '../../src/execution/agents/investigator';
import { ExecutorAgent } from '../../src/execution/agents/executor';
import { ReviewerAgent } from '../../src/execution/agents/reviewer';
import { OutcomeRecorder } from '../../src/learning/outcome-recorder';
import { JsonlFileEventLog } from '../../src/event-log/log';
import { readFileSync as rf } from 'node:fs';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'etiquette-gate-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const defaultPolicyYaml = rf(join(process.cwd(), 'policies/default.yaml'), 'utf8');

function harness(opts: { muteDurationMs?: number } = {}) {
  const spoken: string[] = [];
  const legacyMuted: number[] = [];
  const legacy = new SupportVoiceAgent({
    mode: 'interrupt',
    runbooks: new InMemoryRunbookProvider([
      { id: 'clear-cache', name: 'clear-cache', description: 'clear the api cache', destructive: false },
    ]),
  });
  legacy.on('muted', (m) => legacyMuted.push(m.until));

  const eventLog = new JsonlFileEventLog({ baseDir: join(dir, 'events') });
  const llm = new OpenAiCompatibleClient({ baseUrl: '', apiKey: '', model: '' });
  const classifier = new IntentClassifier({ llm, fallback: new LegacyClassifierAdapter(), eventLog });
  const assembler = new ContextAssembler({ episodic: new EpisodicMemory({}) });
  const policyEngine = new PolicyEngine({ yaml: defaultPolicyYaml });
  const safetyNet = new SafetyNet({ speakers: () => 'admin' });
  const slack = { async postMessage() {} };
  const approvals = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 2, eventLog });
  const runbookProvider = new InMemoryRunbookProvider(
    [{ id: 'clear-cache', name: 'clear-cache', description: 'clear the api cache', destructive: false }],
    async (actionId) => ({ actionId, ok: true, output: `${actionId} done` }),
  );
  const toolRunner = new ToolRunner({
    context: { runbookProvider, logProvider: { name: 'noop', query: async () => ({ provider: 'noop', rows: [], error: undefined }) }, speak: (t) => spoken.push(t) },
    safetyNet,
    eventLog,
  });
  const supervisor = new SupervisorAgent({
    triage: new TriageAgent({ llm }),
    investigator: new InvestigatorAgent({ llm }),
    executor: new ExecutorAgent({ llm }),
    reviewer: new ReviewerAgent({ llm }),
    toolRunner,
    eventLog,
  });
  const outcomeRecorder = new OutcomeRecorder({ eventLog, outcomesDir: join(dir, 'outcomes') });

  const pipeline = new OrchestratedPipeline({
    legacy,
    classifier,
    assembler,
    policyEngine,
    safetyNet,
    approvals,
    supervisor,
    toolRunner,
    eventLog,
    outcomeRecorder,
    runbookProvider,
    deliverSpeech: (text) => spoken.push(text),
    ...(opts.muteDurationMs !== undefined ? { muteDurationMs: opts.muteDurationMs } : {}),
    now: () => 1_000_000,
  });

  return { pipeline, legacy, spoken, legacyMuted };
}

describe('EtiquetteGate (pipeline-owned mute/wake)', () => {
  it('mutes in the pipeline; the legacy cascade never learns of it', async () => {
    const { pipeline, legacy, legacyMuted } = harness();
    const r = await pipeline.processUtterance('u1', 'agent, shut up');
    expect(r.routed).toBe('etiquette');
    expect(r.ok).toBe(true);
    expect(legacy.isMuted(1_000_000)).toBe(false); // state stays out of the cascade
    expect(legacyMuted).toHaveLength(0);
  });

  it('a bare wake word while muted greets through the gate and re-arms', async () => {
    const { pipeline, spoken } = harness();
    await pipeline.processUtterance('u1', 'agent, shut up');
    const r = await pipeline.processUtterance('u1', 'hey agent');
    expect(r.routed).toBe('etiquette');
    expect(spoken).toContain("Yes, I'm here. What do you need?");
    // Re-armed: chatter reaches the legacy cascade again.
    const after = await pipeline.processUtterance('u1', 'nice weather today');
    expect(after.routed).toBe('legacy');
  });

  it('wake-wrapped content while muted re-arms without answering the muted utterance', async () => {
    const { pipeline, spoken } = harness();
    await pipeline.processUtterance('u1', 'agent, shut up');
    const r = await pipeline.processUtterance('u1', 'hey agent, what is the latency?');
    expect(r.routed).toBe('etiquette');
    expect(spoken).toHaveLength(0);
    // Re-armed: the next utterance is no longer swallowed by the mute.
    const after = await pipeline.processUtterance('u1', 'nice weather today');
    expect(after.routed).toBe('legacy');
  });

  it('non-wake content while muted is swallowed', async () => {
    const { pipeline, spoken } = harness();
    await pipeline.processUtterance('u1', 'agent, shut up');
    const r = await pipeline.processUtterance('u1', 'nice weather today');
    expect(r.routed).toBe('etiquette');
    expect(spoken).toHaveLength(0);
  });

  it('mute expires after muteDurationMs', async () => {
    const { pipeline } = harness({ muteDurationMs: 5_000 });
    await pipeline.processUtterance('u1', 'agent, shut up');
    // Advance past the mute window: the pipeline hands routing back to the cascade.
    const r = await pipeline.processUtterance('u1', 'nice weather today', 1_000_000 + 6_000);
    expect(r.routed).toBe('legacy');
  });

  it('an unmuted bare wake word greets through the gate', async () => {
    const { pipeline, spoken } = harness();
    const r = await pipeline.processUtterance('u1', 'hey agent');
    expect(r.routed).toBe('etiquette');
    expect(spoken).toContain("Yes, I'm here. What do you need?");
  });

  it('a critical declaration still routes to the legacy cascade (action path, not etiquette)', async () => {
    const { pipeline } = harness();
    const r = await pipeline.processUtterance('u1', 'this is a P1, checkout is down');
    expect(r.routed).toBe('legacy');
  });
});
