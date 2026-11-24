import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile, symlink, stat, mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {initializeNativeAgentState, nativeAgentStartupDiagnosticPath,
  readNativeAgentStartupDiagnostic} from '../src/agent/native-agent-startup-diagnostic.js';
import {AgentJournalWalError, AgentJournalWalUnstableError,
  verifyAgentJournalWal} from '../src/agent/operation-journal-wal.js';

async function sandbox(t: TestContext) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'nw-startup-diagnostic-'));
  t.after(() => rm(homeDir, {recursive: true, force: true}));
  return {homeDir};
}

test('persistent startup failure records a bounded redacted restart-loop diagnosis and preserves the original error', async t => {
  const options = await sandbox(t);
  const error = new AgentJournalWalError('Bearer secret-canary nwx_secret-canary C:\\private\\journal.sqlite');
  for (let attempt = 1; attempt <= 4; attempt++) {
    await assert.rejects(initializeNativeAgentState(async () => { throw error; }, options),
      observed => observed === error);
    const diagnostic = await readNativeAgentStartupDiagnostic(options);
    assert.equal(diagnostic?.consecutiveFailures, attempt);
    assert.equal(diagnostic?.restartLoopDetected, attempt >= 3);
    assert.equal(diagnostic?.failureCode, 'AGENT_JOURNAL_WAL_CORRUPT');
    assert.equal(diagnostic?.automaticJournalRepair, false);
    assert.equal(diagnostic?.activeConnectionVerified, false);
    assert.equal(diagnostic?.coreAuthorityVerified, false);
  }
  const text = await readFile(nativeAgentStartupDiagnosticPath(options), 'utf8');
  assert.ok(Buffer.byteLength(text) < 1024);
  assert.doesNotMatch(text, /Bearer|secret-canary|private|journal\.sqlite/);
  await writeFile(nativeAgentStartupDiagnosticPath(options),
    JSON.stringify({...JSON.parse(text), consecutiveFailures: 998}));
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(initializeNativeAgentState(async () => { throw error; }, options));
    assert.equal((await readNativeAgentStartupDiagnostic(options))?.consecutiveFailures, 999);
  }
  if (process.platform !== 'win32') {
    assert.equal((await stat(nativeAgentStartupDiagnosticPath(options))).mode & 0o777, 0o600);
  }
});

test('successful local initialization clears the failure streak without claiming a live connection or CORE', async t => {
  const options = await sandbox(t);
  await assert.rejects(initializeNativeAgentState(async () => { throw new Error('token-canary'); }, options));
  assert.equal((await readNativeAgentStartupDiagnostic(options))?.failureCode,
    'NATIVE_AGENT_INITIALIZATION_FAILED');
  assert.equal(await initializeNativeAgentState(async () => 42, options), 42);
  const diagnostic = await readNativeAgentStartupDiagnostic(options);
  assert.equal(diagnostic?.phase, 'local-state-ready');
  assert.equal(diagnostic?.failureCode, null);
  assert.equal(diagnostic?.consecutiveFailures, 0);
  assert.equal(diagnostic?.restartLoopDetected, false);
  assert.equal(diagnostic?.activeConnectionVerified, false);
  assert.equal(diagnostic?.coreAuthorityVerified, false);
});

test('diagnostic I/O failure cannot mask journal rejection or turn it into successful startup', async t => {
  const options = await sandbox(t);
  await mkdir(path.join(options.homeDir, '.nexowire'));
  await writeFile(path.join(options.homeDir, '.nexowire', 'native-agent'), 'not a directory');
  const error = new AgentJournalWalError('fail closed');
  await assert.rejects(initializeNativeAgentState(async () => { throw error; }, options),
    observed => observed === error);
  assert.equal(await readNativeAgentStartupDiagnostic(options), null);
  assert.equal(await initializeNativeAgentState(async () => 'ready', options), 'ready');
});

test('malformed, oversized and forged authority diagnostic files are not accepted as state', async t => {
  const options = await sandbox(t);
  await initializeNativeAgentState(async () => {}, options);
  const file = nativeAgentStartupDiagnosticPath(options);
  const valid = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  for (const text of ['not-json', 'x'.repeat(4097),
    JSON.stringify({...valid, activeConnectionVerified: true}),
    JSON.stringify({...valid, coreAuthorityVerified: true}),
    JSON.stringify({...valid, restartLoopDetected: true}),
    JSON.stringify({...valid, consecutiveFailures: 1}),
    JSON.stringify({...valid, consecutiveFailures: 1000}),
    JSON.stringify({...valid, failureCode: 'Bearer credential-canary'})]) {
    await writeFile(file, text);
    assert.equal(await readNativeAgentStartupDiagnostic(options), null);
  }
});

