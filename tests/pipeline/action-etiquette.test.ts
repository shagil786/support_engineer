/**
 * The ActionEtiquetteStage: vague complaints and verbal feedback moved out
 * of the legacy cascade into a pipeline stage (two-brain consolidation,
 * pass two). Pinned semantics match the cascade (paraphrase → offer →
 * confirm/negate; complaints ask for specifics), with one deliberate
 * upgrade: the Jira filing now goes through GOVERNED dispatch — policy
 * engine, SafetyNet, and audit events — instead of the legacy agent's
 * direct, un-audited createIssue call.
 *
 * The confirm loop is state-driven like the cascade: "P2" classifies as
 * nothing useful, so the stage intercepts it while a filing is pending,
 * before routeIntent sends it to the legacy cascade as chatter.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeetingNotes } from '../../src/meeting/notes';
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
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'action-etiquette-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const defaultPolicyYaml = rf(join(process.cwd(), 'policies/default.yaml'), 'utf8');

function harness() {
  const spoken: string[] = [];
  const jiraCalls: Array<Record<string, unknown>> = [];
  const jiraClient = {
    async createIssue(opts: Record<string, unknown>) {
      jiraCalls.push(opts);
      return { key: 'SUP-7', self: 'https://jira.example/rest/api/2/issue/10001' };
    },
  };
  const notes = new MeetingNotes({ now: () => 1_000_000 });

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
    context: {
      runbookProvider,
      logProvider: { name: 'noop', query: async () => ({ provider: 'noop', rows: [], error: undefined }) },
      speak: (t) => spoken.push(t),
      jiraClient: jiraClient as never,
    },
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
    notes,
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
    now: () => 1_000_000,
  });

  return { pipeline, spoken, jiraCalls, eventLog };
}

const kinds = async (log: JsonlFileEventLog, cid: string): Promise<string[]> => {
  const out: string[] = [];
  for await (const e of log.query({ correlationId: cid })) out.push(e.kind);
  return out;
};

describe('ActionEtiquetteStage (pipeline-owned complaint/feedback)', () => {
  it('a verbal feedback offer paraphrases and asks about the bug; nothing is filed yet', async () => {
    const { pipeline, spoken, jiraCalls } = harness();
    const r = await pipeline.processUtterance('u1', 'the users hate the new dashboard');
    expect(r.routed).toBe('etiquette');
    expect(spoken.join('\n')).toContain('Should I create a Jira bug');
    expect(jiraCalls).toHaveLength(0);
  });

  it('a priority answer files through governed dispatch: policy + SafetyNet + audit events', async () => {
    const { pipeline, spoken, jiraCalls, eventLog } = harness();
    const offer = await pipeline.processUtterance('u1', 'the users hate the new dashboard');
    expect(offer.routed).toBe('etiquette');

    const filed = await pipeline.processUtterance('u1', 'P2');
    expect(filed.routed).toBe('pipeline');
    expect(filed.ok).toBe(true);
    expect(jiraCalls).toHaveLength(1);
    const args = jiraCalls[0]!;
    expect(args.summary).toBe('[Feedback] The users hate the new dashboard.');
    expect(args.issueType).toBe('Bug');
    expect(args.priority).toBe('Medium'); // P2 → jira name, same mapping as the legacy client
    expect(String(args.description)).toContain('From: u1');
    // The governance win: the filing is audited in the spine.
    expect(await kinds(eventLog, filed.correlationId)).toContain('governance');
    expect(spoken.join('\n')).toMatch(/filed/i);
  });

  it('a negation answer records the feedback without filing', async () => {
    const { pipeline, spoken, jiraCalls } = harness();
    await pipeline.processUtterance('u1', 'the users hate the new dashboard');
    const r = await pipeline.processUtterance('u1', 'no, never mind');
    expect(r.routed).toBe('etiquette');
    expect(jiraCalls).toHaveLength(0);
    expect(spoken.join('\n')).toContain("won't file");
  });

  it('a vague complaint asks for specifics and is recorded for the summary', async () => {
    const { pipeline, spoken } = harness();
    const r = await pipeline.processUtterance('u1', "it's down");
    expect(r.routed).toBe('etiquette');
    expect(spoken.join('\n')).toContain("Sounds like something's off");
  });

  it('unmatched chatter still reaches the legacy cascade', async () => {
    const { pipeline } = harness();
    const r = await pipeline.processUtterance('u1', 'nice weather today');
    expect(r.routed).toBe('legacy');
  });
});
