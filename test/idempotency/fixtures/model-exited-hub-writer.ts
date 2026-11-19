/** Test-only expired Hub owner marker: models a previous process that has exited.
 * A second store in the current process is NOT a restart and must retain active work.
 * The real cross-process restart fixture is also covered by idempotency-store.test.ts.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

export function modelExitedHubWriter(root: string): void {
  const exited = spawnSync(process.execPath, ['-e', ''], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(exited.status, 0, exited.stderr);
  assert.ok(exited.pid && exited.pid !== process.pid, 'expired writer PID must differ');
  // Verify the test's old PID is truly dead before relying on the recovery path.
  assert.throws(() => process.kill(exited.pid!, 0), { code: 'ESRCH' });

  const db = new DatabaseSync(path.join(root, 'idempotency-records.sqlite'));
  try {
    const row = db.prepare(
      "SELECT value FROM idempotency_meta WHERE key='hub_writer'",
    ).get() as {value: string} | undefined;
    assert.ok(row, 'missing hub_writer fixture metadata');
    const previous = JSON.parse(row.value) as {
      host: string; pid: number; incarnation: string;
    };
    assert.equal(previous.pid, process.pid, 'unexpected live writer identity');
    db.prepare(
      "UPDATE idempotency_meta SET value=? WHERE key='hub_writer'",
    ).run(JSON.stringify({
      ...previous, pid: exited.pid, incarnation: randomUUID(),
    }));
  } finally {
    db.close();
  }
}
