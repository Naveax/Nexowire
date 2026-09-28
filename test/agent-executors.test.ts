import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { executeCapability } from '../src/agent/executors.js';
import { PathPolicy } from '../src/agent/path-policy.js';

test('native file capabilities round-trip content inside the allowlist', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-files-'));
  const policy = new PathPolicy([root]);
  const file = path.join(root, 'nested', 'hello.txt');
  const written = await executeCapability('files.write', {
    path: file,
    content: 'hello nexowire',
    create_parents: true,
  }, policy);
  assert.ok(written);
  const read = await executeCapability('files.read', { path: file }, policy) as { data: { content: string } };
  assert.equal(read.data.content, 'hello nexowire');
  const listed = await executeCapability('files.list', { path: root, depth: 3 }, policy) as { data: { entries: Array<{ path: string }> } };
  assert.ok(listed.data.entries.some((entry) => entry.path.endsWith('hello.txt')));
});

test('shell.exec captures stdout and exit code', async () => {
  const policy = new PathPolicy(['*']);
  const result = await executeCapability(
    'shell.exec',
    { command: `node -e "process.stdout.write('nexowire-ok')"`, timeout_ms: 10_000 },
    policy,
  ) as { stdout: string; exitCode: number | null };
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'nexowire-ok');
});
