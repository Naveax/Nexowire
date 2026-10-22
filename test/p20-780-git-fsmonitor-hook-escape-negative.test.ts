import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeCapability } from '../src/agent/executors.js';
import { PathPolicy } from '../src/agent/path-policy.js';

/**
 * Worker #20 / #780: one intentionally RED negative against the REAL
 * workspace.snapshot executor. Unlike #786 (Git-discovered root outside
 * scope), the Git root here IS within scope. Git's core.fsmonitor command
 * must not execute with ambient privileges from this read-only capability.
 * All Git state, executable helper and outside-scope canary are disposable
 * TEMP fixtures. No user repository, Agent, service, ACL, UAC or VM.
 */
test('workspace.snapshot must not execute a repository-controlled Git fsmonitor command', {
  timeout: 45_000,
}, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-w20-git-hook-'));
  t.after(async () => {
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const allowed = path.join(temp, 'task-approved-repository');
  const outside = path.join(temp, 'outside-task-root');
  const canary = path.join(outside, 'fsmonitor-executed.txt');
  const helper = path.join(allowed, 'fsmonitor.cjs');
  await Promise.all([
    fs.mkdir(allowed, { recursive: true }),
    fs.mkdir(outside, { recursive: true }),
  ]);

  // No actual hook from any user repository and no network operations.
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(temp, 'absent-global-git-config'),
    GIT_TERMINAL_PROMPT: '0',
  };
  const git = (args: string[]) => {
    const result = spawnSync('git', ['-C', allowed, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 128 * 1024,
      env: gitEnv,
    });
    assert.equal(result.error, undefined, 'disposable Git executable required');
    assert.equal(result.status, 0,
      'disposable Git setup failed: ' + (result.stderr ?? '').slice(0, 900));
    return (result.stdout ?? '').trim();
  };

  git(['init', '--quiet']);
  git(['-c', 'user.name=Worker20 Temp QA',
    '-c', 'user.email=w20-temp@example.invalid',
    'commit', '--allow-empty', '--quiet', '-m', 'disposable base']);

  // core.fsmonitor is a Git status subprocess, not a conventional
  // pre-commit hook. A blanket "disable commit hooks" flag is insufficient.
  // Use Node as the fixture helper so no platform shell syntax is needed in
  // the script body. Git invokes the configured command via its own runner.
  await fs.writeFile(helper,
    "const fs = require('node:fs');\n" +
    "fs.writeFileSync(process.argv[2], 'GIT_FSMONITOR_EXECUTED');\n" +
    "process.stdout.write('\\n');\n",
    'utf8');
  const quoted = (value: string) =>
    '"' + value.replaceAll('\\', '/').replaceAll('"', '\\"') + '"';
  git(['config', 'core.fsmonitor',
    [process.execPath, helper, canary].map(quoted).join(' ')]);

  // The controlled fixture MUST demonstrate that ordinary Git status can
  // execute the helper. Without this witness a green result is meaningless.
  git(['status', '--short', '--branch']);
  assert.equal(await fs.readFile(canary, 'utf8'), 'GIT_FSMONITOR_EXECUTED');
  await fs.unlink(canary);

  const policy = new PathPolicy([allowed]);
  assert.equal(await policy.resolveExisting(allowed), await fs.realpath(allowed));
  const result = await executeCapability('workspace.snapshot', { path: allowed }, policy)
    .then((value) => ({ ok: true as const, value }))
    .catch((error: unknown) => ({ ok: false as const, error }));

  // Safe behavior: either deny the unsafe Git configuration before execution
  // or return a snapshot after disabling all repository-controlled hooks.
  // Current production source runs unfiltered 'git status' and FAILS here.
  const outsideWasModified = await fs.readFile(canary, 'utf8')
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
  assert.equal(outsideWasModified, false,
    'REAL workspace.snapshot launched core.fsmonitor and wrote beyond its approved PathPolicy root');

  if (result.ok) {
    const data = (result.value as { data?: { root?: string } }).data;
    assert.ok(data && typeof data.root === 'string',
      'a successful read-only result must still contain actual Git snapshot data');
    assert.equal(path.resolve(data.root), path.resolve(allowed));
  }
});