test('custom journal configuration keeps the diagnostic beside that profile and never edits journal bytes', async t => {
  const {homeDir} = await sandbox(t);
  const journal = path.join(homeDir, 'isolated-profile', 'operations.sqlite');
  await mkdir(path.dirname(journal));
  await writeFile(journal, 'journal-canary');
  const options = {homeDir, env: {NEXOWIRE_AGENT_OPERATION_JOURNAL_FILE: journal}};
  await initializeNativeAgentState(async () => {}, options);
  assert.equal(await readFile(journal, 'utf8'), 'journal-canary');
  assert.equal((await readNativeAgentStartupDiagnostic(options))?.phase, 'local-state-ready');
  assert.equal(await readNativeAgentStartupDiagnostic({homeDir}), null);
});

test('a symlink diagnostic is ignored rather than followed', {skip: process.platform === 'win32'}, async t => {
  const options = await sandbox(t);
  await initializeNativeAgentState(async () => {}, options);
  const file = nativeAgentStartupDiagnosticPath(options);
  const target = path.join(options.homeDir, 'outside.json');
  await writeFile(target, await readFile(file));
  await rm(file);
  await symlink(target, file);
  assert.equal(await readNativeAgentStartupDiagnostic(options), null);
});

test('startup diagnostics bind the process and a cutover nonce without treating the nonce as authority', async t => {
  const {homeDir} = await sandbox(t);
  const nonce = randomUUID();
  const options = {homeDir, env: {NEXOWIRE_UPDATE_STARTUP_NONCE: nonce}};
  await initializeNativeAgentState(async () => {}, options);
  const value = await readNativeAgentStartupDiagnostic(options);
  assert.equal(value?.processId, process.pid);
  assert.equal(value?.startupNonce, nonce);
  assert.equal(value?.coreAuthorityVerified, false);
  assert.equal(value?.activeConnectionVerified, false);
  await initializeNativeAgentState(async () => {},
    {homeDir, env: {NEXOWIRE_UPDATE_STARTUP_NONCE: 'Bearer secret-canary'}});
  assert.equal((await readNativeAgentStartupDiagnostic({homeDir}))?.startupNonce, undefined);
  assert.doesNotMatch(await readFile(nativeAgentStartupDiagnosticPath({homeDir}), 'utf8'), /secret-canary|Bearer/);
});


// #1289: real persistent SHM timestamp drift must surface as UNSTABLE,
// never CORRUPT, IN_USE, readiness, repair or mutation authority.
test('persistent WAL snapshot instability preserves exact startup failure and journal history', async t => {
  const {homeDir} = await sandbox(t);
  const live = path.join(homeDir, 'live.sqlite');
  const journal = path.join(homeDir, 'copy.sqlite');
  const db = new DatabaseSync(live);
  const suffixes = ['', '-wal', '-shm'] as const;
  const bytes: Buffer[] = [];
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0;');
    db.exec("CREATE TABLE ledger(id TEXT PRIMARY KEY,status TEXT NOT NULL)");
    db.prepare('INSERT INTO ledger VALUES(?,?)').run('durable-reservation','unknown');
    for (const suffix of suffixes) bytes.push(await readFile(live + suffix));
  } finally { db.close(); }
  assert.ok(bytes[1]!.length > 32, 'ordinary committed WAL required');
  for (const [index, suffix] of suffixes.entries()) await writeFile(journal + suffix, bytes[index]!);

  const nonce = randomUUID();
  const options = {homeDir, env: {
    NEXOWIRE_AGENT_OPERATION_JOURNAL_FILE: journal,
    NEXOWIRE_UPDATE_STARTUP_NONCE: nonce,
  }};
  const realLstat = fs.lstat.bind(fs);
  let reads = 0;
  let changes = 0;
  const drift = t.mock.method(fs, 'lstat', async (target: string) => {
    if (target === journal + '-shm' && ++reads % 2 === 0) {
      const before = await realLstat(target);
      await fs.utimes(target, before.atime, new Date(before.mtimeMs + 60000));
      const after = await realLstat(target);
      assert.equal(after.dev, before.dev);
      assert.equal(after.ino, before.ino);
      assert.equal(after.size, before.size);
      assert.notEqual(after.mtimeMs, before.mtimeMs);
      changes++;
      return after;
    }
    return realLstat(target);
  });
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      let original: unknown;
      let reachedReady = false;
      await assert.rejects(initializeNativeAgentState(async () => {
        try { await verifyAgentJournalWal(journal); }
        catch (error) { original = error; throw error; }
        reachedReady = true;
      }, options), error => error === original &&
        error instanceof AgentJournalWalUnstableError &&
        error.code === 'AGENT_JOURNAL_WAL_UNSTABLE');
      assert.equal(reachedReady, false);
      assert.equal(changes, attempt * 3);
      const diagnostic = await readNativeAgentStartupDiagnostic(options);
      assert.equal(diagnostic?.schemaVersion, 1);
      assert.equal(diagnostic?.phase, 'initialization-failed');
      assert.equal(diagnostic?.failureCode, 'AGENT_JOURNAL_WAL_UNSTABLE');
      assert.equal(diagnostic?.consecutiveFailures, attempt);
      assert.equal(diagnostic?.restartLoopDetected, attempt >= 3);
      assert.equal(diagnostic?.processId, process.pid);
      assert.equal(diagnostic?.startupNonce, nonce);
      assert.equal(diagnostic?.automaticJournalRepair, false);
      assert.equal(diagnostic?.activeConnectionVerified, false);
      assert.equal(diagnostic?.coreAuthorityVerified, false);
      for (const [index, suffix] of suffixes.entries())
        assert.deepEqual(await readFile(journal + suffix), bytes[index]);
    }
  } finally { drift.mock.restore(); }

  // A separate genuine, stable preflight is required to clear the failure.
  await initializeNativeAgentState(() => verifyAgentJournalWal(journal), options);
  const ready = await readNativeAgentStartupDiagnostic(options);
  assert.equal(ready?.phase, 'local-state-ready');
  assert.equal(ready?.failureCode, null);
  assert.equal(ready?.consecutiveFailures, 0);
  assert.equal(ready?.restartLoopDetected, false);
  assert.equal(ready?.automaticJournalRepair, false);
  assert.equal(ready?.activeConnectionVerified, false);
  assert.equal(ready?.coreAuthorityVerified, false);
  for (const [index, suffix] of suffixes.entries())
    assert.deepEqual(await readFile(journal + suffix), bytes[index]);
});

