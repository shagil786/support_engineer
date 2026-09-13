# ADR 0008: Risk-Aware Approvals Enforced (Blast Tiers Gate Execution)

Date: 2026-09-13
Status: accepted

## Context
ADR-0007 shipped `src/topology/blast.ts` computing blast-risk tiers
(low / medium / critical, with `approvalsRequired` low→0, medium→1,
critical→2+window) — but they were advisory only: `ApprovalGate` used a
single gate-level `approverCount` (default 2) for every request, nothing
consumed `decision.approverCount` either, and `GovernedDispatch` executed
`allow` decisions with no topology consultation at all. A `failover` on a
critical service could auto-execute exactly like a cache clear.

## Decision
Make the topology's assessment the authoritative approval input, with three
mechanisms:

1. **Per-approval signature floor.** `requiredSignatures(policyCount,
   blast, gateDefault)` = max of the three; blast can only escalate, never
   de-escalate below what policy demanded. `ApprovalGate` computes it per
   approval (request → card/queue/listing → sign → snapshot all read the
   same value) and audits the raised count plus the blast tier/reason on
   the `approval_request` event (`blastRisk`, `blastReason` fields).
2. **Dispatch escalation.** `GovernedDispatch` infers a blast assessment
   from (tool, args) via `inferBlastAssessment` (deterministic: verb +
   service parsed from the runbook id or explicit `service`/`action` args;
   unknown service / verbless id / read-only tool → no assessment, honest
   no-op). Medium/critical escalate even an `allow` into a staged approval
   (audited as a second governance event carrying `blastAssessment` on the
   decision); `require_approval` keeps its semantics but gains the floor.
3. **Maintenance window at execution time.** The gate gains an injectable
   `maintenanceWindow` port (`src/governance/maintenance-window.ts`) and
   `assertExecutable(approvalId)`: critical-risk actions refuse execution
   while the window is closed — fail-closed (no window wired, or a throwing
   port → refuse). `GovernedDispatch.executeApproved` calls it before every
   approved execution; grants alone are not sufficient for critical risk.
   Env: `MAINTENANCE_WINDOW=HH:MM-HH:MM` (server-local, cross-midnight
   allowed); malformed values THROW at boot — a typo must never silently
   open the window.

The assessment rides `GovernanceDecision.blastAssessment` (optional), so it
is present in the audited decision events and the staged approval, and the
gate never trusts agent claims — the dispatch attaches it from the
topology, or it does not exist.

## Consequences
- Wiring a topology immediately tightens governance: `failover-*` runbooks
  against known services can no longer auto-execute, need two distinct
  signatures, and only run inside the window. Unwired topology changes
  nothing (deployment-config, same as every other integration port).
- Low-risk leaf restarts stay one-signature-or-auto per existing policy —
  the floor formula guarantees blast never blocks them beyond policy.
- Queue surfaces (`GET /approvals`, console) now show per-approval
  `required`, so operators see the raised floor on critical requests.
- The approval card view still renders one `required` number; the tier and
  reason are visible in the audit event and the request reason string
  (`blast radius: …`), not as new card UI.
- Test doubles for `ApprovalGate` must expose `assertExecutable` (the
  dispatch calls it unconditionally); fakes without blast assessments
  simply never refuse.
