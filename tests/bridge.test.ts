import { describe, it, expect } from 'vitest';
import { ScriptedBridge, createVoiceSession, SupportVoiceAgent } from '../src/index';

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function makeSession() {
  const bridge = new ScriptedBridge({ meetingId: 'mtg-1', now: () => 500_000 });
  const agent = new SupportVoiceAgent({
    mode: 'response',
    wakeWord: 'hey agent',
    minPauseMs: 1500,
    now: () => 500_000,
  });
  const session = createVoiceSession(bridge, agent);
  return { bridge, agent, session };
}

describe('voice session over the scripted bridge', () => {
  it('joins, routes transcript → agent → pause-gated speech → bridge', async () => {
    const { bridge, session } = makeSession();
    await session.start();
    expect(bridge.isJoined).toBe(true);

    bridge.emitTranscript('U1', 'hey agent, who is on the support rotation tonight?');
    await flush();
    expect(bridge.spoken).toHaveLength(0); // pause gate holds
    bridge.emitPause(1600);
    await flush();
    expect(bridge.spoken.length).toBeGreaterThan(0);
    await session.stop();
    expect(bridge.isJoined).toBe(false);
  });

  it('urgent barge-in speech reaches the bridge immediately', async () => {
    const { bridge, session } = makeSession();
    await session.start();
    bridge.emitTranscript('U1', 'this is a P1, checkout is down');
    await flush();
    const urgent = bridge.spoken.find((s) => s.urgent);
    expect(urgent?.text).toContain('urgent alert');
  });

  it('echo suppression: the agent never transcribes its own voice', async () => {
    const { bridge, agent, session } = makeSession();
    await session.start();
    const seen: string[] = [];
    const orig = agent.processUtterance.bind(agent);
    agent.processUtterance = (id, text, ts) => { seen.push(`${id}:${text}`); return orig(id, text, ts); };

    bridge.emitTranscript('agent', 'From my notes: restart the pod');
    await flush();
    expect(seen).toHaveLength(0); // filtered before reaching the brain
  });

  it('stop() detaches everything: transcripts after stop are ignored', async () => {
    const { bridge, session } = makeSession();
    await session.start();
    await session.stop();
    bridge.emitTranscript('U1', 'hey agent are you there?');
    await flush();
    expect(bridge.spoken).toHaveLength(0);
  });
});
