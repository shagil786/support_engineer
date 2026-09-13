// Toolchain pin — the drift guard for the Node floor.
//
// One floor ("engines.node" in package.json) is enforced three ways: npm
// engine-strict (.npmrc) at install, the check:node script in CI, and this
// test. The floor, .nvmrc (the production LTS line), and the Dockerfile
// runtime image must stay in lockstep — production ships node:22-slim, CI
// gates on the 22/24 matrix, and the floor is vitest 5's Node requirement.
// If this test fails, move the named files together and update the comment
// above to the new story — do not weaken the assertions.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = join(import.meta.dirname, '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

describe('node toolchain pinning', () => {
  test('engines floor is the vitest-5 floor, not the stale >=18 claim', () => {
    const pkg = JSON.parse(read('package.json')) as { engines?: { node?: string } };
    expect(pkg.engines?.node).toBe('>=22.12');
  });

  test('.nvmrc pins the same LTS line the Dockerfile ships', () => {
    const nvmrc = read('.nvmrc').trim();
    expect(nvmrc).toMatch(/^\d+$/);
    const dockerfile = read('Dockerfile');
    const runtimeImages = [...dockerfile.matchAll(/^FROM (node:\S+)/gm)]
      .map((m) => m[1])
      .filter((image): image is string => image !== undefined);
    expect(runtimeImages.length).toBeGreaterThan(0);
    for (const image of runtimeImages) {
      // node:22-slim, node:22.x-slim, … — same major line as .nvmrc.
      const major = image.match(/^node:(\d+)/)?.[1];
      expect(major).toBe(nvmrc);
    }
  });

  test('.npmrc turns engine-strict on so the floor gates local installs', () => {
    const npmrc = read('.npmrc');
    expect(npmrc).toMatch(/^engine-strict=true$/m);
  });

  test('check:node is wired into every workflow that sets up Node', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['check:node']).toBeTruthy();
    for (const wf of ['ci.yml', 'chaos.yml']) {
      expect(read(join('.github/workflows', wf))).toMatch(/npm run check:node/);
    }
    // security.yml is intentionally absent above: it runs gitleaks via a
    // container and sets up no Node, so there is no toolchain to verify. If
    // it ever grows Node steps, add it to the list.
  });
});
