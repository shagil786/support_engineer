/** Layer 1 — key/value memory port + in-memory implementation.
 *  Ported verbatim from src/support-voice-agent/memory/store.ts.
 *  Swap the implementation for Redis later by satisfying this port.
 */
export interface KeyValueStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export class InMemoryKeyValueStore implements KeyValueStore {
  private readonly map = new Map<string, { value: string; expiresAt?: number }>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  async get(key: string): Promise<string | undefined> {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt !== undefined && hit.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  async set(key: string, value: string, ttlMs?: number): Promise<void> {
    this.map.set(key, { value, expiresAt: ttlMs !== undefined ? this.now() + ttlMs : undefined });
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
}
