import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ProcessManager } from '../src/agent/process-manager.js';
import { PathPolicy } from '../src/agent/path-policy.js';

async function readUntil(
  manager: ProcessManager,
  sessionId: string,
  afterSeq: number,
  pattern: RegExp,
  timeoutMs = 10_000,
): Promise<{ text: string; nextSeq: number; status: string }> {
  const deadline = Date.now() + timeoutMs;
  let cursor = afterSeq;
  let text = '';

  while (Date.now() < deadline) {
    const read = await manager.read({
      session_id: sessionId,
      after_seq: cursor,
      max_events: 100,
      wait_ms: 250,
    });
    text += read.events.map((event) => event.text).join('');
    cursor = read.nextSeq;
    if (pattern.test(text)) {
      return {
        text,
        nextSeq: cursor,
        status: read.session.status,
      };
    }
    if (read.session.status !== 'running') {
      throw new Error(
        'Durable worker exited before expected output: ' + pattern +
        ' status=' + read.session.status +
        ' exitCode=' + String(read.session.exitCode) +
        ' captured=' + text.slice(-2048),
      );
    }
  }

  throw new Error(
    'Timed out waiting for durable process output: ' + pattern,
  );
}

/**
 * The durable worker alone may attest final exit. Do not mistake a received
 * quit/echo, a dead PID or the transport's success for an exited process.
 * A completed atomic .tmp status is a valid recovery candidate; partial
 * status records and stale running data are not evidence of completion.
 */
async function requireDurableExitRecord(
  workerDir: string, sessionId: string, timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const filename of ['status.json', 'status.json.tmp']) {
      let entry: unknown;
      try {
        entry = JSON.parse(await fs.readFile(path.join(workerDir, filename), 'utf8'));
      } catch {
        // A concurrently written temp file may be incomplete. Never trust it.
        continue;
      }
      if (!entry || typeof entry !== 'object') continue;
      const proof = entry as Record<string, unknown>;
      if (proof.version === 1 && proof.sessionId === sessionId &&
          proof.status === 'exited' && proof.exitCode === 0 &&
          typeof proof.exitedAt === 'string' && !Number.isNaN(Date.parse(proof.exitedAt))) {
        return;
      }
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Worker never durably confirmed exited status after quit; refuse task success');
}

test('durable process stdin/stdout reattaches across ProcessManager restart', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-durable-process-'),
  );
  const stateFile = path.join(root, 'sessions.json');
  const workerRoot = path.join(root, 'workers');
  const policy = new PathPolicy(['*']);
  const options = {
    stateFile,
    workerRoot,
    workerEntrypoint: path.resolve('src/cli.ts'),
    workerExecArgv: process.execArgv,
    exitedRetentionMs: 60_000,
  };

  const first = new ProcessManager(options);
  await first.initialize();

  const command =
    process.platform === 'win32'
      ? "Write-Output 'NW_DURABLE_READY'; while (($line = [Console]::ReadLine()) -ne $null) { Write-Output ('echo:' + $line); if ($line -eq 'quit') { break } }"
      : "printf 'NW_DURABLE_READY\\n'; while IFS= read -r line; do printf 'echo:%s\\n' \"$line\"; [ \"$line\" = quit ] && break; done";

  let second: ProcessManager | undefined;
  try {
    const started = await first.start(
      {
        command,
        shell: process.platform === 'win32' ? 'pwsh' : 'bash',
        name: 'durable-echo',
        durable: true,
      },
      policy,
    );

    assert.equal(started.durable, true);
    assert.equal(started.reattachable, true);
    assert.equal(started.interactive, true);

    // Require first-party shell output before sending a mutation.
    // A premature exit remains FAIL; do not retry writes after UNKNOWN.
    const ready = await readUntil(first, started.sessionId, 0, /NW_DURABLE_READY/);
    assert.equal(ready.status, 'running');

    await first.write({
      session_id: started.sessionId,
      input: 'before',
      append_newline: true,
    });
    const before = await readUntil(
      first,
      started.sessionId,
      ready.nextSeq,
      /echo:before/,
    );

    await first.shutdown();

    second = new ProcessManager(options);
    await second.initialize();

    const recovered = second
      .list()
      .find((entry) => entry.sessionId === started.sessionId);
    assert.ok(recovered);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.durable, true);
    assert.equal(recovered.status, 'running');
    assert.equal(recovered.reattachable, true);
    assert.equal(recovered.interactive, true);

    await second.write({
      session_id: started.sessionId,
      input: 'after',
      append_newline: true,
    });
    const after = await readUntil(
      second,
      started.sessionId,
      before.nextSeq,
      /echo:after/,
    );
    assert.match(after.text, /echo:after/);

    await second.write({
      session_id: started.sessionId,
      input: 'quit',
      append_newline: true,
    });
    // Synchronize against actual durable worker completion, not command echo
    // or the (possibly already dead) worker PID. The original exited assertion
    // remains mandatory below; lost, orphaned and unknown are NOT accepted.
    await requireDurableExitRecord(
      path.join(workerRoot, started.sessionId), started.sessionId,
    );

    let finalStatus = 'running';
    let finalCursor = after.nextSeq;
    for (let attempt = 0; attempt < 80; attempt++) {
      const read = await second.read({
        session_id: started.sessionId,
        after_seq: finalCursor,
        wait_ms: 100,
      });
      finalCursor = read.nextSeq;
      finalStatus = read.session.status;
      if (finalStatus !== 'running') break;
    }
    assert.equal(finalStatus, 'exited');

    const rawState = await fs.readFile(stateFile, 'utf8');
    assert.doesNotMatch(rawState, /before|after|quit/);
    assert.doesNotMatch(rawState, /while \(\(\$line|while IFS=/);
    assert.doesNotMatch(rawState, /token/i);
  } finally {
    await second?.stopAll().catch(() => undefined);
    await first.stopAll().catch(() => undefined);
    // stopAll may observe the durable session as exited while the detached
    // worker is still closing its control socket and flushing atomic files.
    // Clear both manager monitors and await queued state persistence first.
    await second?.shutdown().catch(() => undefined);
    await first.shutdown().catch(() => undefined);
    // Windows/Unix filesystem teardown can still race a just-closed worker.
    // Only retry transient filesystem removal errors, with a strict bound.
    await fs.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 12,
      retryDelay: 100,
    });
  }
});

