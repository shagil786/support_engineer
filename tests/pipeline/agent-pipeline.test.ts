import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeetingNotes } from '../../src/meeting/notes';
import { InMemoryRunbookProvider } from '../../src/support-voice-agent/integrations/runbook';
import { FileBackedKnowledgeBase } from '../../src/understanding/knowledge/knowledge-base';
import { runbookToDoc } from '../../src/bootstrap/runbooks-kb';
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
import { parseJiraWebhook } from '../../src/surface/async/jira-webhook';
import { anomalyToEnvelope } from '../../src/surface/proactive/anomaly-detector';
import { readFileSync as rf } from 'node:fs';

let dir: string;
let eventsDir: string;
let outcomesDir: string;

const defaultPolicyYaml = rf(join(process.cwd(), 'policies/default.yaml'), 'utf8');
const allowAllYaml = 'rules:\n  - id: allow_all\n    when:\n      tools_in: [query_logs, execute_runbook_script, jira_create_issue, meeting_interrupt, invoke_human_on_slack]\n    effect: allow\n';

const spoken: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pipeline-'));
  eventsDir = join(dir, 'events');
  outcomesDir = join(dir, 'outcomes');
  spoken.length = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface HarnessOptions {
  policyYaml?: string;
  safetyNetSpeakers?: (id: string) => 'admin' | 'engineer' | 'viewer' | 'guest' | undefined;
  llm?: OpenAiCompatibleClient;
  logProvider?: { name: string; query: (q: unknown) => Promise<{ provider: string; rows: Array<{ message: string }>; error?: string }> };
}

function harness(opts: HarnessOptions = {}) {
  const runbookRuns: string[] = [];
  const logProvider = opts.logProvider ?? {
    name: 'noop',
    query: async () => ({ provider: 'noop', rows: [] as Array<{ message: string }>, error: undefined }),
  };
  const notes = new MeetingNotes({ now: () => 1_000_000 });

  const eventLog = new JsonlFileEventLog({ baseDir: eventsDir });
  const llm = opts.llm ?? new OpenAiCompatibleClient({ baseUrl: '', apiKey: '', model: '' });
  const classifier = new IntentClassifier({
    llm,
    fallback: new LegacyClassifierAdapter(),
    eventLog,
  });
  const assembler = new ContextAssembler({ episodic: new EpisodicMemory({}) });
  const policyEngine = new PolicyEngine({ yaml: opts.policyYaml ?? defaultPolicyYaml });
  const safetyNet = new SafetyNet({ speakers: opts.safetyNetSpeakers ?? (() => 'admin') });
  const slack = {
    posted: [] as Array<{ channel: string; text: string }>,
    async postMessage(channel: string, text: string) {
      this.posted.push({ channel, text });
    },
  };
  const approvals = new ApprovalGate({ slack, securityChannel: '#sec', approverCount: 2, eventLog });
  const runbookActions = [
    { id: 'restart-all', name: 'restart-all', description: 'restart the checkout pod', destructive: true },
    { id: 'clear-cache', name: 'clear-cache', description: 'clear the api cache', destructive: false },
    { id: 'db-failover', name: 'Database failover', description: 'fail the database over to the standby replica', destructive: true },
  ];
  const runbookProvider = new InMemoryRunbookProvider(runbookActions, async (actionId) => {
    runbookRuns.push(actionId);
    return { actionId, ok: true, output: `${actionId} done` };
  });
  // Tier-3 resolution uses the real hybrid scorer over the catalog's KB docs
  // (same wiring as production bootstrap).
  const runbookKb = new FileBackedKnowledgeBase({ path: join(dir, 'runbook-kb.json') });
  for (const a of runbookActions) runbookKb.ingest(runbookToDoc(a));
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
  const outcomeRecorder = new OutcomeRecorder({ eventLog, outcomesDir });

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
    runbookKnowledge: runbookKb,
    deliverSpeech: (text) => spoken.push(text),
    now: () => 1_000_000,
  });

  return { pipeline, notes, eventLog, outcomesDir, slack, runbookRuns };
}

