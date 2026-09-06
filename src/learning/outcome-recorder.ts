/**
 * OutcomeRecorder (spec §7): joins all DecisionEvents for one correlationId
 * into a single OutcomeRecord persisted under var/outcomes/. Downstream
 * learners (SuggestionQueue, KnowledgeExtractor) read these files — the
 * event log stays append-only, outcomes are the derived, queryable view.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EventLog } from '../event-log/log.js';
import type { DecisionEvent, DecisionEventOf } from '../event-log/types.js';

type ToolCallEvent = DecisionEventOf<'tool_call'>;
type AgentOutcomeEvent = DecisionEventOf<'agent_outcome'>;
type ApprovalGrantedEvent = DecisionEventOf<'approval_granted'>;

export interface OutcomeRecord {
  correlationId: string;
  toolCalls: ToolCallEvent[];
  finalResult?: AgentOutcomeEvent['finalResult'];
  approvals: ApprovalGrantedEvent[];
  ts: number;
}

export interface OutcomeRecorderOptions {
  eventLog: EventLog;
  outcomesDir: string;
  now?: () => number;
}

export class OutcomeRecorder {
  private readonly eventLog: EventLog;
  private readonly outcomesDir: string;
  private readonly now: () => number;

  constructor(opts: OutcomeRecorderOptions) {
    this.eventLog = opts.eventLog;
    this.outcomesDir = opts.outcomesDir;
    this.now = opts.now ?? Date.now;
  }

  async record(correlationId: string): Promise<OutcomeRecord | undefined> {
    const events: DecisionEvent[] = [];
    for await (const e of this.eventLog.query({ correlationId })) events.push(e);
    if (events.length === 0) return undefined;

    const toolCalls = events.filter((e): e is ToolCallEvent => e.kind === 'tool_call');
    const final = events.find((e): e is AgentOutcomeEvent => e.kind === 'agent_outcome');
    const approvals = events.filter((e): e is ApprovalGrantedEvent => e.kind === 'approval_granted');

    const outcome: OutcomeRecord = {
      correlationId,
      toolCalls,
      ...(final ? { finalResult: final.finalResult } : {}),
      approvals,
      ts: this.now(),
    };
    await mkdir(this.outcomesDir, { recursive: true });
    await writeFile(join(this.outcomesDir, `${correlationId}.json`), JSON.stringify(outcome, null, 2), 'utf8');
    return outcome;
  }
}
