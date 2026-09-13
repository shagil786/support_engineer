/**
 * replay.ts CLI integration — the operator surface of the shadow-replay +
 * scenario-synthesis features (ADR-0010/0011). This is the ONLY test that
 * spawns the real CLI, so a refactored flag parser, a wrong exit code, or a
 * broken `--synthesize` path fails here exactly where an operator would hit
 * it — the library tests can't catch a CLI that stopped wiring up.
 *
 * Coverage: live-bundle drift check (exit 0), real divergence (exit 1 +
 * line), --synthesize to stdout and to a file, --bundle candidate preview,
 * and usage/IO errors (exit 2). Spine is a temp DATA_DIR seeded with
 * governance events; the live bundle is the repo's policies/default.yaml.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { IntentEnvelope } from '../../src/event-log/types';

const ROOT = resolve(__dirname, '..', '..'); // repo root (vitest cwd)
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

type Effect = 'allow' | 'deny' | 'require_approval';

interface Seed {
  correlationId: string;
  ts: number;
  tool: string;
  args: Record<string, unknown>;
  effect: Effect;
}

function seedEvent(s: Seed, baseDir: string): void {
  const envelope: IntentEnvelope = {
    intent: { kind: 'meeting_response', subKind: 'question' },
    confidence: 1,
    entities: {},
    rawContext: { source: 'meeting', ts: s.ts, payload: {} },
  };
  const line = JSON.stringify({
    correlationId: s.correlationId,
    ts: s.ts,
    layer: 'governance',
    source: 'internal',
    kind: 'governance',
    intent: envelope,
    action: { tool: s.tool, args: s.args },
    decision: { effect: s.effect, reason: 'seeded', policyIds: ['p-seed'] },
  });
  const day = new Date(s.ts).toISOString().slice(0, 10);
  writeFileSync(join(baseDir, `${day}.jsonl`), `${line}\n`, { flag: 'a' });
}

function runReplay(dataDir: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [TSX_CLI, 'scripts/replay.ts', ...args], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

let dir: string;
let dataDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'replay-cli-'));
  dataDir = join(dir, 'data');
  mkdirSync(join(dataDir, 'events'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('replay CLI (live drift check)', () => {
  it('exit 0 with no divergences when a clean spine agrees with the live bundle', () => {
    // query_logs/allow matches the live bundle's read_only_default_allow.
    seedEvent({ correlationId: 'cid-ok', ts: 1_000_000, tool: 'query_logs', args: { query_string: 'errors' }, effect: 'allow' }, join(dataDir, 'events'));
    const r = runReplay(dataDir, []);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('divergences: none');
  });

  it('exit 1 with a divergence line when the spine contradicts the live bundle', () => {
    // The live bundle ALLOWS query_logs/errors; the spine records deny →
    // genuine drift the replay must report (and fail on).
    seedEvent({ correlationId: 'cid-drift', ts: 1_000_000, tool: 'query_logs', args: { query_string: 'errors' }, effect: 'deny' }, join(dataDir, 'events'));
    const r = runReplay(dataDir, []);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('cid=cid-drift');
    expect(r.stdout).toContain('recorded=deny');
    expect(r.stdout).toContain('candidate=allow');
  });
});

describe('replay CLI (scenario synthesis)', () => {
  it('--synthesize prints a ready-to-paste fragment (exit 1 still)', () => {
    seedEvent({ correlationId: 'cid-drift', ts: 1_000_000, tool: 'query_logs', args: { query_string: 'errors' }, effect: 'deny' }, join(dataDir, 'events'));
    const r = runReplay(dataDir, ['--synthesize']);
    expect(r.status).toBe(1); // the drift still fails the check
    expect(r.stdout).toContain('synthesize: 1 scenario(s) ready');
    expect(r.stdout).toContain('shadow_query_logs_deny');
    expect(r.stdout).toContain('expect: deny'); // the RECORDED effect is pinned
    expect(r.stdout).toContain('cid=cid-drift'); // provenance comment
  });

  it('--synthesize <file> writes the fragment to that file', () => {
    seedEvent({ correlationId: 'cid-drift', ts: 1_000_000, tool: 'query_logs', args: { query_string: 'errors' }, effect: 'deny' }, join(dataDir, 'events'));
    const out = join(dir, 'pins.yaml');
    const r = runReplay(dataDir, ['--synthesize', out]);
    expect(r.status).toBe(1);
    const written = readFileSync(out, 'utf8');
    expect(written).toContain('shadow_query_logs_deny');
    expect(written).toContain('expect: deny');
  });

  it('redacts card-shaped tokens from synthesized pinned args', () => {
    // The live bundle's never_emit_credit_card rule DENIES any args with a
    // card number, so a deny-recorded event would agree with it (no
    // divergence, nothing to synthesize). The drift case is traffic recorded
    // BEFORE the PII guard existed: recorded=allow, candidate=deny.
    seedEvent(
      {
        correlationId: 'cid-card',
        ts: 1_000_000,
        tool: 'query_logs',
        args: { query_string: 'the card 4111 1111 1111 1111 was declined' },
        effect: 'allow',
      },
      join(dataDir, 'events'),
    );
    const r = runReplay(dataDir, ['--synthesize']);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toMatch(/\b(?:\d[ -]*?){13,19}\b/); // never a live card number
    expect(r.stdout).toContain('[REDACTED]');
  });
});

describe('replay CLI (candidate bundle preview)', () => {
  const writeCandidate = (effect: 'allow' | 'deny'): string => {
    const candidate = join(dir, 'candidate.yaml');
    writeFileSync(
      candidate,
      [
        'rules:',
        `  - id: candidate_${effect}_reads`,
        '    when:',
        '      tools_in: [query_logs]',
        `    effect: ${effect}`,
        `    reason: candidate ${effect}s reads`,
      ].join('\n'),
      'utf8',
    );
    return candidate;
  };

  it('--bundle previews a candidate: its behavior change on real traffic exits 1', () => {
    // The live bundle ALLOWS query_logs (read_only_default_allow); this
    // candidate denies it — the preview must surface exactly that change
    // on recorded traffic and fail the pre-check.
    seedEvent({ correlationId: 'cid-cand', ts: 1_000_000, tool: 'query_logs', args: { query_string: 'errors' }, effect: 'allow' }, join(dataDir, 'events'));
    const r = runReplay(dataDir, ['--bundle', writeCandidate('deny')]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('candidate bundle');
    expect(r.stdout).toContain('cid=cid-cand');
    expect(r.stdout).toContain('recorded=allow');
    expect(r.stdout).toContain('candidate=deny');
  });

  it('--bundle that agrees with the recorded decisions exits 0', () => {
    // Unmatched tools default-deny, so the candidate must explicitly allow
    // query_logs to agree with the live bundle on this traffic.
    seedEvent({ correlationId: 'cid-ok', ts: 1_000_000, tool: 'query_logs', args: { query_string: 'errors' }, effect: 'allow' }, join(dataDir, 'events'));
    const r = runReplay(dataDir, ['--bundle', writeCandidate('allow')]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('divergences: none');
  });
});

describe('replay CLI (usage / IO errors exit 2)', () => {
  it('unknown argument', () => {
    const r = runReplay(dataDir, ['--nonsense']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("unknown argument '--nonsense'");
  });

  it('--bundle without a value', () => {
    const r = runReplay(dataDir, ['--bundle']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--bundle requires a value');
  });

  it('non-numeric window bound', () => {
    const r = runReplay(dataDir, ['--from', 'yesterday']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--from requires a non-negative epoch-ms number');
  });

  it('unreadable policy bundle', () => {
    const r = runReplay(dataDir, ['--bundle', join(dir, 'missing.yaml')]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('cannot read policy bundle');
  });

  it('missing events directory is an empty spine, not an error (exit 0)', () => {
    // JsonlFileEventLog.query treats a nonexistent dir as "nothing logged
    // yet" (by design), so replaying an empty spine is the steady state.
    const r = runReplay(join(dir, 'no-such-data'), []);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('inspected 0 governance events');
    expect(r.stdout).toContain('divergences: none');
  });
});