import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import {WebSocketServer} from 'ws';
import {NEXOWIRE_VERSION} from '../src/version.js';
const payloadRoot = process.env.NEXOWIRE_JOURNAL_TEST_APP_ROOT;
const {verifyAgentJournalWal} = await import(payloadRoot
  ? pathToFileURL(path.join(payloadRoot, 'dist/src/agent/operation-journal-wal.js')).href
  : new URL('../src/agent/operation-journal-wal.js', import.meta.url).href);

type Report = {kind: string; digest: string; unknownId: string; rows: number;
  currentFrames?: number; retainedFrames?: number; commits?: number;
  unknownRows?: number; deniedReplays?: number};
const source = import.meta.url.endsWith('.ts');
const worker = fileURLToPath(new URL('./fixtures/agent-journal-restart-worker.' +
  (source ? 'ts' : 'js'), import.meta.url));
type Worker = {process: ChildProcess; exited: Promise<[number | null, NodeJS.Signals | null]>};
const workers = new WeakMap<TestContext, Worker[]>();

function launch(t: TestContext, args: string[], env: NodeJS.ProcessEnv = globalThis.process.env) {
  const process = spawn(globalThis.process.execPath,
    args, {env, stdio: ['ignore', 'pipe', 'pipe', 'ipc']});
  let stderr = '';
  process.stderr!.on('data', bytes => { stderr = (stderr + String(bytes)).slice(-1500); });
  process.stdout!.resume();
  const exited = new Promise<[number | null, NodeJS.Signals | null]>(resolve => {
    process.once('exit', (code, signal) => resolve([code, signal]));
    process.once('error', () => resolve([null, null]));
  });
  workers.get(t)!.push({process, exited});
  return {process, exited, stderr: () => stderr};
}

async function child(t: TestContext, file: string, mode: string) {
  const {process, exited, stderr} = launch(t,
    [...(source ? ['--import', 'tsx'] : []), worker, mode, file]);
  const report = await new Promise<Report>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Journal worker timed out: ' + stderr())), 30_000);
    const done = () => clearTimeout(timer);
    process.once('error', error => { done(); reject(error); });
    process.once('exit', code => {
      done(); reject(new Error('Journal worker exited before report (' + code + '): ' + stderr()));
    });
    process.once('message', message => { done(); resolve(message as Report); });
  });
  return {report, exited, kill: async () => {
    if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL');
    await exited;
  }};
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nw-restart-974-'));
  const active: Worker[] = [];
  workers.set(t, active);
  t.after(async () => {
    for (const child of active) {
      if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill('SIGKILL');
      await child.exited;
    }
    await rm(root, {recursive: true, force: true, maxRetries: 10, retryDelay: 100});
  });
  const file = path.join(root, 'operations.sqlite');
  const writer = await child(t, file, 'fixture');
  await writer.kill();
  assert.equal(writer.report.currentFrames, 709);
  assert.equal(writer.report.retainedFrames, 295);
  assert.equal(writer.report.commits, 473);
  return {root, file, expected: writer.report};
}

const hashes = async (file: string) => Promise.all(['', '-wal', '-shm'].map(async suffix =>
  createHash('sha256').update(await readFile(file + suffix)).digest('hex')));

function agentArgs(): string[] {
  const cli = payloadRoot ? path.join(payloadRoot, 'dist/src/cli.js')
    : fileURLToPath(new URL('../src/cli.' + (source ? 'ts' : 'js'), import.meta.url));
  return [...(!payloadRoot && source ? ['--import', 'tsx'] : []), cli, 'agent', 'run'];
}

