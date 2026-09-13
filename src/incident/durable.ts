/**
 * Durable incident persistence — records and case memory that survive
 * restarts.
 *
 * `IncidentBrain` is a pure state machine with serialize/deserialize, and
 * `IncidentMemory` held its case library in a plain array: hosts had to
 * invent their own persistence. These file-backed stores close that gap
 * using the platform's established durability conventions (mirroring
 * FileBackedVectorMemory): JSON snapshots with atomic tmp+rename writes, an
 * on-disk format that stays human-inspectable, and a failure policy that
 * matches the degradation ethos — a missing file is an empty store; a corrupt
 * snapshot fails open (start empty, repair on the next mutation) rather than
 * crashing the process. A failed write still leaves the in-memory set
 * correct (logged, non-fatal): the process keeps serving.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { IncidentRecord } from './brain.js';
import { deserialize as deserializeRecord } from './brain.js';
import { IncidentMemory, type IncidentSignature, type SimilarIncident } from './memory.js';

function isIncidentRecord(x: unknown): x is IncidentRecord {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o['id'] === 'string' &&
    typeof o['phase'] === 'string' &&
    typeof o['updatedAt'] === 'number' &&
    Array.isArray(o['timeline']) &&
    o['timeline'].every((t) => typeof t === 'string')
  );
}

export interface FileBackedIncidentStoreOptions {
  /** Snapshot file path. Parent directories are created on first write. */
  path: string;
}

export class FileBackedIncidentStore {
  private readonly path: string;
  private records: IncidentRecord[];

  constructor(opts: FileBackedIncidentStoreOptions) {
    this.path = opts.path;
    this.records = this.load();
  }

  /** Upsert one incident record and flush the snapshot. */
  save(record: IncidentRecord): void {
    const idx = this.records.findIndex((r) => r.id === record.id);
    if (idx >= 0) this.records[idx] = record;
    else this.records.push(record);
    this.persist();
  }

  get(id: string): IncidentRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  all(): IncidentRecord[] {
    return [...this.records];
  }

  size(): number {
    return this.records.length;
  }

  /** Records in a given phase — the active-incident surface for consoles. */
  byPhase(phase: IncidentRecord['phase']): IncidentRecord[] {
    return this.records.filter((r) => r.phase === phase);
  }

  private load(): IncidentRecord[] {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return []; // missing file = empty store (first run)
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const records: IncidentRecord[] = [];
      for (const r of parsed) {
        // Round-trip through the brain's own validator so the on-disk shape
        // and the runtime shape can never drift apart.
        if (isIncidentRecord(r)) records.push(deserializeRecord(JSON.stringify(r)));
      }
      return records;
    } catch {
      // Corrupt snapshot: fail open (empty store); repaired on next mutation.
      console.error(`FileBackedIncidentStore: corrupt snapshot ${this.path} — starting empty`);
      return [];
    }
  }

  private persist(): void {
    const tmp = `${this.path}.tmp-${process.pid}`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(tmp, JSON.stringify(this.records, null, 2), 'utf8');
      renameSync(tmp, this.path); // atomic on POSIX
    } catch (e) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      // The in-memory set is still correct; a failed flush must not crash
      // request handling. Logged so ops can see the durability gap.
      console.error(`FileBackedIncidentStore: persist failed for ${this.path}:`, e);
    }
  }
}
export interface FileBackedIncidentMemoryOptions {
  /** Case-library snapshot path. Parent directories are created on first write. */
  path: string;
}

/**
 * IncidentMemory with a durable case library: past incidents — symptoms,
 * attempted hypotheses, failed actions, root cause, remediation, MTTR —
 * persist across restarts so recall keeps improving without re-learning.
 * The similarity engine stays the composed IncidentMemory's; this wrapper
 * only owns persistence, and every store() updates both sets so the
 * in-memory view and the snapshot are equal by construction.
 */
export class FileBackedIncidentMemory {
  private readonly path: string;
  private readonly mem = new IncidentMemory();
  /** Mirror of the case set for flushing (kept in step with `mem`). */
  private readonly mirror: IncidentSignature[] = [];

  constructor(opts: FileBackedIncidentMemoryOptions) {
    this.path = opts.path;
    this.load();
  }

  store(sig: IncidentSignature): void {
    this.mem.store(sig);
    const idx = this.mirror.findIndex((c) => c.id === sig.id);
    if (idx >= 0) this.mirror[idx] = sig;
    else this.mirror.push(sig);
    this.persist();
  }

  size(): number {
    return this.mem.size();
  }

  findSimilar(query: IncidentSignature, topK = 3): SimilarIncident[] {
    return this.mem.findSimilar(query, topK);
  }

  recallLine(query: IncidentSignature): string | undefined {
    return this.mem.recallLine(query);
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return; // missing file = empty case library (first run)
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const sig of parsed) {
        if (isIncidentSignature(sig)) {
          this.mem.store(sig);
          this.mirror.push(sig);
        }
      }
    } catch {
      console.error(`FileBackedIncidentMemory: corrupt snapshot ${this.path} — starting empty`);
    }
  }

  private persist(): void {
    const tmp = `${this.path}.tmp-${process.pid}`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(tmp, JSON.stringify(this.mirror, null, 2), 'utf8');
      renameSync(tmp, this.path);
    } catch (e) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      console.error(`FileBackedIncidentMemory: persist failed for ${this.path}:`, e);
    }
  }
}

function isIncidentSignature(x: unknown): x is IncidentSignature {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o['id'] === 'string' &&
    typeof o['service'] === 'string' &&
    typeof o['severity'] === 'string' &&
    Array.isArray(o['symptoms']) &&
    o['symptoms'].every((s) => typeof s === 'string') &&
    Array.isArray(o['hypothesesAttempted']) &&
    Array.isArray(o['failedActions'])
  );
}

