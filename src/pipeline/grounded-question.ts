/**
 * GroundedQuestionStage — the KB-first question path (spec §4.2 retrieval).
 *
 * When an answerer is wired, question intents are answered from the
 * knowledge base first: cited spoken speech with no tool call and no LLM
 * dance. Two gates keep this honest:
 *  - live-data questions (current system state) never touch the static KB —
 *    a lexically-similar chunk would otherwise answer "are there fresh
 *    errors right now?" from a postmortem;
 *  - a KB refusal falls through to the governed log-query path, which the
 *    caller stamps with 'logs' provenance on success.
 */
import type { IntentEnvelope } from '../event-log/types.js';
import type { EventLog } from '../event-log/log.js';
import type { GroundedAnswerer } from '../understanding/grounded-answerer.js';
import type { PipelineRouting } from './types.js';

export interface GroundedQuestionStageOptions {
  answerer?: GroundedAnswerer;
  eventLog: EventLog;
  deliverSpeech: (text: string, target?: { channel: string; threadTs: string }) => void;
  now: () => number;
}

export interface GroundedQuestionOutcome {
  /** The envelope asked a question (drives the query_logs proposal downstream). */
  isQuestion: boolean;
  /** Set when the KB answered: the caller returns this routing verbatim. */
  answered?: PipelineRouting;
  /** True when the KB path will not answer (live-data gate or refusal) and
   *  a subsequently-governed log query is the real answer source ('logs'). */
  kbRefused: boolean;
}

export class GroundedQuestionStage {
  private readonly answerer?: GroundedAnswerer;
  private readonly eventLog: EventLog;
  private readonly deliverSpeech: (text: string, target?: { channel: string; threadTs: string }) => void;
  private readonly now: () => number;

  constructor(opts: GroundedQuestionStageOptions) {
    this.answerer = opts.answerer;
    this.eventLog = opts.eventLog;
    this.deliverSpeech = opts.deliverSpeech;
    this.now = opts.now;
  }

  /** Offer a routed utterance to the KB-first path. Returns the spoken
   *  routing when the KB grounded an answer, or the refusal verdict the
   *  governed path needs. */
  async offer(
    cid: string,
    envelope: IntentEnvelope,
    text: string,
    thread?: { channel: string; ts: string },
  ): Promise<GroundedQuestionOutcome> {
    const subKind = envelope.intent.kind === 'meeting_response' ? envelope.intent.subKind : undefined;
    const isQuestion = subKind === 'question';
    // Live-data questions never touch the static KB: a lexically-similar
    // chunk would otherwise answer "are there fresh errors right now?" from
    // a postmortem. The classifier flags these (intent.liveData); absent
    // flag (legacy/heuristic envelopes) keeps KB-first unchanged.
    const liveData =
      envelope.intent.kind === 'meeting_response' &&
      envelope.intent.subKind === 'question' &&
      envelope.intent.liveData === true;

    let kbRefused = false;
    // A skipped KB is a KB that did not answer — same 'logs' provenance.
    if (liveData) kbRefused = true;
    if (isQuestion && this.answerer && !liveData) {
      // Stricter 0.4 floor — spoken answers must be genuinely about the
      // corpus, not trigram-adjacent.
      const grounded = await this.answerer.answer(text, { topK: 4, minScore: 0.4 });
      if (!grounded.refused) {
        this.deliverSpeech(grounded.answer, thread ? { channel: thread.channel, threadTs: thread.ts } : undefined);
        await this.eventLog.append({
          correlationId: cid,
          ts: this.now(),
          layer: 'understanding',
          source: 'internal',
          kind: 'grounded_answer',
          question: text,
          answer: grounded.answer,
          citations: grounded.citations,
          sources: grounded.sources,
          refused: false,
          usedLlm: grounded.usedLlm,
        });
        return {
          isQuestion,
          kbRefused,
          answered: {
            routed: 'pipeline',
            correlationId: cid,
            ok: true,
            answer: grounded.answer,
            answerSource: 'knowledge',
          },
        };
      }
      kbRefused = true;
    }
    return { isQuestion, kbRefused };
  }
}