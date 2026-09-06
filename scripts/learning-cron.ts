#!/usr/bin/env node
/**
 * learning-cron — runs the learning loop on a schedule (spec §7.4 wiring).
 *
 *   LEARNING_ENABLED=true npx tsx scripts/learning-cron.ts
 *
 * Env:
 *   LEARNING_ENABLED       required opt-in (off by default)
 *   LEARNING_INTERVAL_MS   tick interval, default 15 minutes
 *
 * Runtime data lives under var/ (gitignored): outcomes/, events/,
 * memory/procedures.json (durable cross-scope episodic memory),
 * stats/procedure-stats.json (efficacy snapshot).
 */
import { resolve } from 'node:path';
import { learningEnabledFromEnv } from '../src/config.js';
import { LearningLoop } from '../src/learning/learning-loop.js';
import { JsonlFileEventLog } from '../src/event-log/log.js';

const env = process.env;
const enabled = learningEnabledFromEnv(env).enabled;
if (!enabled) {
  console.error('learning-cron: LEARNING_ENABLED is not set — the loop is opt-in and stays off.');
  process.exit(1);
}

const root = resolve(process.cwd(), 'var');
const intervalRaw = Number(env['LEARNING_INTERVAL_MS'] ?? 0);
const intervalMs = Number.isFinite(intervalRaw) && intervalRaw >= 1_000 ? intervalRaw : 15 * 60_000;

const loop = new LearningLoop({
  eventLog: new JsonlFileEventLog({ baseDir: resolve(root, 'events') }),
  outcomesDir: resolve(root, 'outcomes'),
  crossPath: resolve(root, 'memory', 'procedures.json'),
  statsPath: resolve(root, 'stats', 'procedure-stats.json'),
});

const report = (label: string, r: Awaited<ReturnType<LearningLoop['tick']>>): void => {
  console.log(
    `[learning] ${label} extracted=${r.extracted} observed=${r.observed} updated=${r.updated} ` +
      `retired=${r.retired} library=${r.librarySize}` +
      (r.errors.length ? ` errors=${JSON.stringify(r.errors)}` : ''),
  );
};

const oneShot = process.argv.includes('--once');
if (oneShot) {
  report('tick', await loop.tick());
  process.exit(0);
}

loop.start(intervalMs);
console.log(`[learning] loop scheduled every ${intervalMs}ms (crossPath: durable)`);
const shutdown = (signal: string): void => {
  console.log(`[learning] ${signal} received; stopping loop`);
  loop.stop();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
