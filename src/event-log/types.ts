/**
 * Cross-layer event substrate (spec §8). Every layer emits; only Learning,
 * the Supervisor's recent-decisions window, and SafetyNet audit replay read
 * from it.
 *
 * All events carry `correlationId`, `ts`, `layer`, and `source`.
 */
import type { ToolName, ToolResult } from '../support-voice-agent/tools/types.js';
import type { Severity } from '../support-voice-agent/types.js';

export type EventLayer = 'understanding' | 'governance' | 'execution' | 'learning' | 'surface';

export type EventSource =
  | 'meeting' | 'jira' | 'slack' | 'cloudwatch' | 'splunk' | 'cron' | 'internal';

/** One classification of a raw input into an actionable envelope. */
export interface IntentEnvelope {
  intent:
    | { kind: 'meeting_response'; subKind: 'question' | 'feedback' | 'runbook_offer' | 'complaint' | 'critical' | 'mute' | 'wake' }
    | { kind: 'async_triage'; subKind: 'incident' | 'service_request' | 'question' | 'fyi' }
    | { kind: 'proactive_alert'; subKind: 'incident' | 'anomaly' | 'slo_breach' }
    | { kind: 'human_action'; subKind: 'approval' | 'rejection' | 'edit' | 'answer' }
    | { kind: 'unknown' };
  confidence: number;
  entities: {
    ticketKeys?: string[];
    runbookIds?: string[];
    services?: string[];
    severity?: Severity;
    speakerId?: string;
    /** Provider-confirmed destructiveness of the referenced runbooks.
     *  Additive, optional flag — envelopes without it fall back to the
     *  id-scope heuristic in policy evaluation. */
    runbookDestructive?: boolean;
  };
  rawContext: { source: EventSource; ts: number; payload: unknown };
}

/** A governance decision over a proposed action. */
export interface Decision {
  effect: 'allow' | 'deny' | 'require_approval' | 'transform';
  reason: string;
  policyIds: string[];
  /** Set when effect is 'transform'. */
  transformedAction?: unknown;
  /** Set by the SafetyNet on every check; downstream code honors this flag. */
  unconditionalSafetyNetCheck?: boolean;
}

interface BaseEvent {
  correlationId: string;
  ts: number;
  layer: EventLayer;
  source: EventSource;
}

export type DecisionEvent =
  | (BaseEvent & { kind: 'understanding'; envelope: IntentEnvelope; contextBundleRef: string })
  | (BaseEvent & { kind: 'governance'; intent: IntentEnvelope; decision: Decision })
  | (BaseEvent & { kind: 'safety_net'; vetoed: boolean; check: string; reason: string })
  | (BaseEvent & { kind: 'approval_request'; approvalId: string; policyId: string; approver_count: number })
  | (BaseEvent & { kind: 'approval_granted'; approvalId: string; signerRole: string })
  | (BaseEvent & { kind: 'approval_timeout'; approvalId: string })
  | (BaseEvent & { kind: 'tool_call'; tool: ToolName; args: unknown; result: ToolResult; latencyMs: number; attempts: number })
  | (BaseEvent & {
      kind: 'agent_outcome';
      finalResult: { ok: boolean; summary: string };
      /** Additive (optional) execution stats — present on events emitted by
       *  the SupervisorAgent for efficacy measurement. Legacy events omit it. */
      stats?: {
        source: 'pipeline' | 'procedure';
        hops: number;
        toolCalls: number;
        wallClockMs: number;
        /** Set when source === 'procedure'. */
        procedureId?: string;
        /** Set when a procedure attempt degraded to the pipeline. */
        fallbackFrom?: string;
      };
    })
  | (BaseEvent & { kind: 'policy_suggested'; suggestionId: string })
  | (BaseEvent & { kind: 'policy_promoted'; policyId: string; bundleSha: string; promotedBy: string[] })
  | (BaseEvent & { kind: 'knowledge_extracted'; procedureId: string });

const KINDS: readonly DecisionEvent['kind'][] = [
  'understanding', 'governance', 'safety_net',
  'approval_request', 'approval_granted', 'approval_timeout',
  'tool_call', 'agent_outcome',
  'policy_suggested', 'policy_promoted', 'knowledge_extracted',
];

/** Runtime guard for events read back from an untrusted stream. */
export function isDecisionEvent(x: unknown): x is DecisionEvent {
  if (typeof x !== 'object' || x === null) return false;
  const k = (x as { kind?: unknown }).kind;
  return typeof k === 'string' && (KINDS as readonly string[]).includes(k);
}

export type DecisionEventOf<K extends DecisionEvent['kind']> = Extract<DecisionEvent, { kind: K }>;
