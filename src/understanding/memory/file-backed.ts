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
import type { MemoryRecord, SearchHit, EmbedderLike } from './vector.js';
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
  /** Must be stable across restarts; defaults to the shared hashEmbedder.
   *  Changing it requires a one-time `reindex()` (re-embeds under the new
   *  backend and persists). */
  embedder?: EmbedderLike;
}

export class FileBackedVectorMemory {
  private readonly path: string;
  private readonly embed: EmbedderLike;
  private entries: Array<{ record: MemoryRecord; vector: number[] }>;

  constructor(opts: FileBackedVectorMemoryOptions) {
    this.path = opts.path;
    this.embed = opts.embedder ?? hashEmbedder;
    this.entries = this.load();
    this.bootCheckPromise = this.runBootCheck();
  }

  /** Boot-time compatibility self-check (spec: fail loud at boot, not at
   *  first request). Construction cannot await async embedders, so the
   *  check runs fire-and-forget and logs on failure; `whenBootChecked()`
   *  exposes it as an awaitable for hosts that want the warning to land
   *  deterministically before serving traffic. Empty stores return before
   *  probing — first boot never triggers an accidental model load. */
  private bootCheckPromise?: Promise<void>;

  /** Resolves once the boot compatibility check has settled (empty stores
   *  resolve immediately — nothing to mismatch against). */
  whenBootChecked(): Promise<void> {
    return this.bootCheckPromise ?? Promise.resolve();
  }

  private async runBootCheck(): Promise<void> {
    if (this.dim() === undefined) return;
    try {
      await this.assertCompatible();
    } catch (e) {
      // Two loud failure classes, both surfaced at boot instead of hiding
      // behind the first request's honest-degradation path:
      //  - dimension mismatch (assertCompatible's actionable message)
      //  - probe embedder failure (model load / network — a broken embedder
      //    would fail every later add/search anyway)
      console.error('FileBackedVectorMemory: boot self-check failed:', e);
    }
  }

  /** Dimensionality of the persisted vectors (undefined when empty).
   *  A mismatch against the new embedder's output is the reindex signal. */
  dim(): number | undefined {
    const v = this.entries[0]?.vector;
    return v?.length;
  }

  /** Dimensionality of the configured embedder's output. Cheap probe:
   *  embeds a probe string once and caches the length (sync and async
   *  embedders both supported — EmbedderLike permits either). */
  private embedDimCache: number | undefined;
  private async embedderDim(): Promise<number> {
    if (this.embedDimCache === undefined) {
      const out = await this.embed('__dim_probe__');
      this.embedDimCache = out.length;
    }
    return this.embedDimCache;
  }

  /** Fail loud when the persisted vector space and the configured embedder
   *  disagree. Silent zero-padded cosine would return garbage rankings that
   *  look like answers — the worst failure mode retrieval can have.
   *  Dimension equality is necessary, not sufficient (two different 384-dim
   *  models are undetectable here and remain the operator's responsibility). */
  private async assertCompatible(): Promise<void> {
    const stored = this.dim();
    if (stored === undefined || this.entries.length === 0) return;
    const live = await this.embedderDim();
    if (stored !== live) {
      throw new Error(
        `DIMENSION MISMATCH: FileBackedVectorMemory (${this.path}): stored vectors are ${stored}-dim but the configured embedder produces ${live}-dim — ` +
          'the two vector spaces are incompatible. Run reindex() (or the knowledge-cli / learning-cron equivalent) before using this store.',
      );
    }
  }

  /** Re-embed every record under the current embedder and persist.
   *  The one-time migration when swapping embedding backends. */
  async reindex(): Promise<number> {
    for (const e of this.entries) {
      e.vector = await this.embed(e.record.text);
    }
    this.persist();
    return this.entries.length;
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
    await this.assertCompatible();
    const existing = this.entries.findIndex((e) => e.record.id === record.id);
    const entry = { record, vector: await this.embed(record.text) };
    if (existing >= 0) this.entries[existing] = entry;
    else this.entries.push(entry);
    this.persist();
  }

  async search(query: string, topK = 3, minScore = 0.05): Promise<SearchHit[]> {
    await this.assertCompatible();
    if (this.entries.length === 0) return [];
    const q = await this.embed(query);
    return this.entries
      .map((e) => ({ ...e.record, score: cosine(q, e.vector) }))
      .filter((hit) => hit.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  size(): number {
    return this.entries.length;
  }

  list(): MemoryRecord[] {
    return this.entries.map((e) => e.record);
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
