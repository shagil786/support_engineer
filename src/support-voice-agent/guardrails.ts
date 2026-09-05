/** Layer 4 — Orchestration guardrails: RBAC, destructive-action approval,
 *  prompt-injection response, and API-failure escalation.
 *
 *  These are deterministic controls: they never route through the LLM, and
 *  the LLM's tool handlers consult them as a hard gate. A denied action stays
 *  denied even if the model insists.
 */

import type { SlackNotifier } from './integrations/slack';

export type SpeakerRole = 'admin' | 'engineer' | 'viewer' | 'guest';

/** Registry mapping meeting speaker ids to roles. Unknown speakers are
 *  treated as 'guest' (least privilege) — the agent must never guess. */
export type SpeakerRegistry = (speakerId: string) => SpeakerRole | undefined;

export interface GuardrailsConfig {
  /** Who is who. Undefined registry = every speaker is a guest (safe default). */
  speakers?: SpeakerRegistry;
  /** Roles allowed to approve destructive runbook actions. Default: admin only. */
  approverRoles?: SpeakerRole[];
  /** Slack channel to page when an action is refused or an injection is caught. */
  securityChannel?: string;
  /** Slack channel to page when a backend API (Jira/Slack) fails. */
  infraChannel?: string;
  notifier?: SlackNotifier;
}

export interface ApprovalDecision {
  allowed: boolean;
  reason: string;
  /** Set when the agent should page an approver instead of executing. */
  pageApprover?: boolean;
}

export class Guardrails {
  private readonly cfg: Required<Pick<GuardrailsConfig, 'approverRoles'>> & GuardrailsConfig;

  constructor(cfg: GuardrailsConfig = {}) {
    this.cfg = { approverRoles: ['admin'], ...cfg };
  }

  roleOf(speakerId: string): SpeakerRole {
    return this.cfg.speakers?.(speakerId) ?? 'guest';
  }

  isApprover(speakerId: string): boolean {
    return this.cfg.approverRoles.includes(this.roleOf(speakerId));
  }

  /** Hard gate for destructive runbook actions. */
  checkDestructive(speakerId: string): ApprovalDecision {
    if (this.isApprover(speakerId)) {
      return { allowed: true, reason: `${speakerId} is an approved approver` };
    }
    return {
      allowed: false,
      pageApprover: Boolean(this.cfg.notifier && this.cfg.securityChannel),
      reason: `${speakerId} (${this.roleOf(speakerId)}) cannot approve destructive actions`,
    };
  }

  /** Spec: on refusal/injection, page the security channel when wired. */
  async pageSecurity(message: string): Promise<boolean> {
    if (!this.cfg.notifier || !this.cfg.securityChannel) return false;
    try {
      await this.cfg.notifier.postMessage(this.cfg.securityChannel, message);
      return true;
    } catch {
      return false;
    }
  }

  /** Spec: on backend failure, "I have also alerted the infrastructure team via Slack." */
  async pageInfra(message: string): Promise<boolean> {
    if (!this.cfg.notifier || !this.cfg.infraChannel) return false;
    try {
      await this.cfg.notifier.postMessage(this.cfg.infraChannel, message);
      return true;
    } catch {
      return false;
    }
  }
}
