import { describe, it, expect } from 'vitest';
import { configFromEnv, jiraConfigFromEnv, requireJira, createAgent } from '../src/config';
import { InMemoryRunbookProvider } from '../src/support-voice-agent/integrations/runbook';
import type { SpeechEvent } from '../src/index';

/** All values below are obviously-fake placeholders used only as env fixtures;
 *  nothing here performs network I/O. */

describe('jiraConfigFromEnv', () => {
  it('is unwired when JIRA_BASE_URL is missing', () => {
    expect(jiraConfigFromEnv({ JIRA_BEARER_TOKEN: 'x' })).toBeUndefined();
  });

  it('is unwired when the bearer token is missing', () => {
    expect(jiraConfigFromEnv({ JIRA_BASE_URL: 'https://jira.test.example' })).toBeUndefined();
  });

  it('wires bearer auth and optional project key', () => {
    const cfg = jiraConfigFromEnv({
      JIRA_BASE_URL: 'https://jira.test.example/',
      JIRA_BEARER_TOKEN: 'token-value',
      JIRA_PROJECT_KEY: 'HELP',
    });
    expect(cfg).toBeDefined();
    expect(cfg?.baseUrl).toBe('https://jira.test.example/');
    expect(cfg?.auth).toEqual({ type: 'bearer', token: 'token-value' });
    expect(cfg?.projectKey).toBe('HELP');
  });

  it('wires basic auth only with email + api token', () => {
    const partial = jiraConfigFromEnv({ JIRA_BASE_URL: 'https://jira.test.example', JIRA_AUTH_TYPE: 'basic', JIRA_EMAIL: 'a@b.c' });
    expect(partial).toBeUndefined();
    const full = jiraConfigFromEnv({
      JIRA_BASE_URL: 'https://jira.test.example',
      JIRA_AUTH_TYPE: 'basic',
      JIRA_EMAIL: 'a@b.c',
      JIRA_API_TOKEN: 'tok',
    });
    expect(full?.auth).toEqual({ type: 'basic', email: 'a@b.c', apiToken: 'tok' });
  });

  it('has no project-key default when the var is absent', () => {
    const cfg = jiraConfigFromEnv({ JIRA_BASE_URL: 'https://jira.test.example', JIRA_BEARER_TOKEN: 'x' });
    expect(cfg && 'projectKey' in cfg && cfg.projectKey).toBeFalsy();
  });
});

describe('configFromEnv', () => {
  it('returns an empty wiring set for an empty environment', () => {
    expect(configFromEnv({})).toEqual({});
  });

  it('wires only the integrations whose variables are complete', () => {
    const cfg = configFromEnv({
      JIRA_BASE_URL: 'https://jira.test.example',
      JIRA_BEARER_TOKEN: 'x',
      SLACK_WEBHOOK_URL: 'https://hooks.slack.test.example/T/B/X',
    });
    expect(cfg.jira).toBeDefined();
    expect(cfg.slack).toBeDefined();
    expect(cfg.logs).toBeUndefined();
  });

  it('wires Splunk logs only with both URL and token', () => {
    expect(configFromEnv({ SPLUNK_URL: 'https://splunk.test.example' }).logs).toBeUndefined();
    expect(configFromEnv({ SPLUNK_URL: 'https://splunk.test.example', SPLUNK_TOKEN: 't' }).logs).toBeDefined();
  });

  it('parses APPROVAL_TIMEOUT_MS only when it is a valid interval (>= 1000)', () => {
    expect(configFromEnv({}).approvalTimeoutMs).toBeUndefined();
    expect(configFromEnv({ APPROVAL_TIMEOUT_MS: '500' }).approvalTimeoutMs).toBeUndefined();
    expect(configFromEnv({ APPROVAL_TIMEOUT_MS: 'nope' }).approvalTimeoutMs).toBeUndefined();
    expect(configFromEnv({ APPROVAL_TIMEOUT_MS: '30000' }).approvalTimeoutMs).toBe(30_000);
  });

  it('parses SUPERVISOR_* caps from env (with a sane floor, absent by default)', () => {
    expect(configFromEnv({}).supervisorCaps).toBeUndefined();
    expect(configFromEnv({ SUPERVISOR_MAX_WALLCLOCK_MS: '500' }).supervisorCaps).toBeUndefined();
    expect(configFromEnv({ SUPERVISOR_MAX_WALLCLOCK_MS: 'nope' }).supervisorCaps).toBeUndefined();
    expect(configFromEnv({ SUPERVISOR_MAX_WALLCLOCK_MS: '180000' }).supervisorCaps).toEqual({ maxWallClockMs: 180_000 });
    expect(
      configFromEnv({ SUPERVISOR_MAX_WALLCLOCK_MS: '180000', SUPERVISOR_MAX_HOPS: '12', SUPERVISOR_MAX_TOKENS: '99000', SUPERVISOR_MAX_IDENTICAL_TOOL_CALLS: '5' }).supervisorCaps,
    ).toEqual({ maxWallClockMs: 180_000, maxHops: 12, maxTokens: 99_000, maxIdenticalToolCalls: 5 });
  });

  it('parses EMBEDDINGS_* all-or-nothing, with optional dim (>= 8)', () => {
    expect(configFromEnv({}).embeddings).toBeUndefined();
    // Partial config throws — never a silently half-wired embedder.
    expect(() => configFromEnv({ EMBEDDINGS_BASE_URL: 'https://e.test' })).toThrow(/required together/);
    expect(
      configFromEnv({ EMBEDDINGS_BASE_URL: 'https://e.test', EMBEDDINGS_API_KEY: 'k', EMBEDDINGS_MODEL: 'm' }).embeddings,
    ).toEqual({ provider: 'remote', baseUrl: 'https://e.test', apiKey: 'k', model: 'm' });
    expect(
      configFromEnv({
        EMBEDDINGS_BASE_URL: 'https://e.test',
        EMBEDDINGS_API_KEY: 'k',
        EMBEDDINGS_MODEL: 'm',
        EMBEDDINGS_DIM: '128',
      }).embeddings,
    ).toEqual({ provider: 'remote', baseUrl: 'https://e.test', apiKey: 'k', model: 'm', dim: 128 });
    // Below the dim floor → absent dim.
    expect(
      configFromEnv({
        EMBEDDINGS_BASE_URL: 'https://e.test',
        EMBEDDINGS_API_KEY: 'k',
        EMBEDDINGS_MODEL: 'm',
        EMBEDDINGS_DIM: '4',
      }).embeddings,
    ).toEqual({ provider: 'remote', baseUrl: 'https://e.test', apiKey: 'k', model: 'm' });
  });

  it('parses EMBEDDINGS_PROVIDER=local as a keyless embedder with optional model/dim', () => {
    expect(configFromEnv({ EMBEDDINGS_PROVIDER: 'local' }).embeddings).toEqual({ provider: 'local' });
    expect(configFromEnv({ EMBEDDINGS_PROVIDER: 'local', EMBEDDINGS_MODEL: 'Xenova/foo' }).embeddings).toEqual({
      provider: 'local',
      model: 'Xenova/foo',
    });
    expect(configFromEnv({ EMBEDDINGS_PROVIDER: 'local', EMBEDDINGS_DIM: '128' }).embeddings).toEqual({
      provider: 'local',
      dim: 128,
    });
  });

  it('rejects contradictory and unknown embeddings config', () => {
    // local provider with remote-only vars is a contradiction, not a default.
    expect(() => configFromEnv({ EMBEDDINGS_PROVIDER: 'local', EMBEDDINGS_BASE_URL: 'https://e.test' })).toThrow(/contradict|BASE_URL/);
    expect(() => configFromEnv({ EMBEDDINGS_PROVIDER: 'brain' })).toThrow(/unknown .*provider|EMBEDDINGS_PROVIDER/i);
    // Explicit remote still requires the trio.
    expect(() => configFromEnv({ EMBEDDINGS_PROVIDER: 'remote', EMBEDDINGS_API_KEY: 'k' })).toThrow(/required together/);
  });
});

