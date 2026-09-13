import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDotEnv, loadDotEnv } from '../src/env.ts';
import { configFromEnv, llmConfigFromEnv } from '../src/config.ts';

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dotenv-test-'));
  return dir;
}

describe('parseDotEnv', () => {
  it('parses KEY=VALUE lines, comments, blanks, and quoted values', () => {
    const parsed = parseDotEnv(
      [
        '# comment',
        '',
        'PLAIN=hello',
        'QUOTED="a b c"',
        'SINGLE=\'x=y\'',
        'WITH_EQ=a=b=c',
        '  SPACED  =  trimmed  ',
        'EMPTY=',
        'NO_VALUE_KEY',
      ].join('\n'),
    );
    expect(parsed).toEqual({
      PLAIN: 'hello',
      QUOTED: 'a b c',
      SINGLE: 'x=y',
      WITH_EQ: 'a=b=c',
      SPACED: 'trimmed',
      EMPTY: '',
    });
    expect(parsed.NO_VALUE_KEY).toBeUndefined();
  });
});

describe('loadDotEnv', () => {
  it('loads a file and never overwrites existing real env vars', () => {
    const dir = tempDir();
    try {
      const path = join(dir, '.env');
      writeFileSync(path, 'A=from-file\nB=also-from-file\n');
      const env: Record<string, string | undefined> = { A: 'from-shell' };
      const applied = loadDotEnv({ path, env });
      expect(applied.sort()).toEqual(['B']);
      expect(env.A).toBe('from-shell'); // real env wins
      expect(env.B).toBe('also-from-file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('missing or unreadable file is non-fatal', () => {
    const dir = tempDir();
    try {
      expect(loadDotEnv({ path: join(dir, 'nope.env'), env: {} })).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('configFromEnv auto-loads .env when reading process.env', () => {
  it('wires LLM from a real .env file in the cwd', () => {
    const dir = tempDir();
    try {
      writeFileSync(
        join(dir, '.env'),
        'LLM_BASE_URL=https://api.example.com/v1\nLLM_API_KEY=sk-test-123\nLLM_MODEL=test-model\n',
      );
      const prev = process.cwd();
      process.chdir(dir); // per-worker process: safe under vitest forks pool
      // Park ambient LLM_* vars for the duration: a dev shell that exports
      // its real LLM_* config would otherwise beat the fixture under the
      // loader's "real env wins" rule and the assertions would see prod
      // values. Saved and restored in the finally block — per-worker
      // process, so parallel suites are unaffected.
      const parked: Record<string, string | undefined> = {};
      for (const key of Object.keys(process.env)) {
        if (key.startsWith('LLM_')) {
          parked[key] = process.env[key];
          delete process.env[key];
        }
      }
      try {
        const envConfig = configFromEnv(); // auto-loads the .env we just wrote
        expect(envConfig.llm).toEqual({
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-test-123',
          model: 'test-model',
        });
        expect(llmConfigFromEnv()).toEqual({
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-test-123',
          model: 'test-model',
        });
      } finally {
        for (const [key, value] of Object.entries(parked)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        process.chdir(prev);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
