/**
 * Scanner behind tests/hardcoded-values.test.ts — the spec §13 "zero hardcoded
 * hosts/tokens/keys in src/" invariant, enforced as code instead of convention.
 *
 * Lives in tests/ (not src/) on purpose: it is a hygiene tool for the repo,
 * not part of the shipped platform, and it must be free to use string
 * literals itself. `detectHardcodedValues` is called with canary sources
 * inside the test to prove every pattern family actually fires — a scanner
 * that silently stops matching would be worse than no scanner.
 *
 * The invariant's meaning (docs/superpowers/plans/2026-09-10-hardcoded-values-grep-test.md):
 *   - Deployment endpoints (hosts/URLs) must come from configuration, not literals.
 *   - Credentials must flow from config into `Bearer ${…}`-style expressions —
 *     never as literals. The scanner flags literals whose *context* is
 *     secret-shaped (an identifier/key-name declaring TOKEN/SECRET/KEY/…),
 *     never the words themselves.
 *   - Long opaque blobs (≥ 24 chars of [A-Za-z0-9_-] with digits AND letters,
 *     not plain lowercase identifiers) are flagged as potential keys.
 */

export interface Finding {
  file: string;
  line: number;
  /** Which rule fired: 'url' | 'secret-context' | 'entropy'. */
  rule: 'url' | 'secret-context' | 'entropy';
  /** The offending literal or line (trimmed, for the report). */
  snippet: string;
  why: string;
}

/** True for every src TypeScript file the invariant covers. */
export function isScannedSourceFile(relPath: string): boolean {
  return relPath.startsWith('src/') && relPath.endsWith('.ts');
}

/**
 * Return the source with comments blanked (preserving offsets/lines) while
 * string and template literals are left intact — including any `//` inside
 * them. One pass, small state machine: normal / line-comment / block-comment /
 * 'string' / "string" / `template`. `${…}` interiors inside templates are
 * treated as template text (good enough for hygiene scanning; a nested
 * backtick inside an interpolation is vanishingly rare in this codebase and
 * the canary suite pins the behavior we rely on).
 */
export function blankComments(source: string): string {
  const out = source.split('');
  let i = 0;
  const n = source.length;
  const blankFrom = (start: number, end: number): void => {
    for (let j = start; j < end && j < n; j++) {
      if (source[j] !== '\n') out[j] = ' ';
    }
  };
  while (i < n) {
    const c = source[i];
    const next = i + 1 < n ? source[i + 1]! : '';
    if (c === '/' && next === '/') {
      const start = i;
      while (i < n && source[i] !== '\n') i++;
      blankFrom(start, i);
    } else if (c === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i = Math.min(n, i + 2);
      blankFrom(start, i);
    } else if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < n) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) { i++; break; }
        i++;
      }
    } else {
      i++;
    }
  }
  return out.join('');
}

interface LiteralOccurrence {
  value: string;
  line: number;
  /** The literal's own source line, comments blanked. */
  context: string;
}

