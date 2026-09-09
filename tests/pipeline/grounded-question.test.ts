import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OrchestratedPipeline } from '../../src/pipeline/agent-pipeline';
import { MeetingNotes } from '../../src/meeting/notes';
import { IntentClassifier } from '../../src/understanding/intent-classifier';
import { LegacyClassifierAdapter } from '../../src/understanding/legacy/classifier-adapter';
import { ContextAssembler } from '../../src/understanding/context-assembler';
import { EpisodicMemory } from '../../src/understanding/memory/episodic';
import { FileBackedKnowledgeBase } from '../../src/understanding/knowledge/knowledge-base';
import { GroundedAnswerer } from '../../src/understanding/grounded-answerer';
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
import { OpenAiCompatibleClient } from '../../src/support-voice-agent/tools/llm';
import { InMemoryRunbookProvider } from '../../src/support-voice-agent/integrations/runbook';
import { join as pathJoin } from 'node:path';

const rf = (p: string): string => readFileSync(p, 'utf8');
const defaultPolicyYaml = rf(pathJoin(process.cwd(), 'policies/default.yaml'));

let dir: string;
let eventsDir: string;
let outcomesDir: string;
const spoken: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gq-'));
  eventsDir = join(dir, 'events');
  outcomesDir = join(dir, 'outcomes');
  spoken.length = 0;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Opts {
  seedKb?: boolean;
  policyYaml?: string;
  classifierOverride?: IntentClassifier;
  deliver?: (text: string, target?: { channel: string; threadTs: string }) => void;
}

