/** Host glue: composes a MeetingBridge with a SupportVoiceAgent.
 *
 *  This is exactly the wiring the Freebuff Desktop host will do with a real
 *  meeting adapter — transcript in, speech out, pause events both ways, and
 *  echo suppression so the agent never transcribes its own TTS.
 */

import type { MeetingBridge } from './ports';
import type { SupportVoiceAgent } from '../agent';

export interface VoiceSession {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface VoiceSessionOptions {
  /** Speaker id the STT will tag for the agent itself; lines from this
   *  speaker are ignored (echo suppression) unless allowSelfTranscript. */
  agentSpeakerId?: string;
  /** Default: ignore agent-speaker transcript lines. */
  allowSelfTranscript?: boolean;
}

export function createVoiceSession(
  bridge: MeetingBridge,
  agent: SupportVoiceAgent,
  opts: VoiceSessionOptions = {},
): VoiceSession {
  const agentSpeakerId = opts.agentSpeakerId ?? 'agent';
  let unsubscribes: Array<() => void> = [];

  return {
    async start() {
      await bridge.join();
      const offTranscript = bridge.onTranscript((line) => {
        // Echo suppression: never feed the agent's own voice back as input.
        if (!opts.allowSelfTranscript && line.speakerId === agentSpeakerId) return;
        if (bridge.isSpeaking()) return; // TTS playback bleed
        agent.processUtterance(line.speakerId, line.text, line.ts);
      });
      const offPause = bridge.onPause((durationMs) => agent.onPause(durationMs));
      const offSpeech = agent.on('speech', (event) => {
        void bridge.speak({ text: event.text, urgent: event.urgent });
      });
      unsubscribes = [offTranscript, offPause, offSpeech];
    },
    async stop() {
      for (const off of unsubscribes) off();
      unsubscribes = [];
      await bridge.leave();
    },
  };
}
