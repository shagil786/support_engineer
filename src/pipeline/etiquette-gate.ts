/**
 * EtiquetteGate — talk-permission (mute/wake) as a pipeline-owned stage
 * (two-brain consolidation, pass one).
 *
 * Why: the legacy cascade treats mute as conversation state buried at step 1
 * of agent.ts, entangled with the legacy brain's speech queue — the pipeline
 * never respected it (a muted meeting still got KB answers). Here the mute
 * state has one owner in orchestrated mode, and the legacy agent never even
 * learns that a mute happened (no muted event, no pendingSpeech clearing on
 * its side). Outcomes match the cascade's pinned semantics exactly; only the
 * ownership moves.
 *
 * Standalone hosts (the voice bridge driving SupportVoiceAgent directly) are
 * untouched: the legacy cascade keeps its own etiquette there.
 *
 * Flow position: the pipeline offers every utterance to the gate after
 * classification and before routing, so a mute window also swallows
 * pipeline-routed work (questions, runbooks) — the ownership bug this pass
 * exists to fix. The gate uses the same regexes as the cascade
 * (heuristics.ts), so classification differences cannot split the two
 * brains' opinions on what a mute is.
 */
import {
  containsWakeWord,
  isBareWakeWord,
  isCriticalDeclaration,
  isShutUpCommand,
  DEFAULT_MUTE_DURATION_MS,
} from '../support-voice-agent/heuristics.js';

export interface EtiquetteResult {
  /** True when this utterance is etiquette and fully handled. */
  handled: boolean;
  /** Routing fields when handled (absent otherwise). */
  ok?: boolean;
  reason?: string;
}

export interface EtiquetteGateOptions {
  /** Where greetings are spoken (the pipeline's speech port). */
  deliverSpeech?: (text: string) => void;
  /** How long "agent, shut up" mutes the agent (cascade default: 5 min). */
  muteDurationMs?: number;
}

export class EtiquetteGate {
  private mutedUntil = 0;
  private readonly deliverSpeech?: (text: string) => void;
  private readonly muteDurationMs: number;

  constructor(opts: EtiquetteGateOptions = {}) {
    this.deliverSpeech = opts.deliverSpeech;
    this.muteDurationMs = opts.muteDurationMs ?? DEFAULT_MUTE_DURATION_MS;
  }

  /** True while the agent is muted at time ts ("agent, shut up"). */
  isMuted(ts: number): boolean {
    return this.mutedUntil > ts;
  }

  /**
   * Offer an utterance to the gate. The five pinned cases, identical to
   * agent.ts steps 1/2/3/10:
   *   1. "agent, shut up"            → mute, swallow.
   *   2. muted + bare wake word      → greet ("Yes, I'm here…"), re-arm.
   *   3. muted + wake-wrapped text   → re-arm silently (the muted utterance
   *      itself is never answered).
   *   4. muted + neither             → swallow.
   *   5. unmuted + bare wake word    → greet.
   * Critical declarations always pass through (urgent signals break through
   * the mute window — cascade step 3 precedes the mute swallow), as does any
   * non-etiquette utterance (handled: false).
   */
  offer(_speakerId: string, text: string, ts: number): EtiquetteResult {
    // 1. "Agent, shut up" → mute until wake word or expiry.
    if (isShutUpCommand(text)) {
      this.mutedUntil = ts + this.muteDurationMs;
      return { handled: true, ok: true, reason: 'muted' };
    }

    const mutedBefore = this.isMuted(ts);
    const wake = containsWakeWord(text);
    if (wake) this.mutedUntil = 0; // any wake re-arms (cascade step 2)

    // Urgent declarations are never ours to swallow — the legacy cascade
    // barges in on them regardless of mute state.
    if (isCriticalDeclaration(text)) return { handled: false };

    if (mutedBefore) {
      if (wake) {
        if (isBareWakeWord(text)) this.deliverSpeech?.("Yes, I'm here. What do you need?");
        return { handled: true, ok: true, reason: 'woken' };
      }
      return { handled: true, ok: true, reason: 'muted' };
    }

    // Unmuted bare wake word with nothing else to answer → greeting.
    if (wake && isBareWakeWord(text)) {
      this.deliverSpeech?.("Yes, I'm here. What do you need?");
      return { handled: true, ok: true, reason: 'greeted' };
    }
    return { handled: false };
  }
}
