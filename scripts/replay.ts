#!/usr/bin/env node
/**
 * Shadow-replay CLI — drift report / promotion pre-check (ADR-0010).
 *
 *   npm run replay [-- --bundle <path-to-yaml>] [--from <ms>] [--to <ms>]
 *                   [--promoted-at <ms>]
 *
 * Replays the governance traffic recorded on the event spine
 * (<DATA_DIR>/events, default var/) through a policy engine and diffs the
 * engine's effects against the decisions recorded on the spine:
 *
 *   - no --bundle: replays the LIVE bundle (policies/default.yaml) against
 *     its own recorded decisions. Zero divergences is the steady state;
 *     any divergence is spine/bundle drift and exits 1.
 *   - --bundle <path>: previews a CANDIDATE over the same window.
 *     Divergences are the candidate's behavior change on real traffic;
 *     exit 1 lets promotion pre-checks gate on it.
 *
 * Window:
 *   --from <ms>       inclusive lower bound (explicit window)
 *   --to <ms>         exclusive upper bound
 *   --promoted-at <ms>  the live bundle's promotion stamp (from your
 *                     PolicyStore) — scopes the default window to traffic
 *                     since promotion, so events decided by OLDER bundles
 *                     don't show as candidate divergences.
 *   none of the three → full log.
 *
 * Exit codes: 0 = zero divergences, 1 = divergences found, 2 = usage/IO error.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PolicyEngine } from '../src/governance/policy-engine.js';
import { ShadowReplay } from '../src/learning/shadow-replay.js';
import { JsonlFileEventLog } from '../src/event-log/log.js';

// --- args ----------------------------------------------------------------
let bundlePath: string | undefined;
let fromMs: number | undefined;
let toMs: number | undefined;
let promotedAtMs: number | undefined;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const needsValue = (name: string): string => {
    const value = args[i + 1];
    if (!value || value.startsWith('--')) {
      console.error(`error: ${name} requires a value`);
      process.exit(2);
    }
    i++;
    return value;
  };
  if (args[i] === '--bundle') {
    bundlePath = resolve(needsValue('--bundle'));
  } else if (args[i] === '--from' || args[i] === '--to' || args[i] === '--promoted-at') {
    const flag = String(args[i]);
    const n = Number(needsValue(flag));
    if (!Number.isFinite(n) || n < 0) {
      console.error(`error: ${flag} requires a non-negative epoch-ms number`);
      process.exit(2);
    }
    if (flag === '--from') fromMs = n;
    else if (flag === '--to') toMs = n;
    else promotedAtMs = n;
  } else {
    console.error(`error: unknown argument '${args[i]}'`);
    console.error('usage: npm run replay [-- --bundle <path>] [--from <ms>] [--to <ms>] [--promoted-at <ms>]');
    process.exit(2);
  }
}

const root = resolve(process.env['DATA_DIR'] ?? resolve(process.cwd(), 'var'));
const eventsDir = resolve(root, 'events');
const liveYamlPath = join(process.cwd(), 'policies/default.yaml');

let yaml: string;
try {
  yaml = readFileSync(bundlePath ?? liveYamlPath, 'utf8');
} catch (e) {
  console.error(`error: cannot read policy bundle: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}

try {
  const engine = new PolicyEngine({ yaml });
  const log = new JsonlFileEventLog({ baseDir: eventsDir });
  const replay = new ShadowReplay({ eventLog: log, engine });

  const r = await replay.run({
    ...(fromMs !== undefined ? { from: fromMs } : promotedAtMs !== undefined ? { bundlePromotedAt: promotedAtMs } : {}),
    ...(toMs !== undefined ? { to: toMs } : {}),
  });

  console.log(
    `shadow replay (${bundlePath ? 'candidate' : 'live'} bundle, window: ${r.window.reason}` +
      `${r.window.from !== undefined ? `, from ${r.window.from}` : ''}${r.window.to !== undefined ? `, to ${r.window.to}` : ''})`,
  );
  console.log(
    `inspected ${r.inspected} governance events: ${r.replayed} replayed, ${r.skipped} skipped (legacy / blast re-audit)`,
  );
  if (r.divergences.length === 0) {
    console.log('divergences: none — recorded decisions and this bundle agree');
    process.exit(0);
  }
  console.log(`divergences: ${r.divergences.length}`);
  for (const d of r.divergences.slice(0, 20)) {
    console.log(`  cid=${d.correlationId} ts=${d.ts} tool=${d.tool}: recorded=${d.recorded} candidate=${d.candidate}`);
  }
  if (r.divergences.length > 20) console.log(`  … and ${r.divergences.length - 20} more`);
  process.exit(1);
} catch (e) {
  console.error(`error: replay failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