describe('requireJira', () => {
  it('throws with actionable guidance when unconfigured', () => {
    expect(() => requireJira({})).toThrow(/JIRA_BASE_URL/);
  });
  it('returns the config when fully configured', () => {
    expect(
      requireJira({ JIRA_BASE_URL: 'https://jira.test.example', JIRA_BEARER_TOKEN: 'x' }).baseUrl,
    ).toBe('https://jira.test.example');
  });
});

describe('createAgent production wiring', () => {
  it('starts Jira-unwired with an empty env and answers with the honest fallback (no HTTP)', async () => {
    // No jira config, nothing to wire: a Jira-dependent question must degrade,
    // never attempt a network call. If the agent did wire a client with a fake
    // host, this test would observe a warn log / different utterance instead.
    const agent = createAgent({ mode: 'response', env: {} });
    const speech: SpeechEvent[] = [];
    const warnings: string[] = [];
    agent.on('speech', (e) => speech.push(e));
    agent.on('log', (e) => {
      if (e.level === 'warn') warnings.push(e.message);
    });

    agent.processUtterance('U1', 'what is the status of TICKET-9');
    agent.onPause(2000);
    await new Promise((r) => setTimeout(r, 0));

    expect(speech.some((s) => s.text.includes("I don't have that data in my current context"))).toBe(true);
    expect(warnings.some((w) => /fetch|ENOTFOUND/i.test(w))).toBe(false);
  });

  it('defaults to an empty runbook registry (sample actions are fixtures, not production)', async () => {
    const agent = createAgent({ env: {} });
    expect(agent).toBeDefined();
    // Offer an action id from the sample fixture: production registry must not know it.
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e) => speech.push(e));
    await agent.offerRunbookAction('restart-checkout-pod');
    agent.onPause(2000);
    await new Promise((r) => setTimeout(r, 0));
    expect(speech.some((s) => s.text.toLowerCase().includes("couldn't find"))).toBe(true);
  });

  it('accepts an explicit runbook registry via config', async () => {
    const agent = createAgent({
      env: {},
      runbooks: new InMemoryRunbookProvider([
        { id: 'demo-action', name: 'Demo', description: 'run the demo action', destructive: false },
      ]),
    });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e) => speech.push(e));
    await agent.offerRunbookAction('demo-action');
    agent.onPause(2000);
    await new Promise((r) => setTimeout(r, 0));
    expect(speech.some((s) => s.text.toLowerCase().includes('run the demo action'))).toBe(true);
  });
});
