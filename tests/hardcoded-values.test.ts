/**
 * The spec §13 invariant — "zero hardcoded hosts/tokens/keys in src/" —
 * enforced as a test. Before this file, the invariant was "verified ✅
 * (by convention; grep test not built)" (spec §0.3, §13).
 *
 * Two layers:
 *   1. Canary self-checks: canned sources proving every rule fires and every
 *      exception holds, so the scanner can't silently rot (a scanner that
 *      matches nothing is worse than no scanner).
 *   2. The real scan: every TypeScript file under src/ against the rule,
 *      with all carve-outs visible and reasoned in tests/hardcoded-values.ts.
 *
 * A failure here means a literal endpoint/credential landed in src/. Fix by
 * sourcing from config/env, or — if the value is a product definition (like
 * the Slack API base URL) — extend the allowlist in tests/hardcoded-values.ts
 * with a written reason.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { detectHardcodedValues, isScannedSourceFile } from './hardcoded-values';

const SRC_ROOT = join(__dirname, '..', 'src');

/** Walk src/ collecting every covered .ts file. */
function allSrcFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (isScannedSourceFile(p.replace(SRC_ROOT, 'src'))) files.push(p);
    }
  };
  walk(SRC_ROOT);
  return files;
}

describe('hardcoded-values scanner self-checks (canaries)', () => {
  it('flags a literal non-loopback URL', () => {
    const [f] = detectHardcodedValues('src/x.ts', `const u = 'https://evil.example.com/v1';\n`);
    expect(f).toBeDefined();
    expect(f!.rule).toBe('url');
  });

  it('flags a URL literal even when other lines carry comments', () => {
    const src = [
      "// docs: see https://docs.example.internal/guide",
      "const endpoint = 'https://prod.example.internal/api';",
    ].join('\n');
    const [f] = detectHardcodedValues('src/x.ts', src);
    expect(f).toBeDefined();
    expect(f!.rule).toBe('url');
  });

  it('allows loopback URLs in any file', () => {
    const findings = detectHardcodedValues('src/x.ts', [
      "const a = 'http://localhost:11434/v1';",
      "const b = 'http://127.0.0.1:8080';",
      "const c = 'http://[::1]:9';",
    ].join('\n'));
    expect(findings).toEqual([]);
  });

  it('allows template-literal URLs (config-derived)', () => {
    const findings = detectHardcodedValues('src/x.ts', 'const u = `https://logs.${cfg.region}.amazonaws.com/`;\n');
    expect(findings).toEqual([]);
  });

  it('honors the host allowlist with reasons (slack api, aws regional pattern)', () => {
    const findings = detectHardcodedValues('src/x.ts', [
      "const u1 = 'https://slack.com/api/chat.postMessage';",
      "const u2 = 'https://logs.us-east-1.amazonaws.com/';",
    ].join('\n'));
    expect(findings).toEqual([]);
  });

  it('honors the whole-file catalog exemption for the LLM provider catalog', () => {
    // Catalog keys are product definitions; request URLs still derive from config.
    const findings = detectHardcodedValues(
      'src/support-voice-agent/tools/llm.ts',
      "const examples = 'https://api.openai.com/v1';",
    );
    expect(findings).toEqual([]);
    // …but the same literal in any other file is a hit.
    const [f] = detectHardcodedValues('src/other.ts', "const examples = 'https://api.openai.com/v1';");
    expect(f?.rule).toBe('url');
  });

  it('flags literals bound to secret-named identifiers and spelled-out credentials', () => {
    const src = [
      "const apiKey = 'opensesame1';",
      "headers: { authorization: 'Bearer abcdefgh12345678' },",
    ].join('\n');
    const findings = detectHardcodedValues('src/x.ts', src);
    expect(findings.map((f) => f.rule)).toEqual(['secret-context', 'secret-context']);
  });

  it('does not flag config-flowing credentials or product nouns', () => {
    const findings = detectHardcodedValues('src/x.ts', [
      'headers: { authorization: `Bearer ${this.apiKey}` },',
      "args: { issue_key: 'PROJ-123' },",
      'const label = SLACK_SIGNING_SECRET_ENV_VAR;',
    ].join('\n'));
    expect(findings).toEqual([]);
  });

  it('flags opaque key-shaped blobs but not lowercase identifiers or prose', () => {
    const [hit] = detectHardcodedValues('src/x.ts', "const k = 'AKIAIOSFODNN7EXAMPLEabc123';\n");
    expect(hit?.rule).toBe('entropy');
    const clean = detectHardcodedValues('src/x.ts', [
      "const metric = 'llm_latency_ms_bucket_v2_total_counter';",
      "const doc = 'this is a long but perfectly human sentence about retry behavior';",
    ].join('\n'));
    expect(clean).toEqual([]);
  });

  it('ignores URLs that only exist inside comments', () => {
    const src = [
      '/**',
      ' * Base URL example: https://api.openai.com/v1',
      ' * Legacy key: AKIAIOSFODNN7EXAMPLEabc123',
      ' */',
      'export const NOTHING = 1;',
    ].join('\n');
    expect(detectHardcodedValues('src/x.ts', src)).toEqual([]);
  });
});

describe('the invariant: zero hardcoded hosts/tokens/keys in src/', () => {
  const files = allSrcFiles();
  expect(files.length).toBeGreaterThan(50);

  const findings = files.flatMap((f) =>
    detectHardcodedValues(f.replace(SRC_ROOT, 'src'), readFileSync(f, 'utf8')),
  );

  it('every src file passes the hardcoded-value scan', () => {
    expect(
      findings,
      `hardcoded values found:\n${findings
        .map(
          (f) =>
            `  ${f.file}:${f.line} [${f.rule}] ${f.snippet}\n    flagged because: ${f.why}\n    fix: source from config/env, or allowlist in tests/hardcoded-values.ts with a written reason`,
        )
        .join('\n')}`,
    ).toEqual([]);
  });
});
