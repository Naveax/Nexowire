import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const script = path.join(process.cwd(), 'scripts', 'ai06-hub-sqlite-cutover-preflight.ps1');

function run(root: string, target: 'sqlite' | 'json-only', extra: string[] = []) {
  return spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-StateDir', root, '-TargetReader', target, ...extra,
  ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
}

test('Windows SQLite cutover preflight denies JSON downgrade and checks migration hash', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const source = await fs.readFile(script, 'utf8');
  assert.doesNotMatch(source,
    /\b(?:Register|Unregister|Start|Stop|Set|Disable|Enable)-ScheduledTask\b/i);
  assert.doesNotMatch(source,
    /\b(?:Remove-Item|Move-Item|Set-Content|New-Item|Start-Process|Stop-Process)\b/i);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nwx-ai06-rollback-only-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const legacy = path.join(root, 'idempotency-records.json');
  const contents = '{"version":1,"records":[]}\n';
  await fs.writeFile(legacy, contents);
  const sha = createHash('sha256').update(contents).digest('hex').toUpperCase();

  const blockedOld = run(root, 'json-only');
  assert.equal(blockedOld.status, 2, blockedOld.stderr);
  assert.match(blockedOld.stderr, /IDEMPOTENCY_SQLITE_DOWNGRADE_DENIED/);

  const withoutProof = run(root, 'sqlite', ['-AllowFirstMigration']);
  assert.equal(withoutProof.status, 2, withoutProof.stderr);
  assert.match(withoutProof.stderr, /IDEMPOTENCY_LEGACY_HASH_REQUIRED/);
  const wrongHash = run(root, 'sqlite', [
    '-AllowFirstMigration', '-ExpectedLegacySha256', '0'.repeat(64),
  ]);
  assert.equal(wrongHash.status, 2, wrongHash.stderr);
  assert.match(wrongHash.stderr, /IDEMPOTENCY_LEGACY_HASH_MISMATCH/);

  const authorizedStaging = run(root, 'sqlite', [
    '-AllowFirstMigration', '-ExpectedLegacySha256', sha,
  ]);
  assert.equal(authorizedStaging.status, 0, authorizedStaging.stderr);
  assert.equal(JSON.parse(authorizedStaging.stdout).firstMigration, true);
  assert.equal(await fs.readFile(legacy, 'utf8'), contents);

  const sqlitePath = path.join(root, 'idempotency-records.sqlite');
  const db = new DatabaseSync(sqlitePath);
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE fixture (id INTEGER PRIMARY KEY)');
  db.close();
  const before = createHash('sha256').update(await fs.readFile(sqlitePath))
    .digest('hex');

  const blockedDowngrade = run(root, 'json-only');
  assert.equal(blockedDowngrade.status, 2, blockedDowngrade.stderr);
  assert.match(blockedDowngrade.stderr, /IDEMPOTENCY_SQLITE_DOWNGRADE_DENIED/);

  const sqliteReader = run(root, 'sqlite');
  assert.equal(sqliteReader.status, 0, sqliteReader.stderr);
  assert.equal(JSON.parse(sqliteReader.stdout).sqliteExists, true);

  const wrongSid = run(root, 'sqlite', [
    '-ExpectedOwnerSid', 'S-1-5-21-0-0-0-9999',
  ]);
  assert.equal(wrongSid.status, 2, wrongSid.stderr);
  assert.match(wrongSid.stderr, /IDEMPOTENCY_OWNER_SID_MISMATCH/);
  assert.equal(createHash('sha256').update(await fs.readFile(sqlitePath))
    .digest('hex'), before, 'preflight must not mutate the SQLite file');
  assert.equal(await fs.readFile(legacy, 'utf8'), contents);
});
