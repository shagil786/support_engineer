// Node toolchain parity check — the CI-visible gate for the engines floor.
//
// One floor ("engines.node" in package.json, enforced by .npmrc
// engine-strict at install time) must hold on every machine that runs this
// code. This script re-checks it explicitly at run time and prints the
// toolchain context (.nvmrc line, Dockerfile runtime image) so drift
// between the pins is visible in the log even where it isn't fatal.
//
// The floor parser is deliberately narrow: it understands the only form this
// repo uses (">=X.Y"). A semver range that the parser can't handle fails
// closed with an instruction, rather than guessing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

const pkg = JSON.parse(read('package.json')) as { engines?: { node?: string } };
const floor = pkg.engines?.node;

if (!floor) {
  console.error('check-node: package.json has no engines.node floor — refusing to pass silently');
  process.exit(1);
}

const parsed = floor.match(/^>=(\d+)(?:\.(\d+))?$/);
if (!parsed) {
  console.error(
    `check-node: unsupported engines.node range "${floor}" — update scripts/check-node.ts (fail-closed, not guessed)`,
  );
  process.exit(1);
}
const floorMajor = Number(parsed[1]);
const floorMinor = Number(parsed[2] ?? '0');

const running = process.version;
const [majorStr, minorStr] = running.replace(/^v/, '').split('.');
const major = Number(majorStr);
const minor = Number(minorStr);

const nvmrc = readFileSync(join(root, '.nvmrc'), 'utf8').trim();
const dockerfile = read('Dockerfile');
const runtimeImage = dockerfile.match(/^FROM (node:\S+)/gm)?.at(-1) ?? '(unparsed)';

console.log(
  `node toolchain: floor ${floor} | running ${running} | .nvmrc ${nvmrc} | docker runtime ${runtimeImage}`,
);

const satisfied = major > floorMajor || (major === floorMajor && minor >= floorMinor);
if (!satisfied) {
  console.error(
    `check-node: FAILED — running ${running} is below the engines floor ${floor}. ` +
      'Use the .nvmrc line or newer.',
  );
  process.exit(1);
}
