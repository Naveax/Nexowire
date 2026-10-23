import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeCapability } from '../src/agent/executors.js';
import { PathPolicy } from '../src/agent/path-policy.js';

/**
 * W50 independent second-round negative against the existing
 * executeCapability('workspace.snapshot') API on #811 exact
 * 600a0286557d360681be7bd7b86da95ba57f1980.
 *
 * Distinct from original #821 filter.<driver>.clean regression and #37
 * Git metadata link/config QA: Git status starts filter.<driver>.process
 * for modified tracked content before validating the filter handshake.
 * This fixture intentionally exits immediately after a harmless TEMP
 * canary write. An unsuccessful Git read is NOT sufficient: the executor
 * must prevent the external command from running in the first place.
 *
 * All fixture files and the marker remain inside a disposable TEMP
 * directory. No installed Agent, privileged process, network, VM, UAC,
 * Broker, user repository or existing #821/#786/#800 QA file is touched.
 */
test('workspace.snapshot must not launch repository Git process filters beyond task root', {
  timeout: 45_000,
}, async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-w50-process-'));
  t.after(async () => fs.rm(tmp, {
    recursive: true, force: true, maxRetries: 5, retryDelay: 100,
  }));

  const allowed = path.join(tmp, 'approved-git-repo');
  const outside = path.join(tmp, 'outside-task-root');
  const canary = path.join(outside, 'process-filter-executed.txt');
  const helper = path.join(allowed, 'process-filter.cjs');
  const tracked = path.join(allowed, 'tracked.txt');
  await Promise.all([
    fs.mkdir(allowed, { recursive: true }),
    fs.mkdir(outside, { recursive: true }),
  ]);
  const gitEnv: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!/^(?:GIT_|GCM_|LD_|DYLD_|SSH_ASKPASS$|BASH_ENV$|ENV$)/iu.test(name)) {
      gitEnv[name] = value;
    }
  }
  gitEnv.GIT_CONFIG_NOSYSTEM = '1';
  gitEnv.GIT_CONFIG_GLOBAL = path.join(tmp, 'absent-global-config');
  gitEnv.GIT_TERMINAL_PROMPT = '0';

  const git = (args: string[], requireSuccess = true) => {
    const run = spawnSync('git', ['-C', allowed, ...args], {
      encoding: 'utf8', windowsHide: true, timeout: 15_000,
      maxBuffer: 128 * 1024, env: gitEnv,
    });
    assert.equal(run.error, undefined, 'disposable Git executable required');
    assert.notEqual(run.status, null, 'disposable Git operation timed out');
    if (requireSuccess) {
      assert.equal(run.status, 0,
        'disposable Git setup failed: ' + (run.stderr ?? '').slice(0, 700));
    }
    return run;
  };

  await fs.writeFile(path.join(allowed, '.gitattributes'),
    '*.txt filter=qa50-process\n', 'utf8');
  await fs.writeFile(tracked, 'aaaaaaaaaaaa\n', 'utf8');
  git(['init', '--quiet']);
  // Commit BEFORE registering the process filter. Git add need not execute
  // any repository-controlled code for the fixture's baseline.
  git(['add', '.gitattributes', 'tracked.txt']);
  git(['-c', 'user.name=Worker50 TEMP QA',
    '-c', 'user.email=w50@example.invalid',
    'commit', '--quiet', '-m', 'disposable baseline']);

  await fs.writeFile(helper, [
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.argv[2], 'PROCESS_FILTER_EXECUTED');",
    // The helper intentionally fails before pkt-line negotiation. An invalid
    // filter must not get to execute merely because snapshot ultimately fails.
    'process.exit(1);',
  ].join('\n') + '\n', 'utf8');
  const quote = (s: string) =>
    '"' + s.replaceAll('\\', '/').replaceAll('"', '\\"') + '"';
  git(['config', 'filter.qa50-process.process',
    [process.execPath, helper, canary].map(quote).join(' ')]);
  await fs.writeFile(tracked, 'bbbbbbbbbbbb\n', 'utf8');

  // Prove actual ordinary Git status launches this specific process command.
  // The malformed filter handshake may cause Git to exit nonzero; this does
  // not undo the already-executed helper's out-of-scope write.
  git(['status', '--short', '--branch'], false);
  assert.equal(await fs.readFile(canary, 'utf8'), 'PROCESS_FILTER_EXECUTED',
    'filter.process witness did not run; test cannot establish a boundary');
  await fs.unlink(canary);

  const policy = new PathPolicy([allowed]);
  assert.equal(await policy.resolveExisting(allowed), await fs.realpath(allowed));
  const outcome = await executeCapability('workspace.snapshot', {
    path: allowed,
  }, policy).then((value) => ({ ok: true as const, value }))
    .catch((error: unknown) => ({ ok: false as const, error }));

  const escaped = await fs.readFile(canary, 'utf8')
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
  assert.equal(escaped, false,
    'RED: real workspace.snapshot executed Git filter.process outside approved PathPolicy root');

  if (outcome.ok) {
    const data = (outcome.value as { data?: { root?: string } }).data;
    assert.equal(path.resolve(data?.root ?? ''), path.resolve(allowed));
  }
});
