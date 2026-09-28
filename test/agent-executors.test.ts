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


test('batch reads and text search reduce remote round trips', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-batch-'));
  const policy = new PathPolicy([root]);
  const first = path.join(root, 'first.ts');
  const second = path.join(root, 'second.ts');
  await fs.writeFile(first, 'alpha needle one\nsecond line\n', 'utf8');
  await fs.writeFile(second, 'beta\nNEEDLE two\n', 'utf8');
  await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules', 'ignored.js'), 'needle ignored', 'utf8');

  const batch = await executeCapability('files.read_many', {
    paths: [first, second, path.join(root, 'missing.ts')],
  }, policy) as {
    data: { results: Array<{ path: string; ok: boolean; content?: string }> };
  };
  assert.equal(batch.data.results.length, 3);
  assert.equal(batch.data.results.filter((result) => result.ok).length, 2);
  assert.match(batch.data.results[0]?.content ?? '', /alpha/);

  const search = await executeCapability('search.text', {
    path: root,
    query: 'needle',
  }, policy) as {
    data: { matches: Array<{ path: string; line: number; column: number }>; truncated: boolean };
  };
  assert.equal(search.data.matches.length, 2);
  assert.equal(search.data.truncated, false);
  assert.ok(search.data.matches.some((match) => match.path === 'first.ts' && match.line === 1));
  assert.ok(search.data.matches.some((match) => match.path === 'second.ts' && match.line === 2));
  assert.ok(search.data.matches.every((match) => !match.path.includes('node_modules')));
});

test('workspace snapshot reports markers that actually exist', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-workspace-'));
  const policy = new PathPolicy([root]);
  await fs.writeFile(path.join(root, 'package.json'), '{}', 'utf8');
  await fs.writeFile(path.join(root, 'demo.sln'), '', 'utf8');
  await new Promise<void>((resolve, reject) => {
    const child = process.platform === 'win32'
      ? import('node:child_process').then(({ spawn }) => spawn('git', ['init'], { cwd: root, windowsHide: true }))
      : import('node:child_process').then(({ spawn }) => spawn('git', ['init'], { cwd: root }));
    child.then((proc) => {
      proc.once('error', reject);
      proc.once('close', (code) => code === 0 ? resolve() : reject(new Error(`git init failed: ${code}`)));
    }).catch(reject);
  });

  const snapshot = await executeCapability('workspace.snapshot', { path: root }, policy) as {
    data: { projectMarkers: string[] };
  };
  assert.deepEqual(snapshot.data.projectMarkers.sort(), ['demo.sln', 'package.json']);
});
