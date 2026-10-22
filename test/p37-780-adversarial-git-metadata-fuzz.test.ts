import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeCapability } from '../src/agent/executors.js';
import { PathDeniedError, PathPolicy } from '../src/agent/path-policy.js';

/**
 * W37 #780: independent adversarial QA against the real workspace API.
 * Every Git repository, outside-scope directory and metadata target is TEMP.
 * No production changes, installed Agent, Broker, UAC, VM or user repositories.
 * Source tests are NOT a native OS sandbox proof.
 */
async function fixture(t: { after: (fn: () => void | Promise<void>) => void }) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-qa37-git-'));
  t.after(async () => {
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const allowed = path.join(temp, 'approved');
  const outside = path.join(temp, 'outside');
  await Promise.all([fs.mkdir(allowed), fs.mkdir(outside)]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:GIT_|GCM_|LD_|DYLD_|SSH_ASKPASS$|BASH_ENV$)/iu.test(key)));
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = path.join(temp, 'absent-global');
  env.GIT_TERMINAL_PROMPT = '0';
  const git = (args: readonly string[]): string => {
    const run = spawnSync('git', [...args], {
      encoding: 'utf8', windowsHide: true, timeout: 15_000,
      maxBuffer: 128 * 1024, env,
    });
    assert.equal(run.error, undefined, 'disposable Git executable is required');
    assert.equal(run.status, 0,
      'fixture Git command failed: ' + args.join(' ') + ': ' + run.stderr);
    return (run.stdout ?? '').trim();
  };
  git(['init', '--quiet', allowed]);
  git(['-C', allowed, '-c', 'user.name=W37 TEMP QA',
    '-c', 'user.email=w37-temp@example.invalid',
    'commit', '--allow-empty', '--quiet', '-m', 'disposable baseline']);
  return { allowed, outside, git, policy: new PathPolicy([allowed]) };
}

async function denyBoth(root: string, policy: PathPolicy) {
  for (const capability of ['workspace.snapshot', 'workspace.detect'] as const) {
    await assert.rejects(
      () => executeCapability(capability, { path: root }, policy),
      (error: unknown) => error instanceof PathDeniedError ||
        (error instanceof Error &&
          /(?:DENIED|NOT_AUTHORIZED|GIT_READ_FAILED|OUTSIDE)/iu.test(error.message)),
      capability + ' must deny unauthorized Git metadata before reading it',
    );
  }
}

async function disposableDirectoryLink(
  t: { skip: (message: string) => void }, target: string, link: string,
): Promise<boolean> {
  try {
    await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error &&
      ['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(String(error.code))) {
      t.skip('runner cannot create disposable symlinks/reparse points');
      return false;
    }
    throw error;
  }
}

test('W37 nested refs/heads link outside task root must fail closed',
  { timeout: 45_000 }, async t => {
    const { allowed, outside, git, policy } = await fixture(t);
    const refs = path.join(allowed, '.git', 'refs', 'heads');
    const external = path.join(outside, 'heads');
    await fs.rename(refs, external);
    if (!await disposableDirectoryLink(t, external, refs)) return;
    assert.equal(git(['-C', allowed, 'rev-parse', '--verify', 'HEAD']).length, 40);
    assert.match(git(['-C', allowed, 'status', '--short', '--branch']), /^## /);
    // Top-level .git and refs are authorized; the nested heads link is not.
    // This is distinct from #786's unauthorized discovered worktree root.
    await denyBoth(allowed, policy);
  });

test('W37 nested loose Git object directory outside task root must fail closed',
  { timeout: 45_000 }, async t => {
    const { allowed, outside, git, policy } = await fixture(t);
    const commit = git(['-C', allowed, 'rev-parse', 'HEAD']);
    const objects = path.join(allowed, '.git', 'objects', commit.slice(0, 2));
    const external = path.join(outside, 'commit-objects');
    await fs.rename(objects, external);
    if (!await disposableDirectoryLink(t, external, objects)) return;
    assert.equal(git(['-C', allowed, 'log', '-1', '--format=%H']), commit,
      'fixture must actually read an object from the external store');
    await denyBoth(allowed, policy);
  });

test('W37 Git-linked worktree root in scope but external gitdir/commondir must deny',
  { timeout: 45_000 }, async t => {
    const { allowed, outside, git, policy } = await fixture(t);
    const seed = path.join(outside, 'seed');
    git(['init', '--quiet', seed]);
    git(['-C', seed, '-c', 'user.name=W37 TEMP QA',
      '-c', 'user.email=w37-temp@example.invalid',
      'commit', '--allow-empty', '--quiet', '-m', 'external seed']);
    const linked = path.join(allowed, 'linked');
    git(['-C', seed, 'worktree', 'add', '--detach', '--quiet', linked]);
    assert.equal(path.resolve(git(['-C', linked, 'rev-parse', '--show-toplevel'])),
      path.resolve(linked));
    assert.match(await fs.readFile(path.join(linked, '.git'), 'utf8'), /^gitdir:/iu);
    await denyBoth(linked, policy);
  });

test('W37 includeIf.onbranch loads out-of-scope config in ordinary Git but executor denies',
  { timeout: 45_000 }, async t => {
    const { allowed, outside, git, policy } = await fixture(t);
    const branch = git(['-C', allowed, 'symbolic-ref', '--short', 'HEAD']);
    const config = path.join(outside, 'included.conf');
    await fs.writeFile(config, '[qa37]\nprobe = out-of-scope-config\n', 'utf8');
    git(['-C', allowed, 'config', '--local',
      'includeIf.onbranch:' + branch + '.path', config]);
    assert.equal(git(['-C', allowed, 'config', '--includes', '--get', 'qa37.probe']),
      'out-of-scope-config', 'includeIf witness must be active');
    await denyBoth(allowed, policy);
  });

test('W37 core.worktree may redirect ordinary Git root but executor must deny',
  { timeout: 45_000 }, async t => {
    const { allowed, outside, git, policy } = await fixture(t);
    git(['-C', allowed, 'config', '--local', 'core.worktree', outside]);
    assert.equal(path.resolve(git(['-C', allowed, 'rev-parse', '--show-toplevel'])),
      path.resolve(outside), 'redirection witness required');
    await denyBoth(allowed, policy);
  });

test('W37 inherited GIT_WORK_TREE/GIT_CONFIG_COUNT overrides cannot poison either API',
  { timeout: 45_000 }, async t => {
    const { allowed, outside, policy } = await fixture(t);
    const names = ['GIT_WORK_TREE', 'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'] as const;
    const previous = names.map(name => process.env[name]);
    t.after(() => names.forEach((name, i) => {
      if (previous[i] === undefined) delete process.env[name];
      else process.env[name] = previous[i];
    }));
    process.env.GIT_WORK_TREE = outside;
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = 'core.worktree';
    process.env.GIT_CONFIG_VALUE_0 = outside;
    const snapshot = (await executeCapability('workspace.snapshot', { path: allowed }, policy))
      as { data: { root: string } };
    const detect = (await executeCapability('workspace.detect', { path: allowed }, policy))
      as { data: { root: string } };
    assert.equal(path.resolve(snapshot.data.root), path.resolve(allowed));
    assert.equal(path.resolve(detect.data.root), path.resolve(allowed));
  });

test('W37 objects/info/alternates pointing outside scope must deny',
  { timeout: 45_000 }, async t => {
    const { allowed, outside, policy } = await fixture(t);
    await fs.writeFile(path.join(allowed, '.git', 'objects', 'info', 'alternates'),
      path.join(outside, 'object-pool') + '\n');
    await denyBoth(allowed, policy);
  });
