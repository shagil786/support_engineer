/** Deterministic in-process bridge for tests and local dev — the scripted
 *  stand-in until a real meeting platform adapter is chosen. */
import type { MeetingBridge, SpeechRequest, TranscriptLine } from './ports';

export interface ScriptedBridgeOptions {
  meetingId?: string;
  /** How long a speak() "plays" (ms of virtual time; resolves immediately
   *  via microtask unless a clock is injected). */
  now?: () => number;
}

export class ScriptedBridge implements MeetingBridge {
  readonly meetingId: string;
  private transcriptFns: Array<(line: TranscriptLine) => void> = [];
  private pauseFns: Array<(durationMs: number) => void> = [];
  private joined = false;
  private speaking = false;
  /** Everything the agent tried to say, in order — assert against this. */
  readonly spoken: SpeechRequest[] = [];
  private readonly now: () => number;

  constructor(opts: ScriptedBridgeOptions = {}) {
    this.meetingId = opts.meetingId ?? 'fake-meeting';
    this.now = opts.now ?? Date.now;
  }

  async join(): Promise<void> {
    if (this.joined) throw new Error('already joined');
    this.joined = true;
  }

  async leave(): Promise<void> {
    this.joined = false;
  }

  get isJoined(): boolean {
    return this.joined;
  }

  onTranscript(fn: (line: TranscriptLine) => void): () => void {
    this.transcriptFns.push(fn);
    return () => { this.transcriptFns = this.transcriptFns.filter((f) => f !== fn); };
  }

  onPause(fn: (durationMs: number) => void): () => void {
    this.pauseFns.push(fn);
    return () => { this.pauseFns = this.pauseFns.filter((f) => f !== fn); };
  }

  async speak(req: SpeechRequest): Promise<void> {
    this.spoken.push(req);
    this.speaking = true;
    // Simulate playback finishing on the next microtask.
    await Promise.resolve();
    this.speaking = false;
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  /* ---- test/script controls ---- */

  /** Simulate a finalized transcript line arriving from STT. */
  emitTranscript(speakerId: string, text: string, ts = this.now()): void {
    const line = { speakerId, text, ts };
    for (const fn of this.transcriptFns) fn(line);
  }

  /** Simulate the pause detector measuring `durationMs` of silence. */
  emitPause(durationMs: number): void {
    for (const fn of this.pauseFns) fn(durationMs);
  }
}
