import { describe, it, expect } from 'vitest';
import { TOOL_REGISTRY, toolNames } from '../../src/execution/tools/registry';
import type { ToolName } from '../../src/support-voice-agent/tools/types';

describe('TOOL_REGISTRY', () => {
  it('exposes every tool from the legacy schema', () => {
    expect(toolNames().sort()).toEqual([
      'assess_blast_radius',
      'correlate_changes',
      'execute_runbook_script',
      'invoke_human_on_slack',
      'jira_create_issue',
      'jira_get_issue',
      'meeting_interrupt',
      'query_evidence',
      'query_logs',
      'query_signals',
      'verify_remediation',
    ]);
  });

  it('validates the jira_get_issue key shape', async () => {
    expect((await TOOL_REGISTRY['jira_get_issue'].schema.safeParseAsync({ issue_key: 'SUPPORT-7' })).success).toBe(true);
    expect((await TOOL_REGISTRY['jira_get_issue'].schema.safeParseAsync({ issue_key: 'support-7' })).success).toBe(false);
    expect((await TOOL_REGISTRY['jira_get_issue'].schema.safeParseAsync({})).success).toBe(false);
  });

  it('rejects invalid args via Zod', async () => {
    const r = await TOOL_REGISTRY['jira_create_issue'].schema.safeParseAsync({});
    expect(r.success).toBe(false);
  });

  it('accepts valid args (project_key optional — JiraClient falls back to its configured default)', async () => {
    const r = await TOOL_REGISTRY['jira_create_issue'].schema.safeParseAsync({ summary: 's', issue_type: 'Bug' });
    expect(r.success).toBe(true);
  });

  it('rejects an empty summary', async () => {
    const r = await TOOL_REGISTRY['jira_create_issue'].schema.safeParseAsync({ summary: '', issue_type: 'Bug' });
    expect(r.success).toBe(false);
  });

  it('keeps the legacy priority enum (no widening without governance)', async () => {
    const bad = await TOOL_REGISTRY['jira_create_issue'].schema.safeParseAsync({ summary: 's', issue_type: 'Bug', priority: 'Trivial' });
    const good = await TOOL_REGISTRY['jira_create_issue'].schema.safeParseAsync({ summary: 's', issue_type: 'Bug', priority: 'High' });
    expect(bad.success).toBe(false);
    expect(good.success).toBe(true);
  });

  it('validates query_logs time ranges', async () => {
    expect((await TOOL_REGISTRY['query_logs'].schema.safeParseAsync({ query_string: 'errors' })).success).toBe(true);
    expect((await TOOL_REGISTRY['query_logs'].schema.safeParseAsync({ query_string: 'e', time_range: 'last_30m' })).success).toBe(true);
    expect((await TOOL_REGISTRY['query_logs'].schema.safeParseAsync({ query_string: 'e', time_range: 'last_year' })).success).toBe(false);
  });

  it('validates the new read-only tools', async () => {
    expect((await TOOL_REGISTRY['query_evidence'].schema.safeParseAsync({ service: 'checkout-service' })).success).toBe(true);
    expect((await TOOL_REGISTRY['query_evidence'].schema.safeParseAsync({})).success).toBe(false);
    expect((await TOOL_REGISTRY['correlate_changes'].schema.safeParseAsync({ service: 's', incident_ts: 5 })).success).toBe(true);
    expect((await TOOL_REGISTRY['correlate_changes'].schema.safeParseAsync({ service: 's' })).success).toBe(false);
    expect((await TOOL_REGISTRY['query_signals'].schema.safeParseAsync({ service: 's', from: 0, to: 5 })).success).toBe(true);
    expect((await TOOL_REGISTRY['verify_remediation'].schema.safeParseAsync({
      service: 's',
      criteria: [{ metric: 'error_rate', op: 'lt', threshold: 0.01, label: 'error rate < 1%' }],
    })).success).toBe(true);
    expect((await TOOL_REGISTRY['verify_remediation'].schema.safeParseAsync({ service: 's', criteria: [] })).success).toBe(false);
    expect((await TOOL_REGISTRY['assess_blast_radius'].schema.safeParseAsync({ service: 's', action: 'restart' })).success).toBe(true);
    expect((await TOOL_REGISTRY['assess_blast_radius'].schema.safeParseAsync({ service: 's', action: 'nuke' })).success).toBe(false);
  });

  it('every registry tool is a member of the real ToolName union', () => {
    for (const name of toolNames()) {
      expect(() => {
        const _check: ToolName = name;
        void _check;
      }).not.toThrow();
    }
  });
});
