import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IdempotencyStore } from '../../src/operations/idempotency-store.js';

const fingerprint = 'a'.repeat(64);
const request = (key: string) => ({
  key, fingerprint, capability: 'files.write', targetId: 'naveax-device',
});
const sqlFile = (root: string) => path.join(root, 'idempotency-records.sqlite');

async function disposable(t: Parameters<typeof test>[1] extends never ? never : any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nwx-ai06-windows-sqlite-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function runChild(script: string, root: string) {
  return spawnSync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval', script, root,
  ], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 20_000, windowsHide: true,
  });
}

function legacy(count: number) {
  const now = '2026-10-02T07:10:53.502Z';
  return {
    version: 1,
    records: Array.from({ length: count }, (_, i) => ({
      key: 'historical-' + i, fingerprint,
      operationId: randomUUID(), targetId: 'naveax-device',
      capability: 'files.write',
      status: i === count - 1 ? 'failed' : 'succeeded',
      createdAt: now, updatedAt: now,
    })),
  };
}

async function saveLegacy(root: string, journal: ReturnType<typeof legacy>) {
  const file = path.join(root, 'idempotency-records.json');
  await fs.writeFile(file, JSON.stringify(journal) + '\n');
  const hash = createHash('sha256').update(await fs.readFile(file)).digest('hex');
  return { file, hash };
}

test('two Windows Hub processes cannot own the same ledger; independent stateDirs work', async (t) => {
  const root = await disposable(t);
  const independent = await disposable(t);
  const owner = new IdempotencyStore(root);
  await owner.initialize();
  const script = `
    import { IdempotencyStore } from './src/operations/idempotency-store.js';
    const store = new IdempotencyStore(process.argv[1]);
    try {
      await store.initialize();
      console.log('CLAIMED');
    } catch (e) {
      console.log(e?.code || 'UNEXPECTED_ERROR');
    }
  `;
  const denied = runChild(script, root);
  assert.equal(denied.status, 0, denied.stderr);
  assert.equal(denied.stdout.trim(), 'IDEMPOTENCY_HUB_WRITER_ACTIVE');
  const allowed = runChild(script, independent);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), 'CLAIMED');
  assert.equal((await owner.begin(request('owner-key'))).created, true);
  assert.equal(await new IdempotencyStore(independent).get('owner-key'), undefined);
});

test('synthetic PID reuse and stolen hub_writer identity reject further mutations', async (t) => {
  const root = await disposable(t);
  const owner = new IdempotencyStore(root);
  await owner.begin(request('before-owner-handoff'));
  const db = new DatabaseSync(sqlFile(root));
  try {
    const select = db.prepare("SELECT value FROM idempotency_meta WHERE key='hub_writer'");
    const original = (select.get() as { value: string }).value;
    const cloned = JSON.parse(original) as Record<string, unknown>;
    assert.equal(cloned.pid, process.pid);
    assert.equal(typeof cloned.incarnation, 'string');
    // A *live*, unrelated process occupying a reused PID must not be treated as
    // the old owner: incarnation mismatch cannot justify reclaiming the ledger.
    const replaced = JSON.stringify({ ...cloned, incarnation: 'recycled-pid-incarnation' });
    db.prepare("UPDATE idempotency_meta SET value=? WHERE key='hub_writer'").run(replaced);
    await assert.rejects(() => new IdempotencyStore(root).initialize(),
      { code: 'IDEMPOTENCY_HUB_WRITER_ACTIVE' });
    await assert.rejects(() => owner.begin(request('after-owner-handoff')),
      { code: 'IDEMPOTENCY_HUB_WRITER_LOST' });
    await assert.rejects(() => owner.complete('before-owner-handoff', 'succeeded'),
      { code: 'IDEMPOTENCY_HUB_WRITER_LOST' });
    assert.equal(await owner.get('after-owner-handoff'), undefined);
    assert.equal((await owner.get('before-owner-handoff'))?.status, 'in_progress');
    db.prepare("UPDATE idempotency_meta SET value=? WHERE key='hub_writer'").run(original);
    await owner.complete('before-owner-handoff', 'succeeded');
  } finally { db.close(); }
});