test('startup diagnostic distinguishes UNSTABLE, CORRUPT, IN_USE and unrecognized failures without leaking messages', async t => {
  const options = await sandbox(t);
  const unstable = new AgentJournalWalUnstableError();
  const corrupt = new AgentJournalWalError('secret-canary');
  const inUse = Object.assign(new Error('secret-canary'), {code: 'AGENT_JOURNAL_IN_USE'});
  const unknown = Object.assign(new Error('secret-canary'), {code: 'UNTRUSTED_CANARY'});
  const cases = [
    [unstable, 'AGENT_JOURNAL_WAL_UNSTABLE'],
    [corrupt, 'AGENT_JOURNAL_WAL_CORRUPT'],
    [inUse, 'AGENT_JOURNAL_IN_USE'],
    [unknown, 'NATIVE_AGENT_INITIALIZATION_FAILED'],
  ] as const;
  for (const [index, [error, code]] of cases.entries()) {
    await assert.rejects(initializeNativeAgentState(async () => { throw error; }, options),
      actual => actual === error);
    const value = await readNativeAgentStartupDiagnostic(options);
    assert.equal(value?.failureCode, code);
    assert.equal(value?.phase, 'initialization-failed');
    assert.equal(value?.consecutiveFailures, index + 1);
    assert.equal(value?.restartLoopDetected, index >= 2);
    assert.equal(value?.automaticJournalRepair, false);
    assert.equal(value?.activeConnectionVerified, false);
    assert.equal(value?.coreAuthorityVerified, false);
  }
  assert.doesNotMatch(await readFile(nativeAgentStartupDiagnosticPath(options), 'utf8'),
    /secret-canary|UNTRUSTED_CANARY/);
});

test('UNSTABLE diagnostic cannot claim readiness or authority and diagnostic I/O cannot mask the original error', async t => {
  const options = await sandbox(t);
  const error = new AgentJournalWalUnstableError();
  await assert.rejects(initializeNativeAgentState(async () => { throw error; }, options),
    actual => actual === error);
  const file = nativeAgentStartupDiagnosticPath(options);
  const valid = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  assert.equal(valid.failureCode, 'AGENT_JOURNAL_WAL_UNSTABLE');
  for (const forged of [
    {...valid, phase: 'local-state-ready'},
    {...valid, phase: 'local-state-ready', consecutiveFailures: 0},
    {...valid, automaticJournalRepair: true},
    {...valid, activeConnectionVerified: true},
    {...valid, coreAuthorityVerified: true},
    {...valid, consecutiveFailures: 0},
    {...valid, restartLoopDetected: true},
  ]) {
    await writeFile(file, JSON.stringify(forged));
    assert.equal(await readNativeAgentStartupDiagnostic(options), null);
  }
  await rm(path.dirname(file), {recursive: true, force: true});
  await writeFile(path.dirname(file), 'not a directory');
  await assert.rejects(initializeNativeAgentState(async () => { throw error; }, options),
    actual => actual === error);
  assert.equal(await readNativeAgentStartupDiagnostic(options), null);
});
