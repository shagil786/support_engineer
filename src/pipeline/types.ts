/**
 * Shared vocabulary for the pipeline split: the routing result surface, the
 * staged-approval record, and the internal dispatch context threaded through
 * the pipeline stages.
 */
import type { ToolName } from '../support-voice-agent/tools/types.js';
import type { ApprovalSnapshot } from '../governance/approval-gate.js';
import type { Decision } from '../governance/decision.js';

/** Result of routing one input through the pipeline. */
export interface PipelineRouting {
  /** 'etiquette': handled by the pipeline's mute/wake gate (no downstream
   *  brain saw it). 'legacy': the cascade (action etiquette, chatter,
   *  fallback). 'pipeline': governed work. */
  routed: 'pipeline' | 'legacy' | 'etiquette';
  correlationId: string;
  ok?: boolean;
  reason?: string;
  approvalId?: string;
  approvalStatus?: ApprovalSnapshot['status'];
  /** Present on legacy fallback: the wrapper re-dispatched into the cascade. */
  legacyFallback?: boolean;
  /** Grounded-answer fields: present when a question was answered from the
   *  knowledge base ('knowledge') or, on KB refusal, from governed log
   *  query results ('logs'). Absent for legacy/etiquette routes and when no
   *  answerer is wired. */
  answer?: string;
  answerSource?: 'knowledge' | 'logs';
}

/** A staged action awaiting (or holding) an approval grant. */
export interface ApprovedAction {
  approvalId: string;
  correlationId: string;
  action: { tool: ToolName; args: Record<string, unknown> };
  decision: Decision;
}

/** Internal dispatch context threaded through the pipeline stages. */
export interface DispatchContext {
  correlationId: string;
  speakerId: string;
  text: string;
  meetingScope?: boolean;
  meetingId?: string;
  thread?: { channel: string; ts: string };
}