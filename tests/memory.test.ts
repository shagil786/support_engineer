import { describe, it, expect } from 'vitest';
import { InMemoryKeyValueStore } from '../src/support-voice-agent/memory/store.ts';
import { InMemoryVectorMemory, hashEmbedder, cosine } from '../src/support-voice-agent/memory/vector.ts';
import { SupportVoiceAgent } from '../src/index';
import type { SpeechEvent } from '../src/index';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('InMemoryKeyValueStore', () => {
  it('get/set/delete round-trips and honors TTL', async () => {
    let clock = 1000;
    const kv = new InMemoryKeyValueStore({ now: () => clock });
    await kv.set('k', 'v');
    expect(await kv.get('k')).toBe('v');
    await kv.set('t', 'x', 500);
    clock = 1400;
    expect(await kv.get('t')).toBe('x');
    clock = 1600;
    expect(await kv.get('t')).toBeUndefined(); // expired
    expect(await kv.delete('k')).toBe(true);
    expect(await kv.get('k')).toBeUndefined();
  });
});

describe('InMemoryVectorMemory (RAG)', () => {
  it('hash embedding is deterministic and normalized', () => {
    const a = hashEmbedder('restart the checkout pod after the deploy');
    const b = hashEmbedder('restart the checkout pod after the deploy');
    expect(a).toEqual(b);
    expect(cosine(a, b)).toBeCloseTo(1, 6);
  });

  it('retrieves the most relevant record', async () => {
    const mem = new InMemoryVectorMemory();
    await mem.add({ id: 'r1', text: '[runbook] restart the checkout pod when payments time out after deploy' });
    await mem.add({ id: 'r2', text: '[feedback] users hate the new dark mode colors' });
    await mem.add({ id: 'r3', text: '[alert] P1 checkout latency spike' });
    const hits = await mem.search('payments are timing out after the deploy, should I restart checkout?', 1);
    expect(hits[0]?.id).toBe('r1');
  });

  it('empty store returns no hits', async () => {
    const mem = new InMemoryVectorMemory();
    expect(await mem.search('anything')).toEqual([]);
  });
});

describe('agent memory integration', () => {
  function makeMemoryAgent() {
    const kv = new InMemoryKeyValueStore();
    const vectors = new InMemoryVectorMemory();
    const agent = new SupportVoiceAgent({
      mode: 'response',
      wakeWord: 'hey agent',
      minPauseMs: 1500,
      memory: { kv, vectors },
      now: () => 1_000_000,
    });
    return { agent, kv, vectors };
  }

  it('indexes verbal feedback into vector memory', async () => {
    const { agent, vectors } = makeMemoryAgent();
    agent.processUtterance('U1', 'Users hate the new onboarding flow');
    await flush();
    expect(vectors.size()).toBe(1);
    const hits = await vectors.search('onboarding flow complaints');
    expect(hits[0]?.text).toContain('onboarding');
  });

  it('answers a question from indexed notes via RAG', async () => {
    const { agent, vectors } = makeMemoryAgent();
    await vectors.add({ id: 'rb', text: '[runbook] checkout pod restart fixes post-deploy payment timeouts' });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e) => speech.push(e));
    agent.processUtterance('U1', 'what should we do when payments time out after a deploy?');
    await flush();
    agent.onPause(2000);
    await flush();
    expect(speech.some((e) => e.text.includes('From my notes') && e.text.includes('checkout pod restart'))).toBe(true);
  });

  it('falls back to the honest no-data line when nothing matches', async () => {
    const { agent, vectors } = makeMemoryAgent();
    await vectors.add({ id: 'r', text: '[feedback] someone mentioned the coffee machine' });
    const speech: SpeechEvent[] = [];
    agent.on('speech', (e) => speech.push(e));
    agent.processUtterance('U1', 'what is the status of the kubernetes migration?');
    await flush();
    agent.onPause(2000);
    await flush();
    expect(speech.some((e) => e.text.includes('pull it from Jira'))).toBe(true);
  });

  it('persists the meeting summary to the KV store', async () => {
    const { agent, kv } = makeMemoryAgent();
    agent.processUtterance('U1', 'Users hate the new onboarding flow');
    await flush();
    agent.finishMeeting();
    await flush();
    const stored = await kv.get('summary:1000000');
    expect(stored).toBeTruthy();
    expect(JSON.parse(stored as string)).toHaveProperty('feedback');
  });
});
