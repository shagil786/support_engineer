/**
 * The signer trust rule — one definition for every approval surface.
 *
 * Slack reactions, Block Kit clicks, and REST signatures all answer the same
 * question ("is this identity allowed to contribute this signature?") with
 * the same rank comparison. The rule lives here, next to the ranks, so no
 * surface can grow its own copy of the trust boundary (the bug this replaced:
 * the REST sign endpoint used to trust a client-asserted role).
 */
import type { SpeakerRole } from './safety-net/rbac.js';

/** Lifecycle of a staged approval. `executed` is terminal — an approval must
 *  be granted before it can execute, so it is a subset of `granted`, never an
 *  additional outcome in backlog arithmetic. */
export type ApprovalStatus = 'pending' | 'granted' | 'denied' | 'timeout' | 'executed';

/** Thrown when a signature is attempted with a role the server-resolved
 *  identity does not hold. Distinct from the unknown-id 404 so HTTP surfaces
 *  can answer 403 (authenticated, not allowed) honestly. */
export class SignerRoleError extends Error {}

/** Lower rank = more privilege. */
export const ROLE_RANK: Record<SpeakerRole, number> = { admin: 0, engineer: 1, viewer: 2, guest: 3 };

/** Shared signature-privilege rule: a signer may contribute `wanted` only if
 *  their resolved role outranks or equals it. One rule for reactions AND the
 *  REST surface. */
export function roleSatisfies(resolved: SpeakerRole | undefined, wanted: SpeakerRole): boolean {
  if (!resolved) return false;
  return ROLE_RANK[resolved] <= ROLE_RANK[wanted];
}
