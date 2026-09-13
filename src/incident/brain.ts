/**
 * Incident Brain — Alert → Understand impact → Investigate → root cause →
 * propose fix → approval → Execute → Verify → Learn.
 *
 * A durable-state-machine SHAPE for one incident, not a runtime: every
 * transition is a pure function over an IncidentRecord, so hosts can persist
 * the record (Temporal, Postgres, JSONL) and resume after restarts. The live
 * Supervisor/ApprovalGate/Verifier remain the executors — this module only
 * owns the incident's LIFECYCLE and its timeline.
 */
import { rankHypotheses, type HypothesisInput, type RankedHypothesis } from '../evidence/hypotheses.js';

export type IncidentPhase =
  | 'alert'
  | 'impact'
  | 'investigating'
  | 'root_cause'
  | 'proposed'
  | 'awaiting_approval'
  | 'executing'
  | 'verifying'
  | 'resolved'
  | 'escalated';

export interface IncidentImpact {
  service: string;
  severity: 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
  summary: string;
  /** Blast radius: services that could be affected (topology engine fills this). */
  blastRadius?: string[];
}

export interface IncidentRecord {
  id: string;
  phase: IncidentPhase;
  impact?: IncidentImpact;
  hypotheses: RankedHypothesis[];
  approvedHypothesis?: string;
  approvalId?: string;
  remediation?: { action: string; verified: boolean };
  timeline: string[];
  updatedAt: number;
}

export function createIncident(id: string, now: number): IncidentRecord {
  return { id, phase: 'alert', hypotheses: [], timeline: [`${now}: alert received`], updatedAt: now };
}

function step(record: IncidentRecord, phase: IncidentPhase, line: string, now: number): IncidentRecord {
  return { ...record, phase, timeline: [...record.timeline, `${now}: ${line}`], updatedAt: now };
}

export function assessImpact(record: IncidentRecord, impact: IncidentImpact, now: number): IncidentRecord {
  if (record.phase !== 'alert') throw new Error(`assessImpact: incident ${record.id} is ${record.phase}, expected alert`);
  return step({ ...record, impact }, 'impact', `impact assessed: ${impact.service} ${impact.severity} — ${impact.summary}`, now);
}

export function beginInvestigation(record: IncidentRecord, now: number): IncidentRecord {
  if (record.phase !== 'impact') throw new Error(`beginInvestigation: incident ${record.id} is ${record.phase}, expected impact`);
  return step(record, 'investigating', 'investigation started', now);
}

export function attachHypotheses(
  record: IncidentRecord,
  graph: Parameters<typeof rankHypotheses>[0],
  hypotheses: HypothesisInput[],
  now: number,
): IncidentRecord {
  if (record.phase !== 'investigating') throw new Error(`attachHypotheses: incident ${record.id} is ${record.phase}, expected investigating`);
  const ranked = rankHypotheses(graph, hypotheses);
  const top = ranked[0];
  return step(
    { ...record, hypotheses: ranked },
    'root_cause',
    top ? `likely root cause: ${top.claim} (${Math.round(top.confidence * 100)}% confidence)` : 'no hypotheses',
    now,
  );
}

export function proposeFix(record: IncidentRecord, fix: string, now: number): IncidentRecord {
  if (record.phase !== 'root_cause') throw new Error(`proposeFix: incident ${record.id} is ${record.phase}, expected root_cause`);
  return step({ ...record, remediation: { action: fix, verified: false } }, 'proposed', `fix proposed: ${fix}`, now);
}

export function awaitApproval(record: IncidentRecord, approvalId: string, now: number): IncidentRecord {
  if (record.phase !== 'proposed') throw new Error(`awaitApproval: incident ${record.id} is ${record.phase}, expected proposed`);
  return step({ ...record, approvalId }, 'awaiting_approval', `awaiting approval ${approvalId}`, now);
}

export function beginExecution(record: IncidentRecord, now: number): IncidentRecord {
  if (record.phase !== 'awaiting_approval') throw new Error(`beginExecution: incident ${record.id} is ${record.phase}, expected awaiting_approval`);
  return step(record, 'executing', `executing ${record.remediation?.action ?? 'fix'}`, now);
}

export function beginVerification(record: IncidentRecord, now: number): IncidentRecord {
  if (record.phase !== 'executing') throw new Error(`beginVerification: incident ${record.id} is ${record.phase}, expected executing`);
  return step(record, 'verifying', 'verifying remediation', now);
}

export function resolve(record: IncidentRecord, now: number): IncidentRecord {
  if (record.phase !== 'verifying') throw new Error(`resolve: incident ${record.id} is ${record.phase}, expected verifying`);
  return step(
    { ...record, remediation: record.remediation ? { ...record.remediation, verified: true } : undefined },
    'resolved',
    'incident mitigation confirmed',
    now,
  );
}

export function escalate(record: IncidentRecord, reason: string, now: number): IncidentRecord {
  return step(record, 'escalated', `escalated: ${reason}`, now);
}

/** Serialize for durable hosts (Temporal payload, Postgres row, JSONL line). */
export function serialize(record: IncidentRecord): string {
  return JSON.stringify(record);
}

export function deserialize(raw: string): IncidentRecord {
  const parsed = JSON.parse(raw) as IncidentRecord;
  if (typeof parsed.id !== 'string' || typeof parsed.phase !== 'string' || !Array.isArray(parsed.timeline)) {
    throw new Error('deserialize: not an IncidentRecord');
  }
  return parsed;
}
