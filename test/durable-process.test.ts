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
      break;
    }
  }

  throw new Error(
    'Timed out waiting for durable process output: ' + pattern,
  );
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
      ? "while (($line = [Console]::ReadLine()) -ne $null) { Write-Output ('echo:' + $line); if ($line -eq 'quit') { break } }"
      : "while IFS= read -r line; do printf 'echo:%s\\n' \"$line\"; [ \"$line\" = quit ] && break; done";

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

    await first.write({
      session_id: started.sessionId,
      input: 'before',
      append_newline: true,
    });
    const before = await readUntil(
      first,
      started.sessionId,
      0,
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
    await fs.rm(root, { recursive: true, force: true });
  }
});
