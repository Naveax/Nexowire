import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeCapability } from '../src/agent/executors.js';
import { PathPolicy } from '../src/agent/path-policy.js';

/**
 * Independent worker #50 RED QA against the REAL workspace.snapshot API on
 * #811 exact HEAD 600a0286557d360681be7bd7b86da95ba57f1980.
 *
 * Git status may invoke a repository-controlled filter.<driver>.clean for
 * changed tracked files, even with core.fsmonitor=false, hooks disabled,
 * external diff disabled, global/system config disabled and sanitized GIT_*.
 *
 * Both the repository and canary are strictly disposable TEMP. The command
 * is intentionally harmless and has no access to user files or live Agent.
 * A FAILURE here is a reproduced missing source trust boundary, not a CI
 * infrastructure failure or a physical native-effect witness.
 */
test('workspace.snapshot must not execute repository Git clean filters outside task scope', {
  timeout: 45_000,
}, async (t) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-w50-git-filter-'));
  t.after(async () => {
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const allowed = path.join(temp, 'allowed-task-repo');
  const outside = path.join(temp, 'outside-task-scope');
  const canary = path.join(outside, 'git-clean-filter-executed.txt');
  const helper = path.join(allowed, 'filter.cjs');
  const tracked = path.join(allowed, 'example.txt');
  await Promise.all([
    fs.mkdir(allowed, { recursive: true }),
    fs.mkdir(outside, { recursive: true }),
  ]);

  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(temp, 'absent-global-git-config'),
    GIT_TERMINAL_PROMPT: '0',
  };
  const git = (args: string[]) => {
    const run = spawnSync('git', ['-C', allowed, ...args], {
      env, encoding: 'utf8', windowsHide: true,
      timeout: 15_000, maxBuffer: 128 * 1024,
    });
    assert.equal(run.error, undefined, 'disposable Git executable required');
    assert.equal(run.status, 0,
      'disposable Git setup failed: ' + (run.stderr ?? '').slice(0, 900));
    return (run.stdout ?? '').trim();
  };

  await fs.writeFile(helper, [
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.argv[2], 'GIT_CLEAN_FILTER_EXECUTED');",
    'process.stdin.pipe(process.stdout);',
  ].join('\n') + '\n', 'utf8');
  await fs.writeFile(path.join(allowed, '.gitattributes'),
    '*.txt filter=qa50\n', 'utf8');
  await fs.writeFile(tracked, 'abcdef012345\n', 'utf8');

  git(['init', '--quiet']);
  const quote = (value: string) =>
    '"' + value.replaceAll('\\', '/').replaceAll('"', '\\"') + '"';
  git(['config', 'filter.qa50.clean',
    [process.execPath, helper, canary].map(quote).join(' ')]);
  git(['add', '.gitattributes', 'example.txt']);
  git(['-c', 'user.name=Worker50 TEMP QA',
    '-c', 'user.email=w50-temp@example.invalid',
    'commit', '--quiet', '-m', 'disposable baseline']);

  // Same-length change makes Git hash the tracked file and run its clean
  // conversion on git status. Prove this trigger actually works first.
  await fs.writeFile(tracked, 'ABCDEF012345\n', 'utf8');
  await fs.rm(canary, { force: true });
  const status = git(['status', '--short', '--branch']);
  assert.match(status, /example\.txt/u,
    'negative fixture must exercise tracked changed file');
  assert.equal(await fs.readFile(canary, 'utf8'), 'GIT_CLEAN_FILTER_EXECUTED',
    'controlled Git witness did not execute; test cannot claim a boundary');
  await fs.unlink(canary);

  const policy = new PathPolicy([allowed]);
  assert.equal(await policy.resolveExisting(allowed), await fs.realpath(allowed));
  const outcome = await executeCapability('workspace.snapshot', { path: allowed }, policy)
    .then((value) => ({ ok: true as const, value }))
    .catch((error: unknown) => ({ ok: false as const, error }));

  const outsideWasModified = await fs.readFile(canary, 'utf8')
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
  assert.equal(outsideWasModified, false,
    'RED: workspace.snapshot ran repository-controlled Git filter.clean and wrote beyond approved PathPolicy root');

  if (outcome.ok) {
    const data = (outcome.value as { data?: { root?: string } }).data;
    assert.ok(data && typeof data.root === 'string');
    assert.equal(path.resolve(data.root), path.resolve(allowed));
  }
});
