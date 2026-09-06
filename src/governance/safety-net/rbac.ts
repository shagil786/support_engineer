/**
 * RBAC check for the SafetyNet — ported from Guardrails (RBAC only).
 *
 * Destructive tools require an approver-role speaker; unknown speakers are
 * treated as 'guest' (least privilege). Role assignment itself stays in the
 * SpeakerRegistry, never in policy data.
 */
export type SpeakerRole = 'admin' | 'engineer' | 'viewer' | 'guest';
export type SpeakerRegistry = (speakerId: string) => SpeakerRole | undefined;

export interface RbacOptions {
  speakers?: SpeakerRegistry;
  approverRoles?: SpeakerRole[];
}

export interface RbacDecision {
  allowed: boolean;
  reason: string;
}

/** Tools that mutate shared infrastructure. Mirrors Guardrails.checkDestructive:
 *  today's behavior gates execute_runbook_script (destructive runbooks), so
 *  the governance layer gates the same surface. */
const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set(['execute_runbook_script']);

export class Rbac {
  private readonly speakers: SpeakerRegistry;
  private readonly approverRoles: readonly SpeakerRole[];

  constructor(opts: RbacOptions = {}) {
    this.speakers = opts.speakers ?? (() => undefined);
    this.approverRoles = opts.approverRoles ?? ['admin'];
  }

  roleOf(speakerId: string): SpeakerRole {
    return this.speakers(speakerId) ?? 'guest';
  }

  isApprover(speakerId: string): boolean {
    return this.approverRoles.includes(this.roleOf(speakerId));
  }

  check(speakerId: string, tool: string): RbacDecision {
    if (DESTRUCTIVE_TOOLS.has(tool) && !this.isApprover(speakerId)) {
      return {
        allowed: false,
        reason: `destructive tool '${tool}' requires approver role (${this.roleOf(speakerId)} cannot approve)`,
      };
    }
    return { allowed: true, reason: `role ${this.roleOf(speakerId)} permitted for ${tool}` };
  }
}
