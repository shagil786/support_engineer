/**
 * Prompt-injection veto — delegates to today's isPromptInjection heuristic
 * so detection behavior is identical to the legacy agent. Never
 * reimplemented here: the legacy module stays the single source of truth.
 */
import { isPromptInjection as legacy } from '../../support-voice-agent/heuristics.js';

export interface VetoResult {
  vetoed: boolean;
  reason: string;
}

export class Injection {
  check(text: string): VetoResult {
    if (legacy(text)) return { vetoed: true, reason: 'prompt-injection pattern detected' };
    return { vetoed: false, reason: '' };
  }
}
