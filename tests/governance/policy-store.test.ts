import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PolicyStore } from '../../src/governance/policy-store';

let dir: string;
let store: PolicyStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'policystore-'));
  store = new PolicyStore({ dbPath: join(dir, 'policies.db'), yamlDir: join(dir, 'bundles') });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('PolicyStore', () => {
  it('saves, lists, and loads a version with a stable sha256', async () => {
    const yaml = 'rules:\n  - id: r1\n    effect: allow\n';
    const v = await store.save({ yaml, authoredBy: 'alice', signedBy: 'alice' });
    expect(v.version).toBeGreaterThan(0);
    expect(v.sha256).toBe(createHash('sha256').update(yaml).digest('hex'));

    const got = store.get(v.version);
    expect(got?.yaml).toBe(yaml);
    expect(got?.authoredBy).toBe('alice');
    expect(store.versions()).toHaveLength(1);
  });

  it('rejects saves with missing author or empty yaml', async () => {
    await expect(store.save({ yaml: '', authoredBy: 'alice', signedBy: 'alice' })).rejects.toThrow();
    await expect(store.save({ yaml: 'rules: []', authoredBy: '', signedBy: 'alice' })).rejects.toThrow();
  });

  it('promotes a version to current', async () => {
    const v1 = await store.save({ yaml: 'rules: []\n', authoredBy: 'alice', signedBy: 'alice' });
    const v2 = await store.save({
      yaml: 'rules:\n  - id: r2\n    effect: allow\n',
      authoredBy: 'bob',
      signedBy: 'bob',
      parentVersion: v1.version,
    });
    await store.promote(v2.version, {
      promotedBy: ['admin1', 'admin2'],
      evalRunId: 'eval-1',
      safetyNetPassed: true,
    });
    expect(store.current().version).toBe(v2.version);
    expect(store.current().promotedBy).toEqual(['admin1', 'admin2']);
    expect(store.current().safetyNetPassed).toBe(true);
    expect(store.current().evalRunId).toBe('eval-1');
  });

  it('rejects promotion without signatures, eval run, or safety-net pass', async () => {
    const v = await store.save({ yaml: 'rules: []\n', authoredBy: 'alice', signedBy: 'alice' });
    await expect(
      store.promote(v.version, { promotedBy: [], evalRunId: 'e', safetyNetPassed: true }),
    ).rejects.toThrow();
    await expect(
      store.promote(v.version, { promotedBy: ['a'], evalRunId: '', safetyNetPassed: true }),
    ).rejects.toThrow();
    await expect(
      store.promote(v.version, { promotedBy: ['a'], evalRunId: 'e', safetyNetPassed: false }),
    ).rejects.toThrow();
  });

  it('rejects promotion of an unknown version', async () => {
    await expect(
      store.promote(9999, { promotedBy: ['admin1'], evalRunId: 'e', safetyNetPassed: true }),
    ).rejects.toThrow(/unknown version/);
  });

  it('throws when no current policy has been promoted', () => {
    expect(() => store.current()).toThrow(/no current policy/);
  });

  it('tracks parent lineage across versions', async () => {
    const v1 = await store.save({ yaml: 'rules: []\n', authoredBy: 'a', signedBy: 'a' });
    const v2 = await store.save({ yaml: 'rules: []\n', authoredBy: 'a', signedBy: 'a', parentVersion: v1.version });
    expect(v2.parentVersion).toBe(v1.version);
    expect(store.get(v1.version)?.parentVersion).toBeUndefined();
  });
});