const kinds = async (log: JsonlFileEventLog, cid: string): Promise<string[]> => {
  const out: string[] = [];
  for await (const e of log.query({ correlationId: cid })) out.push(e.kind);
  return out;
};

describe('OrchestratedPipeline', () => {
  it('talk-permission (mute) is owned by the pipeline gate', async () => {
    const { pipeline } = harness();
    const r = await pipeline.processUtterance('u1', 'agent, shut up');
    expect(r.routed).toBe('etiquette');
    // One owner: the gate holds the state, queryable on the pipeline.
    expect(pipeline.isMuted(1_000_000)).toBe(true);
  });

  it('routes unknown chatter to the legacy cascade', async () => {
    const { pipeline } = harness();
    const r = await pipeline.processUtterance('u1', 'nice weather today');
    expect(r.routed).toBe('legacy');
  });

  it('runs a governed log question through the full pipeline', async () => {
    const logProvider = {
      name: 'fake',
      query: async () => ({ provider: 'splunk', rows: [{ message: '502 spike' }], error: undefined }),
    };
    const { pipeline, eventLog, outcomesDir } = harness({ logProvider });
    const r = await pipeline.processUtterance('u1', 'agent, can you check the error logs for the api?', 500);
    expect(r.routed).toBe('pipeline');
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const ks = await kinds(eventLog, r.correlationId);
    expect(ks).toContain('understanding');
    expect(ks).toContain('governance');
    expect(ks).toContain('tool_call');
    expect(ks).toContain('agent_outcome');

    // Outcome persisted by the recorder.
    const files = readdirSync(outcomesDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(1);
    const rec = JSON.parse(readFileSync(join(outcomesDir, files[0] ?? ''), 'utf8')) as { finalResult?: { ok: boolean } };
    expect(rec.finalResult?.ok).toBe(true);
  });

  it('sends a destructive runbook offer through approval, then executes on grant', async () => {
    const { pipeline, slack, runbookRuns } = harness();
    const r = await pipeline.processUtterance('admin1', 'agent, can you restart the checkout pod?', 500);
    expect(r.routed).toBe('pipeline');
    expect(r.approvalId).toBeDefined();
    expect(r.approvalStatus).toBe('pending');
    expect(slack.posted).toHaveLength(1);
    expect(runbookRuns).toEqual([]); // nothing executed yet

    // Two admin signatures grant it; then the host re-dispatches.
    pipeline.signApprovalAs(r.approvalId ?? '', 'signer-1');
    const signed = pipeline.signApprovalAs(r.approvalId ?? '', 'signer-2');
    expect(signed.status).toBe('granted');

    const done = await pipeline.executeApproved(r.approvalId ?? '', 'admin1');
    expect(done.ok).toBe(true);
    expect(runbookRuns).toEqual(['restart-all']);
  });

  it('a destructive offer from a non-approver stays pending; deny comes from policy', async () => {
    const { pipeline } = harness();
    const r = await pipeline.processUtterance('intern1', 'agent, can you restart the checkout pod?', 500);
    expect(r.approvalStatus).toBe('pending');
    // Non-admin signature cannot grant: signatures dedupe by identity and
    // M-of-N needs two.
    expect(pipeline.signApprovalAs(r.approvalId ?? '', 'signer-1').status).toBe('pending');
  });

  it('executes a non-destructive runbook offer directly', async () => {
    const { pipeline, runbookRuns } = harness();
    const r = await pipeline.processUtterance('u1', 'agent, can you clear the api cache?', 500);
    expect(r.routed).toBe('pipeline');
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(runbookRuns).toEqual(['clear-cache']);
  });

  it('stages governed approvals from the deterministic floor while the provider is 429-saturated', async () => {
    const saturated = new OpenAiCompatibleClient({
      baseUrl: 'https://api.test/v1',
      apiKey: 'k',
      model: 'm',
      request: (() =>
        Promise.resolve(
          new Response('rate limited', { status: 429, headers: { 'content-type': 'text/plain' } }),
        )) as typeof fetch,
      maxRetries: 0,
      retryBackoffMs: 1,
    });
    const { pipeline, eventLog } = harness({ llm: saturated });

    // Before the fix, this exact scenario 500'd: the transport error
    // propagated out of classification and the pipeline hard-failed the
    // utterance ("pipeline failed: LLM HTTP 429") even though a safe floor
    // existed. Now: floor classification → governed staging.
    const r = await pipeline.processUtterance('u1', 'agent, can you restart the checkout pod?', 500);
    expect(r.routed).toBe('pipeline');
    expect(r.approvalId, JSON.stringify(r)).toBeDefined();
    expect(r.approvalStatus).toBe('pending');
    // Provenance on the spine: the understanding event shows the floor
    // served the request AND WHY (via:http_error), joined by correlation id.
    const ks = await kinds(eventLog, r.correlationId);
    expect(ks).toContain('understanding');
    let understanding: { contextBundleRef?: string } | undefined;
    for await (const e of eventLog.query({ correlationId: r.correlationId })) {
      if (e.kind === 'understanding') understanding = e as unknown as { contextBundleRef?: string };
    }
    expect(understanding?.contextBundleRef).toBe('via:http_error');
  });

  it('stages a failover phrasing through the LLM-less floor (widened verb family)', async () => {
    // The no-LLM walkthrough path: "fail ... over" is floor-reachable, and
    // the KB resolver maps it to a destructive action — which must stage
    // for approval, never execute.
    const { pipeline, runbookRuns } = harness();
    const r = await pipeline.processUtterance(
      'u1',
      'agent, please fail the primary database over to the standby now',
      500,
    );
    expect(r.routed, JSON.stringify(r)).toBe('pipeline');
    expect(r.approvalId, JSON.stringify(r)).toBeDefined();
    expect(r.approvalStatus).toBe('pending');
    expect(runbookRuns).toEqual([]);
  });

  it('still speaks an honest failure when a genuine (non-provider) bug breaks the pipeline', async () => {
    const bugLlm: OpenAiCompatibleClient = {
      isWired: () => true,
      complete: () => Promise.reject(new Error('TypeError: wiring bug')),
    } as unknown as OpenAiCompatibleClient;
    const { pipeline } = harness({ llm: bugLlm });

    const r = await pipeline.processUtterance('u1', 'agent, can you check the error logs for the api?', 500);
    expect(r.routed).toBe('legacy');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/pipeline failed/);
    // The speaker is told, not left hanging — no ungoverned second brain.
    expect(spoken.join(' ')).toContain("couldn't process");
  });

  it('safety-net vetoes beat an allow-everything policy', async () => {
    const { pipeline, eventLog } = harness({
      policyYaml: allowAllYaml,
      safetyNetSpeakers: () => 'guest',
    });
    const r = await pipeline.processUtterance('guest1', 'agent, can you restart the checkout pod?', 500);
    expect(r.routed).toBe('pipeline');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/veto/i);
    const ks = await kinds(eventLog, r.correlationId);
    expect(ks).toContain('safety_net');
  });

  it('accepts webhook envelopes: P1 anomaly speaks an interrupt through the pipeline', async () => {
    const { pipeline } = harness();
    const env = anomalyToEnvelope({ severity: 'P1', summary: 'error rate spike on checkout', source: 'cloudwatch', ts: 1 });
    const r = await pipeline.processEnvelope(env, { tool: 'meeting_interrupt', args: { message: 'P1: error rate spike on checkout' } });
    expect(r.routed).toBe('pipeline');
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(spoken.join(' ')).toContain('urgent alert');
  });

  it('accepts async jira webhook envelopes and records the decision', async () => {
    const { pipeline, eventLog } = harness();
    const env = parseJiraWebhook({ webhookEvent: 'jira:issue_created', issue: { key: 'SUPPORT-9', fields: { summary: 'down' } } });
    expect(env).toBeDefined();
    const r = await pipeline.processEnvelope(env!, { tool: 'query_logs', args: { query_string: 'SUPPORT-9' } });
    expect(r.routed).toBe('pipeline');
    const ks = await kinds(eventLog, r.correlationId);
    expect(ks).toContain('governance');
    expect(ks).toContain('tool_call');
  });
});