async function harness(opts: Opts = {}) {
  const eventLog = new JsonlFileEventLog({ baseDir: eventsDir });
  const llm = new OpenAiCompatibleClient({ baseUrl: '', apiKey: '', model: '' });
  const classifier = opts.classifierOverride ?? new IntentClassifier({ llm, fallback: new LegacyClassifierAdapter(), eventLog });
  const episodic = new EpisodicMemory({});
  const assembler = new ContextAssembler({ episodic });
  const policyEngine = new PolicyEngine({ yaml: opts.policyYaml ?? defaultPolicyYaml });
  const safetyNet = new SafetyNet({ speakers: () => 'admin' });
  const slack = {
    async postMessage(): Promise<void> {},
  };
  const approvals = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 2, eventLog });
  const logQueries: string[] = [];
  const logProvider = {
    name: 'fake',
    query: async (q: { query: string }) => {
      logQueries.push(q.query);
      return { provider: 'splunk', rows: [{ message: '502 spike' }], error: undefined };
    },
  };
  const runbookProvider = new InMemoryRunbookProvider([
    { id: 'restart-all', name: 'restart-all', description: 'restart the checkout pod', destructive: true },
  ]);
  const toolRunner = new ToolRunner({
    context: { runbookProvider, logProvider, speak: (t) => spoken.push(t) },
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
  const notes = new MeetingNotes({ now: () => 1_000_000 });
  mkdirSync(outcomesDir, { recursive: true });

  const knowledge = new FileBackedKnowledgeBase({ path: join(dir, 'kb.json') });
  if (opts.seedKb) {
    await knowledge.ingest({
      id: 'run-restart',
      text: '# Restart the checkout pod\nUse this runbook when the checkout service stops responding.',
      metadata: { source: 'runbooks' },
    });
    await knowledge.ingest({
      id: 'inc-42',
      text: 'Postmortem: the checkout timeout incident was caused by connection pool exhaustion.',
      metadata: { source: 'incidents' },
    });
  }
  const answerer = new GroundedAnswerer({ knowledge, llm });

  const pipeline = new OrchestratedPipeline({
    notes,
    classifier,
    assembler,
    policyEngine,
    safetyNet,
    approvals,
    supervisor,
    toolRunner,
    eventLog,
    outcomeRecorder: new OutcomeRecorder({ eventLog, outcomesDir }),
    runbookProvider,
    deliverSpeech: (text, target) => (opts.deliver ? opts.deliver(text, target) : spoken.push(text)),
    answerer,
    now: () => 1_000_000,
  });
  return { pipeline, eventLog, logQueries };}

const kinds = async (log: JsonlFileEventLog, cid: string): Promise<string[]> => {
  const out: string[] = [];
  for await (const e of log.query({ correlationId: cid })) out.push(e.kind);
  return out;
};

describe('thread-aware speech delivery', () => {
  it('a KB answer requested in a thread is delivered WITH the thread target', async () => {
    const delivered: Array<{ text: string; target?: { channel: string; threadTs: string } }> = [];
    const h = await harness({
      seedKb: true,
      deliver: (text, target) => delivered.push({ text, ...(target ? { target } : {}) }),
    });
    const r = await h.pipeline.processUtterance('U1', 'what caused the checkout incident?', 1_000, 'C-MEET', '1700000000.1');
    expect(r.answerSource).toBe('knowledge');
    expect(delivered.length).toBe(1);
    expect(delivered[0]!.target).toEqual({ channel: 'C-MEET', threadTs: '1700000000.1' });
  });

  it('a KB answer without a channel keeps the bare-text delivery shape', async () => {
    const delivered: Array<{ text: string; target?: { channel: string; threadTs: string } }> = [];
    const h = await harness({
      seedKb: true,
      deliver: (text, target) => delivered.push({ text, ...(target ? { target } : {}) }),
    });
    await h.pipeline.processUtterance('U1', 'what caused the checkout incident?', 1_000);
    expect(delivered.length).toBe(1);
    expect(delivered[0]!.target).toBeUndefined();
  });
});

describe('grounded question path', () => {
  it('live-data questions skip the KB entirely (a tangential chunk must not answer a logs question)', async () => {
    // Force the classifier's verdict: this is a live-data question.
    const eventLog0 = new JsonlFileEventLog({ baseDir: eventsDir });
    const llm0 = new OpenAiCompatibleClient({ baseUrl: '', apiKey: '', model: '' });
    const classifier = new IntentClassifier({ llm: llm0, fallback: new LegacyClassifierAdapter(), eventLog: eventLog0 });
    (classifier as unknown as { classify: unknown }).classify = async (input: unknown) => ({
      intent: { kind: 'meeting_response', subKind: 'question', liveData: true },
      confidence: 0.9,
      entities: {},
      rawContext: { source: 'meeting', ts: 500, payload: {} },
    });
    const { pipeline, eventLog, logQueries } = await harness({ seedKb: true, classifierOverride: classifier });
    // This question lexically overlaps the corpus ('checkout'), but asks for
    // CURRENT data — without the gate the KB answers it from the runbook chunk.
    const r = await pipeline.processUtterance('u1', 'agent, are there fresh checkout errors right now?', 500);
    expect(r.routed).toBe('pipeline');
    expect(r.answerSource).toBe('logs');
    expect(logQueries.length).toBe(1);
    const ks = await kinds(eventLog, r.correlationId);
    expect(ks).not.toContain('grounded_answer');
    expect(ks).toContain('tool_call');
  });

  // (the 'answers a KB-backed question directly' case below doubles as the
  // non-liveData pin: flag absent = KB-first unchanged)
  it('answers a KB-backed question directly: cited spoken answer, no tool dance', async () => {
    const { pipeline, eventLog } = await harness({ seedKb: true });
    const r = await pipeline.processUtterance('u1', 'agent, what do I do when the checkout service stops responding?', 500);
    expect(r.routed).toBe('pipeline');
    expect(r.ok).toBe(true);
    expect(r.answerSource).toBe('knowledge');
    expect(r.answer).toMatch(/checkout/i);
    expect(spoken).toContain(r.answer);

    // The answer IS the audit trail: a grounded_answer event, no tools ran.
    const ks = await kinds(eventLog, r.correlationId);
    expect(ks).toContain('grounded_answer');
    expect(ks).not.toContain('tool_call');
    expect(ks).not.toContain('agent_outcome');
  });

  it('falls through to the governed log query when the KB cannot answer', async () => {
    const { pipeline, eventLog, logQueries } = await harness({ seedKb: true });
    const r = await pipeline.processUtterance('u1', 'agent, can you check the error logs for the api?', 500);
    expect(r.routed).toBe('pipeline');
    expect(r.answerSource).toBe('logs');
    expect(logQueries.length).toBe(1);

    const ks = await kinds(eventLog, r.correlationId);
    expect(ks).toContain('governance');
    expect(ks).toContain('tool_call');
    expect(ks).not.toContain('grounded_answer');
  });

  it('keeps the legacy question behavior when no answerer is wired (backward compatible)', async () => {
    const eventLog = new JsonlFileEventLog({ baseDir: eventsDir });
    const llm = new OpenAiCompatibleClient({ baseUrl: '', apiKey: '', model: '' });
    const policyEngine = new PolicyEngine({ yaml: defaultPolicyYaml });
    const safetyNet = new SafetyNet({ speakers: () => 'admin' });
    const logProvider = { name: 'fake', query: async () => ({ provider: 'splunk', rows: [{ message: 'x' }], error: undefined }) };
    const runbookProvider = new InMemoryRunbookProvider([]);
    const toolRunner = new ToolRunner({ context: { runbookProvider, logProvider }, safetyNet, eventLog });
    const supervisor = new SupervisorAgent({
      triage: new TriageAgent({ llm }),
      investigator: new InvestigatorAgent({ llm }),
      executor: new ExecutorAgent({ llm }),
      reviewer: new ReviewerAgent({ llm }),
      toolRunner,
      eventLog,
    });
    const approvals = new ApprovalGate({ slack: { async postMessage(): Promise<void> {} }, securityChannel: '#sec', approverCount: 2, eventLog });
    mkdirSync(outcomesDir, { recursive: true });
    const pipeline = new OrchestratedPipeline({
      notes: new MeetingNotes({ now: () => 1_000_000 }),
      classifier: new IntentClassifier({ llm, fallback: new LegacyClassifierAdapter(), eventLog }),
      assembler: new ContextAssembler({ episodic: new EpisodicMemory({}) }),
      policyEngine,
      safetyNet,
      approvals,
      supervisor,
      toolRunner,
      eventLog,
      outcomeRecorder: new OutcomeRecorder({ eventLog, outcomesDir }),
      now: () => 1_000_000,
    });
    const r = await pipeline.processUtterance('u1', 'agent, can you check the error logs for the api?', 500);
    expect(r.routed).toBe('pipeline');
    expect(r.ok).toBe(true);
    // Provenance is now stamped even without an answerer: the floor flags
    // telemetry questions as live-data, and a skipped KB is a KB that did
    // not answer — the governed log query IS the answer source ('logs').
    // The governed run itself is unchanged (see the assertions below).
    expect(r.answerSource).toBe('logs');
    const files = readdirSync(outcomesDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(1); // the governed run was recorded
  });
});
