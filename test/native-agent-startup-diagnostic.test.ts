import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile, symlink, stat, mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {initializeNativeAgentState, nativeAgentStartupDiagnosticPath,
  readNativeAgentStartupDiagnostic} from '../src/agent/native-agent-startup-diagnostic.js';
import {AgentJournalWalError} from '../src/agent/operation-journal-wal.js';

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
