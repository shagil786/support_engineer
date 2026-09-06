/**
 * FileBackedVectorMemory — durable implementation of the VectorMemory port.
 *
 * Persists the record set as a JSON snapshot (atomic tmp+rename writes) so
 * cross-scope episodic memory — learned procedures, reusable knowledge —
 * survives process restarts. Persisted vectors keep startup cheap (a cloud
 * embedder would otherwise re-embed every record on boot); the consequence
 * is that the embedder must be STABLE across restarts — swapping embedders
 * requires deleting the snapshot (reindex) or a future migration pass.
 * The on-disk format stays human-inspectable.
 *
 * Failure policy matches the repo's degradation ethos: a missing file is an
 * empty store; a corrupt snapshot fails open (start empty, repair on the
 * next mutation) rather than crashing the process — memory loss is never
 * worse than memory corruption. A failed write still leaves the in-memory
 * set correct (logged, non-fatal): the process keeps serving.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MemoryRecord, SearchHit, Embedder } from './vector.js';
import { cosine, hashEmbedder } from './vector.js';

interface PersistedEntry {
  record: MemoryRecord;
  vector: number[];
}

function isPersistedEntry(x: unknown): x is PersistedEntry {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  const rec = o['record'];
  return (
    typeof rec === 'object' && rec !== null &&
    typeof (rec as MemoryRecord).id === 'string' &&
    typeof (rec as MemoryRecord).text === 'string' &&
    Array.isArray(o['vector']) &&
    (o['vector'] as unknown[]).every((v) => typeof v === 'number' && Number.isFinite(v))
  );
}

export interface FileBackedVectorMemoryOptions {
  /** Snapshot file path. Parent directories are created on first write. */
  path: string;
  /** Must be stable across restarts; defaults to the shared hashEmbedder. */
  embedder?: Embedder;
}

export class FileBackedVectorMemory {
  private readonly path: string;
  private readonly embed: Embedder;
  private entries: Array<{ record: MemoryRecord; vector: number[] }>;

  constructor(opts: FileBackedVectorMemoryOptions) {
    this.path = opts.path;
    this.embed = opts.embedder ?? hashEmbedder;
    this.entries = this.load();
  }

  private load(): Array<{ record: MemoryRecord; vector: number[] }> {
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch {
      return []; // missing file = empty store (first run)
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const entries: Array<{ record: MemoryRecord; vector: number[] }> = [];
      for (const e of parsed) {
        if (isPersistedEntry(e)) entries.push({ record: e.record, vector: e.vector });
      }
      return entries;
    } catch {
      // Corrupt snapshot: fail open (empty store); repaired on next mutation.
      return [];
    }
  }

  private persist(): void {
    const tmp = `${this.path}.tmp-${process.pid}`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(tmp, JSON.stringify(this.entries), 'utf8');
      renameSync(tmp, this.path); // atomic on POSIX
    } catch (e) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      // The in-memory set is still correct; a failed flush must not crash
      // request handling. Logged so ops can see the durability gap.
      console.error(`FileBackedVectorMemory: persist failed for ${this.path}:`, e);
    }
  }

  async add(record: MemoryRecord): Promise<void> {
    const existing = this.entries.findIndex((e) => e.record.id === record.id);
    const entry = { record, vector: this.embed(record.text) };
    if (existing >= 0) this.entries[existing] = entry;
    else this.entries.push(entry);
    this.persist();
  }

  async search(query: string, topK = 3, minScore = 0.05): Promise<SearchHit[]> {
    if (this.entries.length === 0) return [];
    const q = this.embed(query);
    return this.entries
      .map((e) => ({ ...e.record, score: cosine(q, e.vector) }))
      .filter((hit) => hit.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  size(): number {
    return this.entries.length;
  }

  async purge(predicate: (record: MemoryRecord) => boolean): Promise<number> {
    let removed = 0;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry && predicate(entry.record)) {
        this.entries.splice(i, 1);
        removed++;
      }
    }
    if (removed > 0) this.persist();
    return removed;
  }
}