function agentEnv(root: string, file: string, url: string): NodeJS.ProcessEnv {
  // No existing account, endpoint, token, Broker, CORE profile or Node hook may
  // leak into the disposable Agent. The local test Hub receives no mutations.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('NEXOWIRE_') && key !== 'NODE_OPTIONS'));
  return {...env, HOME: root, USERPROFILE: root,
    LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
    APPDATA: path.join(root, 'AppData', 'Roaming'),
    NEXOWIRE_AGENT_IDENTITY_FILE: path.join(root, 'identity.json'),
    NEXOWIRE_AGENT_OPERATION_JOURNAL_FILE: file,
    NEXOWIRE_PROCESS_STATE_FILE: path.join(root, 'processes.json'),
    NEXOWIRE_PROCESS_WORKER_ROOT: path.join(root, 'workers'),
    NEXOWIRE_TASK_GRAPH_STATE_FILE: path.join(root, 'tasks.json'),
    NEXOWIRE_RUNBOOK_STATE_FILE: path.join(root, 'runbooks.json'),
    NEXOWIRE_HUB_WS_URL: url, NEXOWIRE_AGENT_TOKEN: 'disposable-journal-test-token',
    NEXOWIRE_PRIVILEGE_MODE: 'direct', NEXOWIRE_ALLOWED_ROOTS: root};
}

test('#974: 1307 journal records survive 6 fresh crash restarts and a clean restart after real WAL reuse',
  {timeout: 120_000}, async t => {
    const {root, file, expected} = await fixture(t);
    const before = await hashes(file);
    await verifyAgentJournalWal(file);
    assert.deepEqual(await hashes(file), before, 'classification must not repair or rewrite any file');
    const baseOnly = path.join(root, 'checkpointed-base.sqlite');
    await writeFile(baseOnly, await readFile(file));
    const base = new DatabaseSync(baseOnly, {readOnly: true});
    try {
      assert.equal(base.prepare('SELECT request_id FROM agent_operation_journal WHERE request_id=?')
        .get(expected.unknownId), undefined, 'the UNKNOWN tombstone must exist only in the new WAL');
    } finally { base.close(); }
    for (let restart = 0; restart < 7; restart++) {
      const attempt = await child(t, file, restart === 6 ? 'close' : 'inspect');
      assert.equal(attempt.report.rows, 1307);
      assert.equal(attempt.report.digest, expected.digest, 'all stored fields must remain unchanged');
      assert.equal(attempt.report.unknownId, expected.unknownId);
      assert.equal(attempt.report.unknownRows, 1);
      assert.equal(attempt.report.deniedReplays, 1307);
      if (restart === 6) assert.equal((await attempt.exited)[0], 0);
      else await attempt.kill();
    }
    const final = await child(t, file, 'close');
    assert.equal(final.report.digest, expected.digest);
    assert.equal((await final.exited)[0], 0);
    t.diagnostic('SQLite-generated fixture: 709 current + 295 old frames; 1307 records; ' +
      '8 separate journal processes; no task, live Agent, Windows reboot, or physical CORE claim.');
  });

