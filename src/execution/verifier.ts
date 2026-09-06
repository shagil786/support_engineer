/**
 * Lightweight non-LLM verification of tool results (spec §6.2). The
 * ReviewerAgent is the LLM critic; these checks are the cheap, deterministic
 * floor that runs on every step — a malformed Jira key or a PII leak must
 * never depend on an LLM noticing.
 */
import type { ToolResult } from '../support-voice-agent/tools/types.js';
import { OutputFilters } from '../governance/safety-net/output-filters.js';

export interface Verification {
  passed: boolean;
  reason?: string;
}

export interface VerifyOptions {
  /** Output the step produced — scanned by the SafetyNet output filters. */
  candidateOutput?: string;
}

type Check = (r: ToolResult) => Verification;

const JIRA_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;

const outputFilters = new OutputFilters();

const CHECKS: Record<string, Check> = {
  jira_create_issue: (r) => {
    if (!r.ok) return { passed: false, reason: 'createIssue returned not-ok' };
    const key = (r.data as { ticket_id?: unknown } | undefined)?.ticket_id;
    if (typeof key !== 'string' || !JIRA_KEY_RE.test(key)) {
      return { passed: false, reason: 'invalid Jira key shape' };
    }
    return { passed: true };
  },
  execute_runbook_script: (r) =>
    r.ok ? { passed: true } : { passed: false, reason: 'runbook did not succeed' },
  invoke_human_on_slack: (r) =>
    r.ok ? { passed: true } : { passed: false, reason: 'slack notification did not succeed' },
  query_logs: (r) => (r.ok ? { passed: true } : { passed: false, reason: 'log query failed' }),
};

export function verifyResult(tool: string, result: ToolResult, opts: VerifyOptions = {}): Verification {
  if (opts.candidateOutput !== undefined) {
    const f = outputFilters.check(opts.candidateOutput);
    if (f.vetoed) return { passed: false, reason: `output filter: ${f.reason}` };
  }
  const check = CHECKS[tool];
  let v: Verification;
  if (!check) {
    v = result.ok ? { passed: true } : { passed: false, reason: 'tool reported failure' };
  } else {
    v = check(result);
  }
  // Surface the underlying error (e.g. a SafetyNet veto) through the
  // verification reason so failures are diagnosable without re-running.
  if (!v.passed && !result.ok && typeof result.error === 'string') {
    return { passed: false, reason: `${v.reason ?? 'failed'}: ${result.error}` };
  }
  return v;
}
