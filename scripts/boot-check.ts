/** Fresh-clone boot check: the "clone → install → boot → drive" smoke as one
 *  deterministic script. Builds a temp data dir + runbook catalog, boots the
 *  real platform + HTTP server (no LLM, no Slack, no Jira — degrades honestly),
 *  then asserts the operator's first five minutes:
 *
 *   1. fail-closed auth: bearer surfaces reject without a token
 *   2. /readyz reports the catalog ingested (kb docs >= catalog size)
 *   3. /ask answers from the KB with citations (no LLM — extractive floor)
 *   4. /utterance stages a DESTRUCTIVE runbook through the deterministic
 *      floor + KB resolver (matchedBy kb) — the mix-up incident path
 *   5. /metrics exposes Prometheus text
 *
 *  Runs in CI (fresh clone, no env) and locally via `npm run check:boot`.
 *  Exits non-zero on the first failed assertion. No external services.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlatform } from '../src/bootstrap';
import { createHttpServer } from '../src/http/server';

const CATALOG = [
  {
    id: 'db-restart-drill',
    name: 'Database restart drill',
    description: 'restart the primary database',
    destructive: true,
    script: 'echo drill-ok',
  },
  {
    id: 'clear-api-cache',
    name: 'API cache flush',
    description: 'clear the api cache',
    destructive: false,
    script: 'echo cache-ok',
  },
];

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'boot-check-'));
  const catalogPath = join(dir, 'runbooks.json');
  writeFileSync(catalogPath, JSON.stringify(CATALOG));

  const platform = createPlatform({
    dataDir: join(dir, 'data'),
    runbooks: CATALOG,
  });
  const handle = await createHttpServer(platform, {
    authTokens: ['boot-check-token'],
    ready: platform.ready,
  });
  const url = handle.url;
  const auth = { Authorization: 'Bearer boot-check-token', 'content-type': 'application/json' };

  try {
    console.log(`boot-check against ${url}`);

    // 1. Fail-closed auth.
    const noAuth = await fetch(`${url}/utterance`, { method: 'POST', body: '{}' });
    check('bearer surface rejects without a token (401)', noAuth.status === 401, `got ${noAuth.status}`);

    // 2. Readiness with the catalog ingested.
    const readyz = await fetch(`${url}/readyz`, { headers: auth });
    const readyBody = (await readyz.json()) as { kb?: { docs?: number }; ok?: boolean };
    check(
      'readyz reports the catalog ingested (kb docs >= 2)',
      readyz.status === 200 && (readyBody.kb?.docs ?? 0) >= CATALOG.length,
      `status ${readyz.status} body ${JSON.stringify(readyBody)}`,
    );

    // 3. /ask answers from the KB, cited, no LLM.
    const ask = await fetch(`${url}/ask`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ question: 'how do I restart the primary database?' }),
    });
    const askBody = (await ask.json()) as { answer?: string; refused?: boolean; usedLlm?: boolean; sources?: unknown[] };
    check(
      '/ask answers from the KB with citations (extractive, no LLM)',
      ask.status === 200 &&
        askBody.refused === false &&
        askBody.usedLlm === false &&
        (askBody.sources?.length ?? 0) > 0 &&
        typeof askBody.answer === 'string' &&
        askBody.answer.length > 0,
      `status ${ask.status} body ${JSON.stringify(askBody).slice(0, 200)}`,
    );

    // 4. Destructive imperative: RBAC fails closed for a guest...
    const guest = await fetch(`${url}/utterance`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ speakerId: 'nobody', text: 'please restart the primary database now' }),
    });
    const guestBody = (await guest.json()) as { routed?: string; ok?: boolean; reason?: string };
    check(
      'guest destructive imperative is vetoed by the SafetyNet (fail-closed RBAC)',
      guest.status === 200 &&
        guestBody.routed === 'pipeline' &&
        guestBody.ok === false &&
        (guestBody.reason ?? '').includes('veto'),
      `status ${guest.status} body ${JSON.stringify(guestBody).slice(0, 200)}`,
    );

    // 4b. ...and stages for an approver through the floor + KB resolver.
    const utt = await fetch(`${url}/utterance`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ speakerId: 'approver', text: 'please restart the primary database now' }),
    });
    const uttBody = (await utt.json()) as {
      routed?: string;
      approvalId?: string;
      approvalStatus?: string;
      reason?: string;
    };
    check(
      'destructive imperative stages an approval (floor + KB resolver)',
      utt.status === 200 &&
        uttBody.routed === 'pipeline' &&
        typeof uttBody.approvalId === 'string' &&
        uttBody.approvalStatus === 'pending',
      `status ${utt.status} body ${JSON.stringify(uttBody).slice(0, 200)}`,
    );

    // 5. Metrics are Prometheus text.
    const metrics = await fetch(`${url}/metrics`, { headers: auth });
    const metricsText = await metrics.text();
    check(
      '/metrics exposes Prometheus text',
      metrics.status === 200 && metricsText.includes('support_agent_'),
      `status ${metrics.status}`,
    );
  } finally {
    await handle.close();
    rmSync(dir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`boot-check FAILED: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('boot-check passed');
}

void main();
