import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeCapability } from '../src/agent/executors.js';
import { PathDeniedError, PathPolicy } from '../src/agent/path-policy.js';

// Independent W26 #780: .git/objects/info/commit-graph FILE symlink.
// Distinct from W37 refs/heads, loose-object fanout and pack DIRECTORY links,
// and W50 clean-filter subprocesses. Disposable TEMP fixtures only.
test('W26 Git commit-graph file nested symlink outside allowed root must deny before Git log', {
  timeout: 45_000,
}, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-w26-commitgraph-'));
  t.after(async () => fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = path.join(temp, 'allowed-repository');
  const outside = path.join(temp, 'outside-root');
  await Promise.all([fs.mkdir(root), fs.mkdir(outside)]);

  const env = Object.fromEntries(Object.entries(process.env).filter(
    ([key]) => !/^(?:GIT_|GCM_|LD_|DYLD_|SSH_ASKPASS$|BASH_ENV$)/iu.test(key)));
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = path.join(temp, 'nonexistent-global-git-config');
  env.GIT_TERMINAL_PROMPT = '0';
  const rawGit = (args: string[]) => spawnSync('git', args, {
    encoding: 'utf8', env, windowsHide: true, timeout: 15_000, maxBuffer: 128 * 1024,
  });
  const git = (args: string[]) => {
    const run = rawGit(args);
    assert.equal(run.error, undefined, 'disposable Git fixture must launch');
    assert.equal(run.status, 0, 'Git fixture: ' + args.join(' ') + '\n' + (run.stderr ?? ''));
    return (run.stdout ?? '').trim();
  };

  git(['init', '--quiet', root]);
  for (let i = 0; i < 3; i++) {
    git(['-C', root, '-c', 'user.name=W26 TEMP QA',
      '-c', 'user.email=w26-temp@example.invalid',
      'commit', '--quiet', '--allow-empty', '-m', 'temporary-commit-' + i]);
  }
  git(['-C', root, 'commit-graph', 'write', '--reachable']);
  const graph = path.join(root, '.git', 'objects', 'info', 'commit-graph');
  const external = path.join(outside, 'commit-graph');
  await fs.rename(graph, external);
  try {
    await fs.symlink(external, graph, 'file');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error &&
        ['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(String(error.code))) {
      t.skip('runner cannot create disposable file symlinks');
      return;
    }
    throw error;
  }
  assert.equal((await fs.lstat(graph)).isSymbolicLink(), true);
  assert.equal(await fs.realpath(graph), await fs.realpath(external));
  const head = git(['-C', root, 'rev-parse', 'HEAD']);
  assert.equal(git(['-C', root, 'log', '-1', '--format=%H']), head);

  // Prove Git log actually parses the outside file, rather than simply
  // accepting a dangling link: corrupt and restore TEST-OWNED bytes.
  const original = await fs.readFile(external);
  try {
    await fs.writeFile(external, 'W26_INVALID_SYNTHETIC_COMMIT_GRAPH');
    const witness = rawGit(['-C', root, 'log', '-1', '--format=%H']);
    assert.match(witness.stderr ?? '', /commit.graph|graph file/iu,
      'Git log must observably read the outside commit-graph');
  } finally {
    await fs.writeFile(external, original);
  }
  assert.equal(git(['-C', root, 'log', '-1', '--format=%H']), head);

  const policy = new PathPolicy([root]);
  assert.equal(await policy.resolveExisting(root), await fs.realpath(root));
  await assert.rejects(
    () => executeCapability('workspace.snapshot', { path: root }, policy),
    (error: unknown) => error instanceof PathDeniedError ||
      (error instanceof Error &&
        /(?:GIT_METADATA_DENIED|WORKSPACE_GIT_READ_FAILED|NOT_AUTHORIZED)/iu.test(error.message)),
    'an out-of-root nested commit-graph symlink must be denied BEFORE Git subprocess reads',
  );
});
