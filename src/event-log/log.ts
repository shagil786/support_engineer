/**
 * EventLog interface and a JSONL file-backed implementation (v1).
 *
 * Files are append-only, segmented daily: `<baseDir>/YYYY-MM-DD.jsonl`.
 * Pluggable to Postgres / Kafka later by satisfying the same interface.
 */
import { mkdir, appendFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { DecisionEvent } from './types.js';
import { isDecisionEvent } from './types.js';

export interface EventFilter {
  kind?: DecisionEvent['kind'];
  layer?: DecisionEvent['layer'];
  source?: DecisionEvent['source'];
  /** Inclusive lower epoch-ms bound. */
  from?: number;
  /** Exclusive upper epoch-ms bound. */
  to?: number;
  /** Match a specific correlationId. */
  correlationId?: string;
}

export interface EventLog {
  append(event: DecisionEvent): Promise<void>;
  query(filter: EventFilter): AsyncIterable<DecisionEvent>;
}

export interface JsonlFileEventLogOptions {
  baseDir: string;
  /** Injectable clock for tests. */
  now?: () => number;
}

function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse `YYYY-MM-DD.jsonl` into the epoch-ms start of that UTC day. */
function dayStartOf(file: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(file);
  if (!m) return 0;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export class JsonlFileEventLog implements EventLog {
  private readonly baseDir: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(opts: JsonlFileEventLogOptions) {
    this.baseDir = opts.baseDir;
  }

  async append(event: DecisionEvent): Promise<void> {
    if (!isDecisionEvent(event)) {
      throw new Error('append: not a DecisionEvent');
    }
    const line = JSON.stringify(event) + '\n';
    const path = join(this.baseDir, `${dayKey(event.ts)}.jsonl`);
    // Serialize concurrent appends within this process to keep lines atomic.
    const chained = this.writeChain.then(async () => {
      await mkdir(this.baseDir, { recursive: true });
      await appendFile(path, line, 'utf8');
    });
    this.writeChain = chained;
    await chained;
  }

  async *query(filter: EventFilter): AsyncIterable<DecisionEvent> {
    let files: string[];
    try {
      files = (await readdir(this.baseDir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
    } catch {
      return; // directory does not exist yet — nothing has been logged
    }
    for (const f of files) {
      const dayStart = dayStartOf(f);
      const dayEnd = dayStart + 86_400_000;
      if (filter.from !== undefined && dayEnd <= filter.from) continue;
      if (filter.to !== undefined && dayStart >= filter.to) continue;

      const stream = createReadStream(join(this.baseDir, f), { encoding: 'utf8' });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (!isDecisionEvent(parsed)) continue;
        if (filter.kind !== undefined && parsed.kind !== filter.kind) continue;
        if (filter.layer !== undefined && parsed.layer !== filter.layer) continue;
        if (filter.source !== undefined && parsed.source !== filter.source) continue;
        if (filter.correlationId !== undefined && parsed.correlationId !== filter.correlationId) continue;
        if (filter.from !== undefined && parsed.ts < filter.from) continue;
        if (filter.to !== undefined && parsed.ts >= filter.to) continue;
        yield parsed;
      }
    }
  }
}
