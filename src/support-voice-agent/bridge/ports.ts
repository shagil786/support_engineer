/** Layer 3 — Voice/platform connector ports.
 *
 *  The agent brain stays host-agnostic. These ports are the contract the
 *  future host (Freebuff Desktop / a meeting bot) implements against real
 *  vendors: meeting platform (Meet/Teams/Zoom/Slack huddle), STT (Deepgram...),
 *  TTS (ElevenLabs...), and the pause detector.
 *
 *  Nothing here imports a vendor SDK; fakes in bridge/fakes.ts keep the
 *  pipeline testable until vendors are chosen.
 */

/** One finalized transcript line from the meeting (interim results are the
 *  STT adapter's problem, not the agent's). */
export interface TranscriptLine {
  speakerId: string;
  text: string;
  /** Epoch ms of utterance end. */
  ts: number;
}

/** Speech the agent wants spoken, with barge-in urgency. */
export interface SpeechRequest {
  text: string;
  urgent: boolean;
}

/** The meeting connection: who's here, and how audio/text flows. */
export interface MeetingBridge {
  /** Stable id for this meeting instance. */
  readonly meetingId: string;
  join(): Promise<void>;
  leave(): Promise<void>;
  /** Subscribe to finalized transcript lines. Returns unsubscribe. */
  onTranscript(fn: (line: TranscriptLine) => void): () => void;
  /** Measured silence after the last utterance (drives the 1.5s pause gate). */
  onPause(fn: (durationMs: number) => void): () => void;
  /** Play agent speech through the meeting audio. Resolves when playback ends. */
  speak(req: SpeechRequest): Promise<void>;
  /** True while the agent's own TTS is playing — adapters must not feed
   *  agent speech back in as transcript (echo suppression). */
  isSpeaking(): boolean;
}

/** STT port: adapters turn vendor transcripts into TranscriptLine streams.
 *  Defined for completeness — MeetingBridge composes it; host adapters may
 *  implement this to standardize their internal wiring. */
export interface SpeechToText {
  start(): Promise<void>;
  stop(): Promise<void>;
  onFinal(fn: (line: TranscriptLine) => void): () => void;
  onPartial?(fn: (partial: { speakerId: string; text: string }) => void): () => void;
}

/** TTS port. */
export interface TextToSpeech {
  /** Synthesize to audio bytes/wav/pcm — the bridge plays it. */
  synthesize(text: string, opts?: { urgent?: boolean }): Promise<ArrayBuffer>;
}

/** Vendor-neutral meeting-join config. The chosen platform adapter interprets
 *  it (meet url, teams thread id, zoom id, slack huddle channel...). */
export interface MeetingTarget {
  platform: 'meet' | 'teams' | 'zoom' | 'slack-huddle' | 'fake';
  url?: string;
  id?: string;
  displayName?: string;
}
