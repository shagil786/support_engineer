#!/usr/bin/env node
/**
 * serve — run the whole platform in one process (the composition root's CLI).
 *
 *   npx tsx scripts/serve.ts
 *
 * Integrations come from the environment via configFromEnv (Jira, Splunk,
 * Slack webhook, LLM). Learning follows LEARNING_ENABLED. Runbook catalog
 * defaults to empty (add via PlatformOptions in embedded hosts).
 *
 * The console is an operator surface: each stdin line is one utterance from
 * $SPEAKER (default 'console-user'), who is trusted as admin HERE ONLY
 * (the console is an operator tool; meeting surfaces keep the guest default).
 * Lines starting with ':' are commands:
 *   :learning tick   run one LearningLoop tick and print the result
 *   :quit            exit
 *
 * HTTP surface (same process, same platform) — starts ONLY when a bearer
 * token is configured (fail-closed; the surface never opens unauthenticated):
 *   HTTP_TOKEN / HTTP_TOKENS   bearer tokens (comma-separated); presence starts the server
 *   HTTP_PORT                  default 8787; HTTP_HOST default 127.0.0.1
 *   SLACK_SIGNING_SECRET       when set, /slack/events accepts verified Events API deliveries
 *                              INCLUDING reaction_added events, which drive emoji sign-off
 *                              on approval messages, and /slack/interactive accepts
 *                              button clicks from the Block Kit approval cards (set
 *                              SLACK_BOT_TOKEN so the gate posts cards + refs)
 *   APPROVAL_TIMEOUT_MS        pending window for staged approvals (default: gate's 5 min;
 *                              timed-out and denied approvals post a follow-up to the channel)
 *   RATE_LIMIT_PER_MINUTE      per-credential HTTP budget (default 120); 429s carry Retry-After.
 *                              Idempotency: send Idempotency-Key on /utterance and /envelope
 *                              for safe retries; approval executes are auto-coalesced
 */
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createPlatform, type Platform, type PlatformOptions } from '../src/bootstrap.js';
import { createHttpServer, type HttpServerHandle } from '../src/http/server.js';
import { configFromEnv } from '../src/config.js';
import type { TickResult } from '../src/learning/learning-loop.js';

export interface ServeRuntime {
  platform: Platform;
  stopLearning(): void;
  tickLearning(): Promise<TickResult>;
}

export interface ServeOptions extends Omit<PlatformOptions, 'learning'> {
  learning?: { enabled: boolean; intervalMs?: number };
  /** Speaker id used for stdin utterances (default 'console-user'). */
  speaker?: string;
}

export function createServeRuntime(opts: ServeOptions): ServeRuntime {
  const platform = createPlatform(opts);
  return {
    platform,
    stopLearning: () => platform.stopLearning(),
    tickLearning: async () => (platform.learningLoop ? platform.learningLoop.tick() : {
      extracted: 0, observed: 0, updated: 0, retired: 0, librarySize: 0,
      errors: ['learning not enabled'],
    }),
  };
}

/** Run the interactive console only when this file is the process entry. */
async function main(): Promise<void> {
  const env = process.env;
  const wired = configFromEnv(env);
  const learningEnv = env['LEARNING_ENABLED']?.toLowerCase() === 'true' || env['LEARNING_ENABLED'] === '1';
  const intervalRaw = Number(env['LEARNING_INTERVAL_MS'] ?? 0);
  const intervalMs = Number.isFinite(intervalRaw) && intervalRaw >= 1000 ? intervalRaw : 15 * 60_000;
  const speaker = env['SPEAKER'] ?? 'console-user';
  const approvalRawMs = Number(env['APPROVAL_TIMEOUT_MS'] ?? 0);
  const approvalTimeoutMs = Number.isFinite(approvalRawMs) && approvalRawMs >= 1000 ? approvalRawMs : undefined;

  const rt = createServeRuntime({
    dataDir: resolve('var'),
    ...(wired.jira ? { jira: wired.jira } : {}),
    ...(wired.logs ? { logProvider: wired.logs } : {}),
    ...(wired.slack ? { slack: wired.slack } : {}),
    ...(wired.llm ? { llm: wired.llm } : {}),
    // Bot token upgrades the approval channel: messages become reaction-
    // correlated, enabling M-of-N sign-off by emoji on the security channel.
    ...(env['SLACK_BOT_TOKEN'] ? { slackBotToken: env['SLACK_BOT_TOKEN'] } : {}),
    ...(approvalTimeoutMs !== undefined ? { approvalTimeoutMs } : {}),
    learning: learningEnv ? { enabled: true, intervalMs } : undefined,
    // Only the console operator is admin. Slack identities stay least-
    // privilege: with reactions driving sign-off, a blanket-admin resolver
    // would make every reactor an admin.
    speakerRole: (id) => (id === speaker ? 'admin' : undefined),
    deliverSpeech: (text) => console.log(`[agent] ${text}`),
  });

  // HTTP surface: fail-closed — only starts when at least one token exists.
  const httpTokens = (env['HTTP_TOKENS'] ?? env['HTTP_TOKEN'] ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
  let http: HttpServerHandle | undefined;
  if (httpTokens.length > 0) {
    const rateRaw = Number(env['RATE_LIMIT_PER_MINUTE'] ?? 0);
    http = await createHttpServer(rt.platform, {
      authTokens: httpTokens,
      host: env['HTTP_HOST'] ?? '127.0.0.1',
      port: Number(env['HTTP_PORT'] ?? 8787),
      ...(env['SLACK_SIGNING_SECRET'] ? { slackSigningSecret: env['SLACK_SIGNING_SECRET'] } : {}),
      ...(Number.isFinite(rateRaw) && rateRaw >= 1 ? { rateLimitPerMinute: rateRaw } : {}),
    });
    console.log(`http up at ${http.url} (POST /utterance; slack events ${env['SLACK_SIGNING_SECRET'] ? 'on (reactions route to the approval gate)' : 'off'})`);
  } else {
    console.log('http off (set HTTP_TOKEN to enable; the surface never opens unauthenticated)');
  }

  console.log(`platform up (learning: ${learningEnv ? `on, every ${intervalMs}ms` : 'off'}). Speaker: ${speaker}`);
  console.log('Type an utterance; :learning tick | :quit for commands.');
  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    const text = line.trim();
    if (!text) continue;
    if (text === ':quit') break;
    if (text === ':learning tick') {
      console.log(JSON.stringify(await rt.tickLearning()));
      continue;
    }
    const r = await rt.platform.pipeline.processUtterance(speaker, text);
    if (r.routed === 'pipeline') {
      console.log(`[pipeline] ok=${String(r.ok)}${r.reason ? ` reason=${r.reason}` : ''}${r.approvalId ? ` approvalId=${r.approvalId}` : ''}`);
    } else {
      console.log('[legacy] handled by the etiquette cascade');
    }
  }
  await http?.close();
  rt.stopLearning();
  console.log('bye');
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntry) {
  void main();
}
