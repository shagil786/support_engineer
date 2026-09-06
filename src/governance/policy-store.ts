/**
 * Versioned policy bundle store, SQLite-backed. PromotionGate (Phase 5) is
 * the only writer in production; tests use the same API.
 *
 * Bundle YAML lives on disk (content-addressed by sha256) and the DB holds
 * metadata + lineage, so bundles remain diffable artifacts. Promotion
 * requires signatures, an eval run id, and a safety-net pass — enforced by
 * schema, not convention.
 */
import Database from 'better-sqlite3';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';

export interface PolicyBundle {
  version: number;
  yaml: string;
  sha256: string;
  authoredBy: string;
  signedBy: string;
  parentVersion?: number;
  promotedAt?: number;
  promotedBy?: string[];
  evalRunId?: string;
  safetyNetPassed?: boolean;
}

export interface SaveInput {
  yaml: string;
  authoredBy: string;
  signedBy: string;
  parentVersion?: number;
}

export interface PromoteInput {
  promotedBy: string[];
  evalRunId: string;
  safetyNetPassed: boolean;
}

const SaveSchema = z.object({
  yaml: z.string().min(1),
  authoredBy: z.string().min(1),
  signedBy: z.string().min(1),
  parentVersion: z.number().int().positive().optional(),
});

const PromoteSchema = z.object({
  promotedBy: z.array(z.string().min(1)).min(1),
  evalRunId: z.string().min(1),
  safetyNetPassed: z.literal(true),
});

export interface PolicyStoreOptions {
  dbPath: string;
  /** Directory where bundle YAML files are written (content-addressed). */
  yamlDir: string;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface PolicyRow {
  version: number;
  sha256: string;
  yaml_path: string;
  authored_by: string;
  signed_by: string;
  parent_version: number | null;
  created_at: number;
  promoted_at: number | null;
  promoted_by: string | null;
  eval_run_id: string | null;
  safety_net_passed: number | null;
}

export class PolicyStore {
  private readonly db: Database.Database;
  private readonly yamlDir: string;
  private readonly now: () => number;

  constructor(opts: PolicyStoreOptions) {
    mkdirSync(dirname(opts.dbPath), { recursive: true });
    this.db = new Database(opts.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.yamlDir = opts.yamlDir;
    this.now = opts.now ?? Date.now;
    mkdirSync(this.yamlDir, { recursive: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS policy_versions (
        version INTEGER PRIMARY KEY AUTOINCREMENT,
        sha256 TEXT NOT NULL,
        yaml_path TEXT NOT NULL,
        authored_by TEXT NOT NULL,
        signed_by TEXT NOT NULL,
        parent_version INTEGER,
        created_at INTEGER NOT NULL,
        promoted_at INTEGER,
        promoted_by TEXT,
        eval_run_id TEXT,
        safety_net_passed INTEGER
      );
      CREATE TABLE IF NOT EXISTS policy_current (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL UNIQUE REFERENCES policy_versions(version)
      );
    `);
  }

  async save(input: SaveInput): Promise<PolicyBundle> {
    const parsed = SaveSchema.parse(input);
    const sha = createHash('sha256').update(parsed.yaml).digest('hex');
    const path = join(this.yamlDir, `${sha}.yaml`);
    writeFileSync(path, parsed.yaml, 'utf8');
    const info = this.db
      .prepare(
        `INSERT INTO policy_versions (sha256, yaml_path, authored_by, signed_by, parent_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(sha, path, parsed.authoredBy, parsed.signedBy, parsed.parentVersion ?? null, this.now());
    const version = Number(info.lastInsertRowid);
    return {
      version,
      yaml: parsed.yaml,
      sha256: sha,
      authoredBy: parsed.authoredBy,
      signedBy: parsed.signedBy,
      parentVersion: parsed.parentVersion,
    };
  }

  get(version: number): PolicyBundle | undefined {
    const row = this.db.prepare(`SELECT * FROM policy_versions WHERE version = ?`).get(version) as
      | PolicyRow
      | undefined;
    return row ? this.rowToBundle(row) : undefined;
  }

  versions(): PolicyBundle[] {
    const rows = this.db.prepare(`SELECT * FROM policy_versions ORDER BY version ASC`).all() as PolicyRow[];
    return rows.map((r) => this.rowToBundle(r));
  }

  current(): PolicyBundle {
    const row = this.db
      .prepare(
        `SELECT pv.* FROM policy_current pc JOIN policy_versions pv ON pv.version = pc.version WHERE pc.id = 1`,
      )
      .get() as PolicyRow | undefined;
    if (!row) throw new Error('PolicyStore: no current policy — nothing has been promoted yet');
    return this.rowToBundle(row);
  }

  /** Atomically record a promotion and flip the current pointer. */
  async promote(version: number, input: PromoteInput): Promise<void> {
    const parsed = PromoteSchema.parse(input);
    const tx = this.db.transaction(() => {
      const known = this.db.prepare(`SELECT version FROM policy_versions WHERE version = ?`).get(version);
      if (!known) throw new Error(`PolicyStore: cannot promote unknown version ${version}`);
      const res = this.db
        .prepare(
          `UPDATE policy_versions
           SET promoted_at = ?, promoted_by = ?, eval_run_id = ?, safety_net_passed = 1
           WHERE version = ?`,
        )
        .run(this.now(), JSON.stringify(parsed.promotedBy), parsed.evalRunId, version);
      if (res.changes !== 1) throw new Error(`PolicyStore: cannot promote unknown version ${version}`);
      this.db.prepare(`INSERT OR REPLACE INTO policy_current (id, version) VALUES (1, ?)`).run(version);
    });
    tx();
  }

  close(): void {
    this.db.close();
  }

  private rowToBundle(row: PolicyRow): PolicyBundle {
    const yaml = readFileSync(row.yaml_path, 'utf8');
    return {
      version: Number(row.version),
      yaml,
      sha256: row.sha256,
      authoredBy: row.authored_by,
      signedBy: row.signed_by,
      parentVersion: row.parent_version === null ? undefined : Number(row.parent_version),
      promotedAt: row.promoted_at === null ? undefined : Number(row.promoted_at),
      promotedBy: row.promoted_by === null ? undefined : (JSON.parse(row.promoted_by) as string[]),
      evalRunId: row.eval_run_id === null ? undefined : row.eval_run_id,
      safetyNetPassed: row.safety_net_passed === null ? undefined : Number(row.safety_net_passed) === 1,
    };
  }
}
