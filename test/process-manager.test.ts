import test from 'node:test';
import assert from 'node:assert/strict';
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