test('interrupted SQLite migration transaction is rolled back; full legacy ledger survives', async (t) => {
  const root = await disposable(t);
  const historical = legacy(80);
  const { file, hash } = await saveLegacy(root, historical);
  const crash = runChild(`
    import { DatabaseSync } from 'node:sqlite';
    import path from 'node:path';
    const db = new DatabaseSync(path.join(process.argv[1], 'idempotency-records.sqlite'));
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('BEGIN IMMEDIATE');
    db.exec('CREATE TABLE crash_partial(value TEXT NOT NULL)');
    db.prepare('INSERT INTO crash_partial(value) VALUES(?)').run('not committed');
    // Simulate process termination after a partial SQL transaction, before COMMIT.
    process.exit(77);
  `, root);
  assert.equal(crash.status, 77, crash.stderr);
  const store = new IdempotencyStore(root);
  await store.initialize();
  const db = new DatabaseSync(sqlFile(root), { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='crash_partial'").get(),
      undefined, 'abandoned uncommitted DDL must not survive');
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM idempotency_records')
      .get() as { n: number }).n, 80);
    assert.equal((db.prepare('PRAGMA quick_check').get() as {quick_check: string})
      .quick_check, 'ok');
  } finally { db.close(); }
  for (const row of historical.records) {
    assert.deepEqual(await store.get(row.key), row);
  }
  assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'), hash);
});

test('mid-migration UNIQUE failure leaves zero partial tombstones and intact JSON', async (t) => {
  const root = await disposable(t);
  const journal = legacy(80);
  journal.records[52]!.operationId = journal.records[1]!.operationId;
  const {file, hash} = await saveLegacy(root, journal);
  await assert.rejects(() => new IdempotencyStore(root).initialize());
  const db = new DatabaseSync(sqlFile(root), { readOnly: true });
  try {
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM idempotency_records')
      .get() as {n:number}).n, 0);
    assert.equal(db.prepare(
      "SELECT value FROM idempotency_meta WHERE key='schema_version'",
    ).get(), undefined, 'failed import must not commit a schema/version marker');
    assert.equal(db.prepare(
      "SELECT value FROM idempotency_meta WHERE key='hub_writer'",
    ).get(), undefined, 'failed import must not retain a writer claim');
  } finally { db.close(); }
  assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'), hash);
});

test('synthetic SQLite disk-full INSERT failure never allocates a replay reservation', async (t) => {
  const root = await disposable(t);
  const store = new IdempotencyStore(root);
  await store.initialize();
  const db = new DatabaseSync(sqlFile(root));
  try {
    // Deterministic disk-full fault injection: do NOT fill the physical test disk.
    db.exec(`
      CREATE TRIGGER simulate_disk_full BEFORE INSERT ON idempotency_records
      BEGIN SELECT RAISE(ABORT, 'SIMULATED_SQLITE_FULL'); END
    `);
    await assert.rejects(() => store.begin(request('disk-full-at-reserve')),
      /SIMULATED_SQLITE_FULL/);
    assert.equal(await store.get('disk-full-at-reserve'), undefined);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM idempotency_records')
      .get() as {n:number}).n, 0);
    db.exec('DROP TRIGGER simulate_disk_full');
    const attempt = await store.begin(request('disk-full-at-reserve'));
    assert.equal(attempt.created, true, 'a non-committed reservation may be retried');
    assert.equal((await store.get('disk-full-at-reserve'))?.operationId,
      attempt.record.operationId);
  } finally { db.close(); }
});

test('JSON-only rollback would miss newly committed SQLite keys and must be rejected at deployment', async (t) => {
  const root = await disposable(t);
  const original = legacy(80);
  const {file, hash} = await saveLegacy(root, original);
  const store = new IdempotencyStore(root);
  await store.initialize();
  const created = await store.begin(request('post-cutover-key'));
  assert.equal(created.created, true);
  await store.complete('post-cutover-key', 'succeeded');
  const historical = JSON.parse(await fs.readFile(file, 'utf8')) as ReturnType<typeof legacy>;
  assert.equal(historical.records.length, 80);
  assert.equal(historical.records.some((row) => row.key === 'post-cutover-key'), false,
    'old JSON reader has no knowledge of the newer effect and cannot be a safe fallback');
  assert.equal(createHash('sha256').update(await fs.readFile(file)).digest('hex'), hash);
  assert.equal((await new IdempotencyStore(root).get('post-cutover-key'))?.status, 'succeeded');
  // This test is a downgrade *negative proof*, not an installer gate.
  // AI-07 must reject JSON-only rollback before changing a live launcher.
});
