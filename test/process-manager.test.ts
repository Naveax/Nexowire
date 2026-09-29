import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ProcessManager } from '../src/agent/process-manager.js';
import { PathPolicy } from '../src/agent/path-policy.js';

test('process manager captures incremental output and exit state', async () => {
  const manager = new ProcessManager();
  const policy = new PathPolicy(['*']);
  const command = process.platform === 'win32'
    ? "Write-Output 'ready'; Start-Sleep -Milliseconds 50; Write-Output 'done'"
    : "printf 'ready\n'; sleep 0.05; printf 'done\n'";
  const started = await manager.start({
    command,
    shell: process.platform === 'win32' ? 'pwsh' : 'bash',
    name: 'test-process',
  }, policy);
  assert.equal(started.status, 'running');
  let afterSeq = 0;
  let text = '';
  let finalStatus = 'running';
  let finalExitCode: number | null = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const read = await manager.read({
      session_id: started.sessionId,
      after_seq: afterSeq,
      max_events: 20,
      wait_ms: 1_000,
    });
    text += read.events.map((event) => event.text).join('');
    afterSeq = read.nextSeq;
    finalStatus = read.session.status;
    finalExitCode = read.session.exitCode;
    if (finalStatus === 'exited') break;
  }
  assert.match(text, /ready/);
  assert.match(text, /done/);
  assert.equal(finalStatus, 'exited');
  assert.equal(finalExitCode, 0);
});

test('process manager can stop a long-running process', async () => {
  const manager = new ProcessManager();
  const policy = new PathPolicy(['*']);
  const started = await manager.start({
    command: `node -e "setInterval(() => {}, 1000)"`,
  }, policy);
  await manager.stop({ session_id: started.sessionId });
  for (let i = 0; i < 20; i++) {
    const read = await manager.read({ session_id: started.sessionId, wait_ms: 50 });
    if (read.session.status === 'exited') {
      assert.equal(read.session.status, 'exited');
      return;
    }
  }
  assert.fail('process did not exit after stop');
});

test('process manager supports stdin for interactive sessions', async () => {
  const manager = new ProcessManager();
  const policy = new PathPolicy(['*']);
  const command = process.platform === 'win32'
    ? "$line = [Console]::ReadLine(); Write-Output ('echo:' + $line)"
    : "IFS= read -r line; printf 'echo:%s\\n' \"$line\"";
  const started = await manager.start({
    command,
    shell: process.platform === 'win32' ? 'pwsh' : 'bash',
  }, policy);

  assert.ok(manager.list().some((session) => session.sessionId === started.sessionId));
  await manager.write({
    session_id: started.sessionId,
    input: 'hello',
    append_newline: true,
  });

  let text = '';
  let afterSeq = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    const read = await manager.read({
      session_id: started.sessionId,
      after_seq: afterSeq,
      max_events: 20,
      wait_ms: 1_000,
    });
    text += read.events.map((event) => event.text).join('');
    afterSeq = read.nextSeq;
    if (read.session.status === 'exited') break;
  }

  assert.match(text, /echo:hello/);
});


test('process metadata survives restart without persisting command payloads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-process-state-'));
  const stateFile = path.join(root, 'sessions.json');
  const policy = new PathPolicy(['*']);
  const first = new ProcessManager({ stateFile, exitedRetentionMs: 60_000 });
  await first.initialize();

  const started = await first.start({
    command: `node -e "setInterval(() => {}, 1000)" # secret-token-123`,
    name: 'recover-me',
  }, policy);

  const rawState = await fs.readFile(stateFile, 'utf8');
  assert.doesNotMatch(rawState, /secret-token-123/);
  assert.doesNotMatch(rawState, /setInterval/);

  const second = new ProcessManager({ stateFile, exitedRetentionMs: 60_000 });
  await second.initialize();
  const recovered = second.list().find(
    (session) => session.sessionId === started.sessionId,
  );
  assert.ok(recovered);
  assert.equal(recovered.status, 'orphaned');
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.interactive, false);
  assert.equal('command' in recovered, false);

  await assert.rejects(
    () =>
      second.write({
        session_id: started.sessionId,
        input: 'hello',
        append_newline: true,
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'PROCESS_SESSION_NOT_REATTACHABLE',
  );
  await assert.rejects(
    () => second.stop({ session_id: started.sessionId }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'PROCESS_RECOVERY_VERIFICATION_REQUIRED',
  );

  await first.stop({ session_id: started.sessionId });
  await fs.rm(root, { recursive: true, force: true });
});

test('process history can be explicitly pruned', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-process-prune-'));
  const stateFile = path.join(root, 'sessions.json');
  const policy = new PathPolicy(['*']);
  const manager = new ProcessManager({ stateFile, exitedRetentionMs: 60_000 });
  await manager.initialize();

  const command = process.platform === 'win32'
    ? "Write-Output 'done'"
    : "printf 'done\\n'";
  const started = await manager.start({
    command,
    shell: process.platform === 'win32' ? 'pwsh' : 'bash',
  }, policy);

  let afterSeq = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    const read = await manager.read({
      session_id: started.sessionId,
      after_seq: afterSeq,
      wait_ms: 250,
    });
    afterSeq = read.nextSeq;
    if (read.session.status === 'exited') break;
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
  const result = await manager.prune({ older_than_ms: 0 });
  assert.equal(result.removed, 1);
  assert.equal(manager.list().length, 0);

  await fs.rm(root, { recursive: true, force: true });
});


test('process manager emits bounded process events without command payloads', async () => {
  const policy = new PathPolicy(['*']);
  const emitted: Array<{ topic: string; data: Record<string, unknown> }> = [];
  const manager = new ProcessManager({
    onEvent: (event) => emitted.push(event),
  });

  const started = await manager.start(
    {
      command: `node -e "console.log('event-output')"`,
      name: 'event-test',
    },
    policy,
  );

  let afterSeq = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    const read = await manager.read({
      session_id: started.sessionId,
      after_seq: afterSeq,
      wait_ms: 250,
    });
    afterSeq = read.nextSeq;
    if (read.session.status === 'exited') break;
  }

  assert.ok(emitted.some((event) => event.topic === 'process.started'));
  assert.ok(
    emitted.some(
      (event) =>
        event.topic === 'process.output' &&
        /event-output/.test(String(event.data.text ?? '')),
    ),
  );
  assert.ok(emitted.some((event) => event.topic === 'process.exited'));
  const startedEvent = emitted.find((event) => event.topic === 'process.started');
  assert.ok(startedEvent);
  assert.equal('command' in startedEvent.data, false);
});