test('durable process recovers terminal status from a completed atomic temp record', async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'nexowire-durable-terminal-recovery-'),
  );
  const stateFile = path.join(root, 'sessions.json');
  const workerDir = path.join(root, 'worker');
  const sessionId = '11111111-1111-4111-8111-111111111111';
  const deadPid = 2_147_483_000;
  const now = Date.now();
  const startedAt = new Date(now - 2_000).toISOString();
  const exitedAt = new Date(now - 1_000).toISOString();

  try {
    await fs.mkdir(workerDir, { recursive: true });
    await fs.writeFile(
      path.join(workerDir, 'events.jsonl'),
      '',
      'utf8',
    );
    await fs.writeFile(
      path.join(workerDir, 'status.json'),
      JSON.stringify({
        version: 1,
        sessionId,
        workerPid: deadPid,
        childPid: deadPid - 1,
        status: 'running',
        startedAt,
        exitCode: null,
        signal: null,
        nextSeq: 1,
        maxBufferBytes: 4_194_304,
      }) + '\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(workerDir, 'status.json.tmp'),
      JSON.stringify({
        version: 1,
        sessionId,
        workerPid: deadPid,
        childPid: deadPid - 1,
        status: 'exited',
        startedAt,
        exitedAt,
        exitCode: 0,
        signal: null,
        nextSeq: 1,
        maxBufferBytes: 4_194_304,
      }) + '\n',
      'utf8',
    );
    await fs.writeFile(
      stateFile,
      JSON.stringify({
        version: 1,
        sessions: [
          {
            id: sessionId,
            pid: deadPid - 1,
            shell: 'pwsh',
            startedAt,
            exitCode: null,
            signal: null,
            status: 'running',
            durable: true,
            workerDir,
            workerPid: deadPid,
          },
        ],
      }) + '\n',
      'utf8',
    );

    const manager = new ProcessManager({
      stateFile,
      workerRoot: path.join(root, 'workers'),
      exitedRetentionMs: 60_000_000,
    });
    await manager.initialize();

    const recovered = manager
      .list()
      .find((entry) => entry.sessionId === sessionId);
    assert.ok(recovered);
    assert.equal(recovered.status, 'exited');
    assert.equal(recovered.exitCode, 0);
    assert.equal(recovered.exitedAt, exitedAt);
    assert.equal(recovered.recovered, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('durable dead worker without terminal evidence remains lost, never exited', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-durable-lost-negative-'));
  const stateFile = path.join(root, 'sessions.json');
  const workerDir = path.join(root, 'worker');
  const sessionId = '22222222-2222-4222-8222-222222222222';
  const unavailablePid = 2_147_483_000;
  const startedAt = new Date(Date.now() - 1_000).toISOString();
  try {
    await fs.mkdir(workerDir, { recursive: true });
    await fs.writeFile(path.join(workerDir, 'events.jsonl'), '', 'utf8');
    await fs.writeFile(path.join(workerDir, 'status.json'), JSON.stringify({
      version: 1, sessionId, workerPid: unavailablePid,
      childPid: unavailablePid - 1, status: 'running', startedAt,
      exitCode: null, signal: null, nextSeq: 1, maxBufferBytes: 4_194_304,
    }) + '\n', 'utf8');
    await fs.writeFile(stateFile, JSON.stringify({
      version: 1, sessions: [{
        id: sessionId, pid: unavailablePid - 1, shell: 'bash',
        startedAt, exitCode: null, signal: null, status: 'running',
        durable: true, workerDir, workerPid: unavailablePid,
      }],
    }) + '\n', 'utf8');
    const manager = new ProcessManager({
      stateFile, workerRoot: path.join(root, 'workers'),
      exitedRetentionMs: 60_000_000,
    });
    await manager.initialize();
    const recovered = manager.list().find(entry => entry.sessionId === sessionId);
    assert.ok(recovered);
    assert.equal(recovered.status, 'lost');
    assert.equal(recovered.exitCode, null);
    assert.equal(recovered.recovered, true);
    await assert.rejects(requireDurableExitRecord(workerDir, sessionId, 120),
      /never durably confirmed exited status/);
    const detail = await manager.read({ session_id: sessionId, after_seq: 0, wait_ms: 0 });
    assert.equal(detail.session.status, 'lost');
    assert.equal(detail.session.exitCode, null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
