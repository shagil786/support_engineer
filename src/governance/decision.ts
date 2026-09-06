/**
 * Governance layer types. See spec §5.2.
 *
 * Invariant: Execution can only invoke ToolRunner with a GovernedAction
 * of kind 'execute' or a resolved 'request_approval'. The TypeScript
 * signature on ToolRunner enforces this at the call site.
 *
 * Deviation from the plan text: ProposedAction binds to the real ToolName
 * union ('jira_create_issue' etc.), not the spec's dotted names — the
 * dotted names do not exist in this codebase (decided in Phase 1).
 */
import type { ToolName } from '../support-voice-agent/tools/types.js';

export interface ProposedAction {
  tool: ToolName;
  args: Record<string, unknown>;
}

export interface Decision {
  effect: 'allow' | 'deny' | 'require_approval' | 'transform';
  reason: string;
  policyIds: string[];
  /** Set when effect is 'transform'. */
  transformedAction?: ProposedAction;
  /** Set by SafetyNet on every check; downstream code honors this flag. */
  unconditionalSafetyNetCheck?: boolean;
}

/** A Decision with the approval constraints a matching policy attaches.
 *  ApprovalGate consumes these when staging the human approval. */
export interface GovernanceDecision extends Decision {
  /** Required approver role (from the matched rule). */
  approverRole?: string;
  /** Number of distinct signatures required (M-of-N). */
  approverCount?: number;
  /** How long the approval stays open. */
  timeoutSeconds?: number;
  /** What happens when the approval times out. */
  onTimeout?: 'allow' | 'deny';
}

export type GovernedAction =
  | { kind: 'execute';         action: ProposedAction; decision: Decision }
  | { kind: 'request_approval'; action: ProposedAction; decision: Decision; approvalId: string }
  | { kind: 'deny';             decision: Decision };

export function isGovernedAction(x: unknown): x is GovernedAction {
  if (typeof x !== 'object' || x === null) return false;
  const k = (x as { kind?: unknown }).kind;
  return k === 'execute' || k === 'request_approval' || k === 'deny';
}
