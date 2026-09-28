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


test('file metadata, mkdir, copy, move, patch, and delete work together', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-fileops-'));
  const policy = new PathPolicy([root]);
  const source = path.join(root, 'source.txt');
  const copied = path.join(root, 'nested', 'copied.txt');
  const moved = path.join(root, 'moved.txt');
  const dir = path.join(root, 'new-dir');

  await fs.writeFile(source, 'alpha beta alpha\n', 'utf8');

  await executeCapability('files.mkdir', { path: dir }, policy);
  const dirStat = await executeCapability('files.stat', { path: dir }, policy) as {
    data: { type: string };
  };
  assert.equal(dirStat.data.type, 'directory');

  await executeCapability('files.copy', {
    source,
    destination: copied,
    create_parents: true,
  }, policy);
  assert.equal(await fs.readFile(copied, 'utf8'), 'alpha beta alpha\n');

  await executeCapability('files.patch', {
    path: copied,
    operations: [
      { old_text: 'alpha', new_text: 'omega', expected_count: 2 },
    ],
  }, policy);
  assert.equal(await fs.readFile(copied, 'utf8'), 'omega beta omega\n');

  await executeCapability('files.move', {
    source: copied,
    destination: moved,
  }, policy);
  assert.equal(await fs.readFile(moved, 'utf8'), 'omega beta omega\n');
  await assert.rejects(() => fs.stat(copied));

  await executeCapability('files.delete', { path: moved }, policy);
  await assert.rejects(() => fs.stat(moved));
});

test('file patch refuses ambiguous occurrence counts without changing the file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-patch-'));
  const policy = new PathPolicy([root]);
  const file = path.join(root, 'value.txt');
  await fs.writeFile(file, 'same same', 'utf8');

  await assert.rejects(
    () =>
      executeCapability(
        'files.patch',
        {
          path: file,
          operations: [{ old_text: 'same', new_text: 'changed' }],
        },
        policy,
      ),
    /expected 1 occurrence\(s\), found 2/,
  );
  assert.equal(await fs.readFile(file, 'utf8'), 'same same');
});


test('file hashes support stale-read detection for conflict-safe patches', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-hash-'));
  const policy = new PathPolicy([root]);
  const file = path.join(root, 'value.txt');
  await fs.writeFile(file, 'alpha beta\n', 'utf8');

  const read = await executeCapability(
    'files.read',
    { path: file, include_sha256: true },
    policy,
  ) as { data: { content: string; sha256: string } };
  assert.equal(read.data.content, 'alpha beta\n');
  assert.match(read.data.sha256, /^[a-f0-9]{64}$/);

  const hash = await executeCapability(
    'files.hash',
    { path: file },
    policy,
  ) as { data: { sha256: string } };
  assert.equal(hash.data.sha256, read.data.sha256);

  const batch = await executeCapability(
    'files.read_many',
    { paths: [file], include_sha256: true },
    policy,
  ) as { data: { results: Array<{ sha256?: string }> } };
  assert.equal(batch.data.results[0]?.sha256, read.data.sha256);

  const patched = await executeCapability(
    'files.patch',
    {
      path: file,
      expected_sha256: read.data.sha256,
      operations: [{ old_text: 'alpha', new_text: 'omega' }],
    },
    policy,
  ) as { data: { originalSha256: string; sha256: string } };
  assert.equal(patched.data.originalSha256, read.data.sha256);
  assert.notEqual(patched.data.sha256, read.data.sha256);
  assert.equal(await fs.readFile(file, 'utf8'), 'omega beta\n');

  await assert.rejects(
    () =>
      executeCapability(
        'files.patch',
        {
          path: file,
          expected_sha256: read.data.sha256,
          operations: [{ old_text: 'omega', new_text: 'alpha' }],
        },
        policy,
      ),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'FILE_CONFLICT',
  );
  assert.equal(await fs.readFile(file, 'utf8'), 'omega beta\n');
});