test('#974: the real Agent CLI reaches a disposable Hub after 3 crash restarts without repair or identity reset',
  {timeout: 120_000}, async t => {
    const {root, file, expected} = await fixture(t);
    const hub = new WebSocketServer({host: '127.0.0.1', port: 0});
    t.after(async () => {
      for (const socket of hub.clients) socket.terminate();
      await new Promise<void>(resolve => hub.close(() => resolve()));
    });
    await new Promise<void>((resolve, reject) => {hub.once('listening', resolve); hub.once('error', reject);});
    const address = hub.address();
    assert.ok(address && typeof address !== 'string');
    const env = agentEnv(root, file, 'ws://127.0.0.1:' + address.port + '/agent');
    let deviceId: unknown;
    for (let restart = 0; restart < 3; restart++) {
      let timer: NodeJS.Timeout | undefined;
      let agent: ReturnType<typeof launch>;
      const hello = new Promise<Record<string, unknown>>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Disposable Agent hello timed out: ' + agent.stderr())), 30_000);
        hub.once('connection', (socket, request) => {
          if (request.headers.authorization !== 'Bearer disposable-journal-test-token') {
            reject(new Error('Disposable Agent did not authenticate to the test Hub')); return;
          }
          socket.once('message', raw => {
            try { resolve(JSON.parse(raw.toString()) as Record<string, unknown>); }
            catch (error) { reject(error); }
          });
        });
      });
      agent = launch(t, agentArgs(), env);
      let message: Record<string, unknown>;
      try {
        message = await Promise.race([hello, agent.exited.then(([code]) => {
          throw new Error('Disposable Agent exited before hello (' + code + '): ' + agent.stderr());
        })]);
      } finally { clearTimeout(timer); }
      assert.equal(message.type, 'hello');
      const device = message.device as Record<string, unknown>;
      assert.equal(device.agentVersion, NEXOWIRE_VERSION);
      assert.equal(device.adminBridgeReady, false);
      if (restart === 0) deviceId = device.id;
      else assert.equal(device.id, deviceId, 'restart must preserve device identity');
      const diagnostic = JSON.parse(await readFile(path.join(root, 'native-agent/startup-diagnostic.json'), 'utf8'));
      assert.equal(diagnostic.phase, 'local-state-ready');
      assert.equal(diagnostic.automaticJournalRepair, false);
      assert.equal(diagnostic.activeConnectionVerified, false);
      agent.process.kill('SIGKILL');
      await agent.exited;
    }
    const inspection = await child(t, file, 'close');
    assert.equal(inspection.report.digest, expected.digest);
    assert.equal(inspection.report.deniedReplays, 1307);
    assert.equal((await inspection.exited)[0], 0);
  });

test('#974: repeated real Agent startup on damaged WAL remains denied, records the loop, and never repairs files',
  {timeout: 120_000}, async t => {
    const {root, file} = await fixture(t);
    const broken = Buffer.from(await readFile(file + '-wal'));
    broken[32 + 24 + 100]! ^= 1;
    await writeFile(file + '-wal', broken);
    const before = await hashes(file);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const agent = launch(t, agentArgs(), agentEnv(root, file, 'ws://127.0.0.1:1/agent'));
      let timer: NodeJS.Timeout | undefined;
      let code: number | null;
      try {
        [code] = await Promise.race([agent.exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Damaged journal was not rejected during startup')), 30_000);
          })]);
      } finally { clearTimeout(timer); }
      assert.equal(code, 1, agent.stderr());
      assert.match(agent.stderr(), /AgentJournalWalError/);
      assert.deepEqual(await hashes(file), before);
      const diagnostic = JSON.parse(await readFile(path.join(root, 'native-agent/startup-diagnostic.json'), 'utf8'));
      assert.equal(diagnostic.failureCode, 'AGENT_JOURNAL_WAL_CORRUPT');
      assert.equal(diagnostic.consecutiveFailures, attempt);
      assert.equal(diagnostic.restartLoopDetected, attempt === 3);
      assert.equal(diagnostic.automaticJournalRepair, false);
    }
  });

for (const damage of ['checksum', 'torn-frame', 'current-salt', 'index-copy'] as const) {
  test('#974: ' + damage + ' damage still rejects the incident-shaped WAL without automatic repair',
    {timeout: 60_000}, async t => {
      const {file} = await fixture(t);
      const suffix = damage === 'index-copy' ? '-shm' : '-wal';
      let bytes = Buffer.from(await readFile(file + suffix));
      if (damage === 'checksum') bytes[32 + 24 + 100]! ^= 1;
      else if (damage === 'torn-frame') bytes = bytes.subarray(0, bytes.length - 1);
      else if (damage === 'current-salt') bytes[32 + 8]! ^= 1;
      else bytes[48 + 16]! ^= 1;
      await writeFile(file + suffix, bytes);
      const before = await hashes(file);
      await assert.rejects(verifyAgentJournalWal(file), {code: 'AGENT_JOURNAL_WAL_CORRUPT'});
      assert.deepEqual(await hashes(file), before);
      await assert.rejects(child(t, file, 'inspect'), /AgentJournalWalError/);
      assert.deepEqual(await hashes(file), before, 'actual journal startup must also leave damage intact');
    });
}
