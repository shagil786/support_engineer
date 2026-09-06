#!/usr/bin/env node
/**
 * Eval CLI — CI entry point for policy behavior (spec §7.3).
 *
 *   npx tsx scripts/eval.ts [--bundle <path-to-yaml>]
 *
 * Runs, against policies/default.yaml (or --bundle):
 *   1. every shipped eval scenario          (policies/eval/scenarios.yaml)
 *   2. every SafetyNet must-veto scenario   (policies/eval/safety_net_regression.yaml)
 *
 * Exit codes: 0 = all green, 1 = any eval or regression failure,
 * 2 = usage/IO error. Malformed scenario files fail loud via Zod — they can
 * never silently pass zero scenarios.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PolicyEngine } from '../src/governance/policy-engine.js';
import { SafetyNet } from '../src/governance/safety-net/index.js';
import { EvalRunner } from '../src/learning/eval-runner.js';
import { runSafetyNetRegression } from '../src/learning/safety-net-regression.js';

// --- args ----------------------------------------------------------------
let bundlePath = join(process.cwd(), 'policies/default.yaml');
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--bundle') {
    const value = args[i + 1];
    if (!value || value.startsWith('--')) {
      console.error('error: --bundle requires a path to a policy YAML file');
      process.exit(2);
    }
    bundlePath = resolve(value);
    i++;
  } else {
    console.error(`error: unknown argument '${args[i]}'`);
    console.error('usage: npx tsx scripts/eval.ts [--bundle <path-to-yaml>]');
    process.exit(2);
  }
}

const scenariosPath = join(process.cwd(), 'policies/eval/scenarios.yaml');
const safetyNetScenariosPath = join(process.cwd(), 'policies/eval/safety_net_regression.yaml');

// --- eval scenarios -------------------------------------------------------
try {
  const yaml = readFileSync(bundlePath, 'utf8');
  const engine = new PolicyEngine({ yaml });

  const evalResult = new EvalRunner({ engine }).runScenarios(readFileSync(scenariosPath, 'utf8'));
  console.log(`eval scenarios: ${evalResult.passed}/${evalResult.total} passed (${scenariosPath})`);
  for (const f of evalResult.failures) {
    console.error(`  FAIL ${f.id}: expected ${f.expected}, got ${f.got}`);
  }

  // --- SafetyNet regression (bundle-independent: the net is code) ---------
  let safetyNetOk = true;
  try {
    runSafetyNetRegression(readFileSync(safetyNetScenariosPath, 'utf8'), new SafetyNet({}));
    console.log(`safety-net regression: passed (${safetyNetScenariosPath})`);
  } catch (e) {
    safetyNetOk = false;
    console.error(`  FAIL ${e instanceof Error ? e.message : String(e)}`);
  }

  if (evalResult.failures.length > 0 || !safetyNetOk) {
    console.error('eval FAILED');
    process.exit(1);
  }
  console.log('eval PASSED');
} catch (e) {
  // Unreadable bundle, invalid bundle YAML, or malformed scenario file.
  console.error(`eval ERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