/** Collect single/double/backtick literal occurrences with comment-blanked line context. */
export function collectStringLiterals(code: string): LiteralOccurrence[] {
  const out: LiteralOccurrence[] = [];
  const lines = code.split('\n');
  const re = /(['"`])((?:\\.|(?!\1)[^\\])*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const value = m[2] ?? '';
    const line = code.slice(0, m.index).split('\n').length;
    out.push({ value, line, context: lines[line - 1] ?? '' });
  }
  return out;
}

const URL_RE = /https?:\/\/[a-z0-9.[\]:_-]+/i;
const LOOPBACK_RE = /^https?:\/\/(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]|local)([:/\s'"`]|$)/i;
/** Secret-declaring names: TOKEN, SECRET, KEY, PASSWORD/PASSWD/PWD, CREDENTIAL(S), API_KEY… */
const SECRET_NAME_RE = /\b[A-Z_]*(TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIALS?|API_?KEY|ACCESS_?KEY|SECRET_?KEY|PRIVATE_?KEY|SIGNING)[A-Z_]*\b/i;
/** …except Jira issue/project keys — product nouns, not credentials. */
const SECRET_NAME_EXCEPTION_RE = /\b(issue_key|project_key)\b/i;
/** Opaque blob: ≥24 chars of [A-Za-z0-9_-], must contain a digit AND a letter,
 *  and must not be a plain lowercase/underscore identifier (metric names etc). */
const ENTROPY_RE = /^[A-Za-z0-9_-]{24,}$/;
const looksLikeOpaqueKey = (v: string): boolean =>
  ENTROPY_RE.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v) && !/^[a-z0-9_]+$/.test(v);

/** URL host allowlist: product/service-definition domains, not deployment endpoints. */
const URL_HOST_ALLOWLIST: ReadonlyArray<{ test: RegExp; why: string }> = [
  { test: /^https:\/\/slack\.com\/api/, why: 'Slack Web API — the product definition of the Slack integration (stable global base URL, not a deployment endpoint)' },
  { test: /^https:\/\/logs\.[a-z0-9-]+\.amazonaws\.com\/?/, why: 'AWS CloudWatch Logs regional endpoint pattern; the region interpolates from config (cfg.region)' },
];

/**
 * Whole-file URL exemption, for files where URL literals are the product
 * catalog itself. Catalog keys ≠ deployment endpoints: requests must still
 * derive their host from config — pinned by that file's own unit test
 * (tests/llm.test.ts asserts the base URL comes from LlmConfig.baseUrl).
 */
const URL_FILE_ALLOWLIST: Record<string, string> = {
  'src/support-voice-agent/tools/llm.ts':
    'documented provider catalog in the interface docs (examples of LlmConfig.baseUrl values); request URLs derive from config',
};

/** (file [, line]) exact allowlist for entropy findings, each with a reason. */
const ENTROPY_ALLOWLIST: ReadonlyArray<{ file: string; line?: number; why: string }> = [];

/** Scan one file's source; returns every violation of the invariant. */
export function detectHardcodedValues(file: string, source: string): Finding[] {
  const findings: Finding[] = [];
  const code = blankComments(source);
  const literals = collectStringLiterals(code);
  const urlFileWhy = URL_FILE_ALLOWLIST[file];

  for (const lit of literals) {
    const trimmed = lit.value.trim();
    if (!trimmed) continue;
    const ctx = lit.context;

    // 1. URLs / hosts.
    if (URL_RE.test(trimmed)) {
      if (LOOPBACK_RE.test(trimmed)) continue;
      if (URL_HOST_ALLOWLIST.some((a) => a.test.test(trimmed))) continue;
      // Template-literal URLs (https://logs.${cfg.region}…) derive host parts
      // from code/config — allowed by construction.
      if (lit.value.includes('${')) continue;
      if (urlFileWhy) continue;
      findings.push({
        file, line: lit.line, rule: 'url', snippet: trimmed.slice(0, 120),
        why: 'literal non-loopback URL — deployment endpoints must come from config (env.*), or be allowlisted with a reason',
      });
      continue;
    }

    // 2a. A credential spelled out as the literal itself ('Bearer xyz…').
    //     Standalone check: no secret *name* needs to be on the line. Template
    //     interpolation (`Bearer ${tok}`) is NOT a hit — `$`/`{` fall outside
    //     the credential charset.
    if (/^(Bearer|Basic)\s+[A-Za-z0-9_./+=-]{8,}$/i.test(trimmed)) {
      findings.push({
        file, line: lit.line, rule: 'secret-context', snippet: ctx.trim().slice(0, 120),
        why: 'credential spelled out as a literal — must flow from config into the header expression',
      });
      continue;
    }

    // 2b. Secret-shaped context: a literal paired on the same line with a
    //     secret-named identifier (assignment, object key).
    const nameHit = ctx.match(SECRET_NAME_RE);
    if (nameHit && !SECRET_NAME_EXCEPTION_RE.test(nameHit[0]!)) {
      const nameEsc = nameHit[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`${nameEsc}["']?\\s*[:=]\\s*['"\`][^'"\`]+['"\`]`, 'i').test(ctx)) {
        findings.push({
          file, line: lit.line, rule: 'secret-context', snippet: ctx.trim().slice(0, 120),
          why: 'literal bound to a secret-named identifier — credentials must flow from config into the expression',
        });
        continue;
      }
    }

    // 3. Long opaque blobs (potential keys/tokens pasted as literals).
    if (looksLikeOpaqueKey(trimmed)) {
      const allow = ENTROPY_ALLOWLIST.find((a) => a.file === file && (a.line === undefined || a.line === lit.line));
      if (allow) continue;
      findings.push({
        file, line: lit.line, rule: 'entropy', snippet: `${trimmed.slice(0, 24)}…`,
        why: '≥24-char opaque literal (digits+letters) — looks like a key/credential; allowlist with a reason if legitimate',
      });
    }
  }
  return findings;
}
