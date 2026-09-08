/**
 * ProposalShaper — the single place that turns a classified envelope into
 * the tool proposal governance will evaluate (the "what would we do" step
 * before the "may we" step).
 *
 * Three shapes, one module, so proposal policies (defaults, arg limits,
 * tool substitution) never scatter across the ingress:
 *  - questions  → a read-only `query_logs` scoped to the ticket/service the
 *    classifier extracted (the only registry tool that answers a status
 *    question directly);
 *  - everything else routed here (proactive alerts, non-question meeting
 *    responses) → a `meeting_interrupt` summarizing severity + services;
 *  - resolved runbook offers → `execute_runbook_script` with the concrete
 *    action id (the resolver owns matching; this owns the proposal shape).
 */
import type { IntentEnvelope } from '../event-log/types.js';
import type { ProposedAction } from '../governance/decision.js';
import type { ResolvedRunbook } from './runbook-resolver.js';

/** The log query a question proposes: the extracted ticket key first (a
 *  "what's the status of SUPPORT-7?" question IS the ticket), then the
 *  extracted service, then the generic error sweep. */
export function logQueryFrom(envelope: IntentEnvelope): string {
  const ticket = envelope.entities.ticketKeys?.[0];
  if (ticket) return ticket;
  const svc = envelope.entities.services?.[0];
  if (svc) return svc;
  return 'errors';
}

/** The interrupt message a non-question dispatch proposes: severity and
 *  affected services when the classifier extracted them, else the honest
 *  generic. */
export function interruptMessageFrom(envelope: IntentEnvelope): string {
  const parts: string[] = [];
  if (envelope.entities.severity) parts.push(envelope.entities.severity);
  if (envelope.entities.services?.length) parts.push(envelope.entities.services.join(', '));
  return parts.length ? parts.join(' ') : 'proactive alert';
}

/** Question intents propose a read-only log query; everything else that
 *  reaches this point proposes speaking an interrupt. */
export function shapeProposal(envelope: IntentEnvelope, isQuestion: boolean): ProposedAction {
  return isQuestion
    ? { tool: 'query_logs', args: { query_string: logQueryFrom(envelope) } }
    : { tool: 'meeting_interrupt', args: { message: interruptMessageFrom(envelope) } };
}

/** A resolved runbook offer becomes an execute proposal for the concrete
 *  action id; the resolver's destructive flag (carried on the enriched
 *  envelope) is what policy evaluates, not this shape. */
export function runbookProposal(resolved: ResolvedRunbook): ProposedAction {
  return { tool: 'execute_runbook_script', args: { script_name: resolved.id } };
}
