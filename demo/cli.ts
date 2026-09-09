/** Offline end-to-end demo of the Support Voice Agent platform.
 *
 *  Run:  npm run demo          (interactive: type  speakerId: text  lines)
 *         npm run demo -- --script   (built-in scripted war-room scene)
 *
 *  One brain, driven like production: every utterance — scripted or typed —
 *  enters through platform.pipeline.processUtterance, the same entry the
 *  HTTP surface uses. Mute and feedback are pipeline-owned (a mute silences
 *  KB answers too; confirmed feedback files through governed dispatch).
 *  The legacy agent remains the meeting-summary data owner, handles critical
 *  declarations, and serves as the honest-degradation fallback. All
 *  integrations run against in-process fakes — no credentials, no network.
 */
import { createInterface } from 'node:readline';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlatform } from '../src/bootstrap';
import { SAMPLE_RUNBOOK_ACTIONS } from '../src/index';
import { FileBackedKnowledgeBase } from '../src/understanding/knowledge/knowledge-base';
import type { IngestDoc } from '../src/understanding/knowledge/chunker';

/* --------------------------- knowledge corpus --------------------------- */

/** Seed the demo knowledge corpus (examples/knowledge/*.md — the canonical
 *  first-run set, shared with container deployments) into the platform's
 *  durable hybrid knowledge base — BM25 + vector hybrid retrieval, markdown-
 *  section chunking, provenance metadata. Ingest is replace-by-doc-id, so a
 *  doc removed from the corpus is evicted explicitly — the KB never answers
 *  from a stale demo file. The snapshot persists under demo/.demo-kb/
 *  (gitignored), so a second boot reloads instead of re-chunking. */
const DEMO_ROOT = dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = join(DEMO_ROOT, '..', 'examples', 'knowledge');
const DEMO_KB_PATH = join(DEMO_ROOT, '.demo-kb', 'kb.json');
const DEMO_DATA_DIR = join(DEMO_ROOT, '.demo-data');

async function seedKnowledge(kb: FileBackedKnowledgeBase): Promise<number> {
  let files: string[] | undefined;
  try {
    files = readdirSync(KNOWLEDGE_DIR).filter((f) => f.endsWith('.md')).sort();
  } catch {
    console.log('📚 knowledge: examples/knowledge/ not found — running without notes');
  }
  // The KB mirrors the corpus: docs that left it (or all of them, when the
  // corpus directory is gone) are evicted — the durable snapshot must never
  // answer from notes that no longer exist.
  const wanted = new Set((files ?? []).map((f) => f.replace(/\.md$/, '')));
  for (const docId of kb.docIds()) {
    if (!wanted.has(docId)) await kb.deleteDoc(docId);
  }
  if (!files) return 0;
  for (const f of files) {
    const doc: IngestDoc = {
      id: f.replace(/\.md$/, ''),
      text: readFileSync(join(KNOWLEDGE_DIR, f), 'utf8'),
      metadata: { source: 'examples-knowledge' },
    };
    await kb.ingest(doc);
  }
  return kb.size();
}

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
  return jsonResponse({ errorMessages: ['demo fake 404'], errors: {} }, 404);
};

/* ------------------------------ wiring ------------------------------ */

const clock = { now: 1_000_000 };

const platform = createPlatform({
  dataDir: DEMO_DATA_DIR,
  now: () => clock.now,
  jira: { baseUrl: 'https://jira.demo', auth: { type: 'bearer', token: 'demo' }, projectKey: 'SUPPORT', request: fakeJiraFetch },
  runbooks: SAMPLE_RUNBOOK_ACTIONS,
  speakerRole: (id) => (id === 'U1' || id === 'U2' ? 'admin' : undefined),
  deliverSpeech: (text) => console.log(`\n🗣  AGENT: ${text}`),
});


/* ------------------------------- drive ------------------------------- */

/** Every utterance — scripted or interactive — enters through the platform
 *  pipeline, the same entry the HTTP surface uses. Mute and feedback are
 *  pipeline-owned: "agent, shut up" silences KB answers too, and confirmed
 *  feedback files through governed dispatch (policy → SafetyNet → audit). */
async function say(speakerId: string, text: string): Promise<void> {
  clock.now += 4000; // advance virtual clock between turns
  console.log(`\n🎙  ${speakerId}: ${text}`);
  const r = await platform.pipeline.processUtterance(speakerId, text, clock.now, 'demo-war-room');
  if (r.routed === 'pipeline') {
    console.log(`   · [pipeline] ok=${String(r.ok)}${r.reason ? ` — ${r.reason}` : ''}${r.approvalId ? ` approvalId=${r.approvalId}` : ''}`);
  } else if (r.routed === 'etiquette') {
    console.log(`   · [etiquette·pipeline] ${r.reason ?? 'handled'}`);
  } else {
    console.log('   · [legacy] handled by the etiquette cascade');
  }
  await new Promise((res) => setTimeout(res, 30));
}

async function scriptedScene(): Promise<void> {
  await say('U1', 'Users hate the new onboarding flow, it takes forever');
  await say('U2', 'yeah make it a high priority bug');
  await say('U1', 'hey agent, what did the cache incident postmortem conclude?');
  await say('U2', 'hey agent, what is the status of SUPPORT-7?');
  await say('U2', 'hey agent, can you restart the checkout pod?');
  console.log('\n🚨 [monitor] CloudWatch P1: payment-api returning 500s');
  platform.urgency.ingestAlert({ severity: 'P1', source: 'CloudWatch', summary: 'payment-api returning 500s', ts: clock.now });
  await new Promise((r) => setTimeout(r, 30));
  await say('U2', 'this is a P1');
  await say('U1', 'hey agent, what do we do when the database is unreachable?');
  await say('U1', 'hey agent, are we okay on disk space?');
  await say('U1', 'hey agent, shut up');
  await say('U2', 'what about the database?');
  await say('U1', 'hey agent');
  const summary = platform.notes.finishMeeting({ title: 'Demo war room' });
  console.log(`\n📝 meeting summary captured: ${summary.feedback.length} feedback, ${summary.jiraChanges.length} Jira changes, ${summary.alerts.length} alerts (never read aloud)`);
}

async function main(): Promise<void> {
  const chunks = await seedKnowledge(platform.knowledge);
  console.log(`📚 knowledge: ${chunks} chunks seeded from examples/knowledge/*.md`);
  await platform.ready();
  console.log('=== Support Voice Agent — offline demo (one pipeline brain, fake Jira/Slack, no network) ===');
  console.log('Type lines as  speaker: text   — or: /script /summary /quit (or restart with --script)\n');

  if (process.argv.includes('--script')) {
    await scriptedScene();
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
      const s = platform.notes.finishMeeting({ title: 'Interactive demo' });
      console.log(`📝 feedback=${s.feedback.length} jira=${s.jiraChanges.length} alerts=${s.alerts.length}`);
      rl.prompt(); return;
    }
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m) await say(m[1] as string, m[2] as string);
    else console.log('format: speaker: text  (or /script /summary /quit)');
    rl.prompt();
  });
  rl.on('close', () => process.exit(0));
}

void main();
