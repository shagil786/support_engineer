# ADR-0005: Server-side signer-role resolution on the approval surface

**Status:** Accepted (2026-09-09)

## Context

The approval gate enforces who may grant a destructive action, but the two
surfaces that deliver signatures disagreed about who decides the signer's
role. The Slack path resolved the role server-side from the Slack user id
(via `platform.speakerRole`) and rank-checked it against the mapped role —
"a reaction is a claim, not a credential." The REST path trusted the request
body: `POST /approvals/:id/sign` accepted a client-asserted `role` field and
passed it straight to the gate.

A live audit probe demonstrated the resulting escalation: any bearer-token
holder could submit `{"role":"admin","signerId":"guest-person"}` and grant a
destructive db-failover that the same identity could never have staged. In a
product whose core value is governed execution, the approval surface itself
was the weakest boundary.

There was a second, quieter gap: the `approval_granted` event recorded the
granting role but no signer identity, so the audit spine could prove *that*
two signatures landed but never *who* signed.

## Decision

1. **Identity, not assertion.** The REST sign contract is now
   `POST /approvals/:id/sign { signerId }` — the client supplies WHO; the
   server resolves WHAT THAT IS WORTH. `ApprovalGate.signAs(approvalId,
   signerId)` resolves the role through the same `resolveSignerRole` registry
   the SafetyNet uses (`speakerRole` in bootstrap), rank-checks it against
   the gate's `approverRoles` (default: admin only) using the shared
   `roleSatisfies`/`ROLE_RANK` rule from the reaction path, dedupes by
   resolved identity, and throws `SignerRoleError` on insufficient
   privilege. The HTTP layer maps that to **403** (authenticated, not
   allowed) and keeps unknown ids at 404 — the id is validated first so role
   resolution never runs against nonexistent approvals.

2. **One rule, two surfaces.** The rank rule lives once in the gate next to
   `ROLE_RANK`; reactions and REST signatures both call into it. The trust
   boundary is a property of the gate, not of whichever route happened to
   remember it.

3. **Attribution.** `approval_granted` events now carry `signerIds: string[]`
   — the resolved identities at grant time — so the spine answers "who
   granted what" without reconstructing from side channels.

4. **Client simplification.** The console sends only `signerId`; the
   hardcoded `role: 'admin'` is gone.

## Consequences

- A stolen bearer token can no longer grant destructive actions on its own;
  it must also hold an approver identity in the platform registry. Bearer
  tokens authenticate the *channel*, the speaker registry authorizes the
  *actor*.
- Hosts that never configure `speakerRole` keep the legacy trust-the-caller
  fallback (documented, test-pinned) — least surprise for embedders, with
  the secure path as the default wiring in `createPlatform`.
- The 400 (missing `signerId`) / 403 (insufficient role) / 404 (unknown id)
  split is now part of the public API contract and is pinned by tests,
  including the escalation attempt that motivated this ADR.
