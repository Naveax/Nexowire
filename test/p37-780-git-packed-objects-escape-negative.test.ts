import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeCapability } from '../src/agent/executors.js';
import { PathDeniedError, PathPolicy } from '../src/agent/path-policy.js';

/**
 * W37 second-round, independent of the existing loose-object fanout test.
 * A packed Git object store can live outside the PathPolicy root via a
 * descendant .git/objects/pack symlink/junction. All fixtures are TEMP only.
 * No filter.clean, hooks, user repository, Agent, Broker, UAC or VM.
 */
test('W37 packed Git object directory escape must fail closed for snapshot and detect',
  { timeout: 45_000 }, async (t) => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-w37-pack-'));
    t.after(async () => {
      await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const root = path.join(temp, 'approved');
    const outside = path.join(temp, 'outside');
    await Promise.all([fs.mkdir(root), fs.mkdir(outside)]);
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !/^(?:GIT_|GCM_|LD_|DYLD_|SSH_ASKPASS$|BASH_ENV$)/iu.test(name)));
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = path.join(temp, 'absent-global-config');
    env.GIT_TERMINAL_PROMPT = '0';

    const git = (args: readonly string[]) => {
      const out = spawnSync('git', [...args], {
        encoding: 'utf8', windowsHide: true, timeout: 15_000,
        maxBuffer: 128 * 1024, env,
      });
      assert.equal(out.error, undefined, 'disposable Git executable required');
      assert.equal(out.status, 0,
        'disposable Git fixture failed: ' + args.join(' ') + ': ' + out.stderr);
      return (out.stdout ?? '').trim();
    };
    git(['init', '--quiet', root]);
    git(['-C', root, '-c', 'user.name=W37 QA TEMP',
      '-c', 'user.email=w37-pack@example.invalid',
      'commit', '--allow-empty', '--quiet', '-m', 'disposable pack witness']);
    const commit = git(['-C', root, 'rev-parse', 'HEAD']);
    git(['-C', root, 'repack', '-adq']);

    const pack = path.join(root, '.git', 'objects', 'pack');
    const entries = await fs.readdir(pack);
    assert.ok(entries.some((entry) => entry.endsWith('.pack')),
      'fixture must have a real packed Git object');
    const external = path.join(outside, 'object-packs');
    await fs.rename(pack, external);
    try {
      await fs.symlink(external, pack, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error &&
        ['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(String(error.code))) {
        t.skip('runner cannot create disposable symlinks/reparse points');
        return;
      }
      throw error;
    }

    // Evidence of actual Git reading the packed object store beyond scope.
    assert.equal(git(['-C', root, 'cat-file', '-t', 'HEAD']), 'commit');
    assert.equal(git(['-C', root, 'log', '-1', '--format=%H']), commit);
    assert.match(git(['-C', root, 'status', '--short', '--branch']), /^## /u);

    const policy = new PathPolicy([root]);
    assert.equal(await policy.resolveExisting(root), await fs.realpath(root));
    for (const capability of ['workspace.snapshot', 'workspace.detect'] as const) {
      await assert.rejects(
        () => executeCapability(capability, { path: root }, policy),
        (error: unknown) => error instanceof PathDeniedError ||
          (error instanceof Error &&
            /(?:DENIED|NOT_AUTHORIZED|GIT_READ_FAILED|OUTSIDE)/iu.test(error.message)),
        capability + ' must not read Git pack files via an outside-root junction',
      );
    }
  });
