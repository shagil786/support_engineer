/** Offline end-to-end demo of the Support Voice Agent brain.
 *
 *  Run:  npm run demo          (interactive: type  speakerId: text  lines)
 *         npm run demo -- --script   (built-in scripted war-room scene)
 *
 *  Everything runs against in-process fakes (ScriptedBridge + fake Jira/
 *  Slack HTTP) — no credentials, no network. Real wiring replaces the fakes
 *  via configFromEnv()/createVoiceSession().
 */
import { createInterface } from 'node:readline';
import {
  SupportVoiceAgent,
  ScriptedBridge,
  createVoiceSession,
  InMemoryVectorMemory,
  InMemoryKeyValueStore,
  InMemoryRunbookProvider,
  SlackWebhookNotifier,
  SAMPLE_RUNBOOK_ACTIONS,
} from '../src/index';
import type { RunbookResult } from '../src/support-voice-agent/integrations/runbook';

/* ---------------- offline fake servers (no network ever) ---------------- */

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

let ticketCounter = 100;

const fakeJiraFetch: typeof fetch = (input, init) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  if (/\/issue\/SUPPORT-\d+\?fields/.test(url)) {
    return jsonResponse({ key: 'SUPPORT-7', fields: { summary: 'Checkout 500s', status: { name: 'In Progress' } } });
  }
  const key = `SUPPORT-${++ticketCounter}`;
  if (method === 'POST' && url.includes('/rest/api/3/issue') && !url.includes('comment')) {
    return jsonResponse({ key, id: String(ticketCounter), self: `https://jira.demo/browse/${key}` });
  }
  if (url.includes('/comment')) return jsonResponse({ id: 'c1' });
  if (/\/issue\/SUPPORT-\d+\?fields/.test(url)) {
    return jsonResponse({ key: 'SUPPORT-7', fields: { summary: 'Checkout 500s', status: { name: 'In Progress' } } });
  }
  return jsonResponse({ errorMessages: ['demo fake 404'], errors: {} }, 404);
};

const fakeSlackFetch: typeof fetch = (input, init) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  console.log(`   └─ [slack → #demo] ${String(body.text ?? '').slice(0, 120)}`);
  return jsonResponse({ ok: true });
};

/* ------------------------------ wiring ------------------------------ */

const clock = { now: 1_000_000 };
const bridge = new ScriptedBridge({ meetingId: 'demo-meeting', now: () => clock.now });

const agent = new SupportVoiceAgent({
  mode: 'response',
  wakeWord: 'hey agent',
  now: () => clock.now,
  jira: { baseUrl: 'https://jira.demo', auth: { type: 'bearer', token: 'demo' }, projectKey: 'SUPPORT', request: fakeJiraFetch },
  slack: new SlackWebhookNotifier({ webhookUrl: 'https://hooks.demo/slack', request: fakeSlackFetch }),
  runbooks: new InMemoryRunbookProvider(SAMPLE_RUNBOOK_ACTIONS, async (id): Promise<RunbookResult> => {
    console.log(`   ⚙ [runbook] executing '${id}'…`);
    return { actionId: id, ok: true, output: 'pod restarted, healthz green' };
  }),
  memory: { kv: new InMemoryKeyValueStore({ now: () => clock.now }), vectors: new InMemoryVectorMemory() },
});

const session = createVoiceSession(bridge, agent);

agent.on('speech', (e) => console.log(`\n🗣  AGENT${e.urgent ? ' [URGENT BARGE-IN]' : ''}: ${e.text}`));
agent.on('jira', (e) => console.log(`   📋 [jira] ${e.type} ${e.issueKey} — ${e.detail}`));
agent.on('muted', () => console.log('   🔇 [muted]'));
agent.on('log', (e) => { if (e.level !== 'info') console.log(`   · [${e.level}] ${e.message}`); });

/* ------------------------------- drive ------------------------------- */

const RUNBOOK_REQUEST = /\bcan you\b.*\brestart\b.*\b(checkout|payment|cache) pod\b/i;

async function say(speakerId: string, text: string): Promise<void> {
  clock.now += 4000; // advance virtual clock between turns
  console.log(`\n🎙  ${speakerId}: ${text}`);
  // Host-side intent routing (stand-in for the LLM router): a runbook request
  // enters the offer→confirm flow instead of the generic question path.
  const rb = text.match(RUNBOOK_REQUEST);
  if (rb) {
    const id = `restart-${(rb[1] as string).toLowerCase()}-pod`;
    console.log(`   · [host] routing runbook request → offer('${id}')`);
    await agent.offerRunbookAction(id);
    clock.now += 100;
    bridge.emitPause(1600);
    await new Promise((r) => setTimeout(r, 30));
    return;
  }
  bridge.emitTranscript(speakerId, text, clock.now);
  await new Promise((r) => setTimeout(r, 30));
  bridge.emitPause(1600); // everyone stops talking
  await new Promise((r) => setTimeout(r, 30));
}

async function scriptedScene(): Promise<void> {
  await say('U1', 'Users hate the new onboarding flow, it takes forever');
  await say('U2', 'yeah make it a high priority bug');
  await say('U1', "what's the status of SUPPORT-7?");
  await say('U2', 'hey agent, can you restart the checkout pod?');
  await say('U1', 'yes do it');
  console.log('\n🚨 [monitor] CloudWatch P1: payment-api returning 500s');
  agent.ingestAlert({ severity: 'P1', source: 'CloudWatch', summary: 'payment-api returning 500s', ts: clock.now });
  await new Promise((r) => setTimeout(r, 30));
  await say('U2', 'this is a P1');
  await say('U1', 'hey agent, shut up');
  await say('U2', 'what about the database?');
  await say('U1', 'hey agent, are we okay on disk space?');
  const summary = agent.finishMeeting({ title: 'Demo war room' });
  console.log(`\n📝 meeting summary captured: ${summary.feedback.length} feedback, ${summary.jiraChanges.length} Jira changes, ${summary.alerts.length} alerts, ${summary.spokenResponseCount} spoken lines (persisted to KV, never read aloud)`);
}

async function main(): Promise<void> {
  await session.start();
  console.log('=== Support Voice Agent — offline demo (fake Jira/Slack, no network) ===');
  console.log('Type lines as  speaker: text   — or: /script /summary /quit\n');

  if (process.argv.includes('--script')) {
    await scriptedScene();
    await session.stop();
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt('you> ');
  rl.prompt();
  rl.on('line', async (raw) => {
    const line = raw.trim();
    if (line === '/quit') { rl.close(); return; }
    if (line === '/script') { await scriptedScene(); rl.prompt(); return; }
    if (line === '/summary') {
      const s = agent.finishMeeting({ title: 'Interactive demo' });
      console.log(`📝 feedback=${s.feedback.length} jira=${s.jiraChanges.length} alerts=${s.alerts.length}`);
      rl.prompt(); return;
    }
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m) await say(m[1] as string, m[2] as string);
    else console.log('format: speaker: text  (or /script /summary /quit)');
    rl.prompt();
  });
  rl.on('close', async () => { await session.stop(); process.exit(0); });
}

void main();
