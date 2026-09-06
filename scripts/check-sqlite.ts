// Verifies the native better-sqlite3 binary loads and executes against this
// exact Node ABI. Prebuilt binaries can lag brand-new Node releases; CI runs
// this right after `npm ci` and rebuilds from source when it fails.
import Database from 'better-sqlite3';

const db = new Database(':memory:');
try {
  db.exec('CREATE TABLE probe (x INTEGER)');
  db.prepare('INSERT INTO probe (x) VALUES (?)').run(41);
  const row = db.prepare('SELECT x + 1 AS v FROM probe').get() as { v: number } | undefined;
  if (row?.v !== 42) {
    console.error(`better-sqlite3 probe: unexpected result ${JSON.stringify(row)}`);
    process.exit(1);
  }
  const vRow = db.prepare('select sqlite_version() v').get() as { v: string } | undefined;
  console.log(`better-sqlite3 probe: OK (node ${process.version}, sqlite ${vRow?.v})`);
} catch (e) {
  console.error(`better-sqlite3 probe: FAILED — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
} finally {
  db.close();
}
