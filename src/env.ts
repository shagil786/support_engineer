/** Minimal .env loader — zero dependencies.
 *
 *  Loads KEY=VALUE lines from a file into process.env. Real environment
 *  variables always win; existing process.env entries are never overwritten.
 *  Missing file is not an error (configFromEnv then leaves integrations
 *  unwired). Values are used verbatim; surrounding single/double quotes are
 *  stripped; inline comments are NOT stripped (a # may be part of a token).
 */
import { existsSync, readFileSync } from 'node:fs';

export interface LoadDotEnvOptions {
  path?: string;
  env?: Record<string, string | undefined>;
}

export function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/** Apply the file's variables to `env` without overwriting existing values.
 *  Returns the names actually applied (empty when file missing/empty). */
export function loadDotEnv(options: LoadDotEnvOptions = {}): string[] {
  const path = options.path ?? '.env';
  const env = options.env ?? process.env;
  try {
    if (!existsSync(path)) return [];
    const parsed = parseDotEnv(readFileSync(path, 'utf8'));
    const applied: string[] = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (env[key] !== undefined && env[key] !== '') continue; // real env wins
      env[key] = value;
      applied.push(key);
    }
    return applied;
  } catch {
    return []; // unreadable file is non-fatal: integrations stay unwired
  }
}
