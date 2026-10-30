// Disposable SQLite writer/reader for #974. This never starts an installed
// Agent, changes a task, or touches a real user profile.
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync, statSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

// Only this QA worker honors a payload root; the production Agent has no such
// module override. Release CI uses the actual extracted bundle and its Node.
const payloadRoot = process.env.NEXOWIRE_JOURNAL_TEST_APP_ROOT;
const {AgentOperationJournal} = await import(payloadRoot
  ? pathToFileURL(path.join(payloadRoot, 'dist/src/agent/operation-journal.js')).href
  : new URL('../../src/agent/operation-journal.js', import.meta.url).href);

const [mode, file] = process.argv.slice(2);
assert.ok(file);
const fingerprint = 'a'.repeat(64);
const at = '2026-10-30T00:00:00.000Z';
const rows = (db: DatabaseSync) => db.prepare(
  'SELECT * FROM agent_operation_journal ORDER BY request_id',
).all();
const digest = (value: unknown) => createHash('sha256')
  .update(JSON.stringify(value)).digest('hex');
const report = (value: unknown) => {
  assert.ok(process.send, 'worker must use its disposable parent IPC channel');
  process.send(value);
};

if (mode === 'fixture') {
  const schema = new AgentOperationJournal(file);
  await schema.initialize();
  schema.close();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0;');
  // Two one-page tables let SQLite itself create the incident's physical
  // geometry. No frame, salt, checksum or WAL-index byte is fabricated.
  db.exec('CREATE TABLE reuse_a(value INTEGER); INSERT INTO reuse_a VALUES(0);' +
    'CREATE TABLE reuse_b(value INTEGER); INSERT INTO reuse_b VALUES(0);');
  const insert = db.prepare('INSERT INTO agent_operation_journal ' +
    '(request_id,fingerprint,capability,status,created_at,updated_at,' +
    'process_exit_code,task_success,timed_out,has_execution,dispatched_at)' +
    ' VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  db.exec('BEGIN IMMEDIATE');
  for (let i = 0; i < 1306; i++) {
    insert.run(randomUUID(), fingerprint, 'shell.exec',
      i === 1305 ? 'failed' : 'succeeded', at, at,
      i === 1305 ? 1 : 0, null, 0, 1, at);
  }
  db.exec('COMMIT');
  const frameBytes = 24 + 4096;
  const frameCount = () => (statSync(file + '-wal').size - 32) / frameBytes;
  assert.equal(db.prepare('PRAGMA page_size').get()!.page_size, 4096);
  assert.ok(frameCount() < 1004);
  while (frameCount() < 1004) db.exec('UPDATE reuse_a SET value=value+1');
  assert.equal(frameCount(), 1004);
  const checkpoint = db.prepare('PRAGMA wal_checkpoint(RESTART)').get()!;
  assert.equal(checkpoint.busy, 0);
  assert.equal(checkpoint.log, checkpoint.checkpointed);
  const unknownId = randomUUID();
  insert.run(unknownId, fingerprint, 'shell.exec', 'unknown', at, at,
    null, null, null, 1, at);
  // The real journal insert may touch more than one b-tree page. Account for
  // those frames instead of assuming a SQLite implementation detail.
  const currentCount = () => {
    const wal = readFileSync(file + '-wal');
    let count = 0;
    while (count < 1004 && wal.subarray(32 + count * frameBytes + 8,
      32 + count * frameBytes + 16).equals(wal.subarray(16, 24))) count++;
    return count;
  };
  const insertFrames = currentCount();
  const doubleWrites = 237 - insertFrames;
  const singleWrites = 235 + insertFrames;
  assert.ok(doubleWrites >= 0);
  for (let i = 0; i < doubleWrites; i++) db.exec(
    'BEGIN; UPDATE reuse_a SET value=value+1;' +
    'UPDATE reuse_b SET value=value+1; COMMIT;',
  );
  for (let i = 0; i < singleWrites; i++) db.exec('UPDATE reuse_a SET value=value+1');
  const wal = readFileSync(file + '-wal');
  const currentFrames = currentCount();
  let commits = 0;
  for (let i = 0; i < currentFrames; i++) {
    if (wal.readUInt32BE(32 + i * frameBytes + 4) !== 0) commits++;
  }
  assert.equal(currentFrames, 709);
  assert.equal(frameCount() - currentFrames, 295);
  assert.equal(commits, 473);
  assert.notEqual(wal.readUInt32BE(32 + 708 * frameBytes + 4), 0);
  const entries = rows(db);
  assert.equal(entries.length, 1307);
  report({kind: 'fixture', unknownId, digest: digest(entries),
    currentFrames, retainedFrames: 295, commits, rows: entries.length});
  // Parent kills only this writer after the FULL-synchronous commit and IPC
  // acknowledgement. Keep the connection open to retain authentic hot files.
  setInterval(() => {}, 1000);
} else if (mode === 'inspect' || mode === 'close') {
  const journal = new AgentOperationJournal(file);
  await journal.initialize();
  const db = new DatabaseSync(file, {readOnly: true});
  const entries = rows(db);
  for (const entry of entries) {
    assert.equal((await journal.begin(String(entry.request_id), fingerprint,
      'shell.exec')).created, false, 'an existing UUID must never be replayed');
  }
  assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
  const unknown = entries.filter(row => row.status === 'unknown');
  assert.equal(unknown.length, 1);
  assert.ok((await journal.inspect(String(unknown[0]!.request_id)))?.dispatchedAt);
  db.close();
  report({kind: 'inspected', digest: digest(entries), rows: entries.length,
    unknownId: unknown[0]!.request_id, unknownRows: unknown.length,
    deniedReplays: entries.length});
  if (mode === 'close') {
    journal.close();
    process.disconnect();
  } else setInterval(() => {}, 1000);
} else throw new Error('Unknown disposable journal worker mode');
