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
