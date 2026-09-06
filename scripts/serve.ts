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
 */
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createPlatform, type Platform, type PlatformOptions } from '../src/bootstrap.js';
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

  const rt = createServeRuntime({
    dataDir: resolve('var'),
    ...(wired.jira ? { jira: wired.jira } : {}),
    ...(wired.logs ? { logProvider: wired.logs } : {}),
    ...(wired.slack ? { slack: wired.slack } : {}),
    ...(wired.llm ? { llm: wired.llm } : {}),
    learning: learningEnv ? { enabled: true, intervalMs } : undefined,
    // The console is an operator surface: the operator speaks as admin.
    speakerRole: () => 'admin',
    deliverSpeech: (text) => console.log(`[agent] ${text}`),
  });

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
  rt.stopLearning();
  console.log('bye');
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntry) {
  void main();
}
