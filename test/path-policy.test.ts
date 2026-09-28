import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { parseAllowedRoots, PathDeniedError, PathPolicy } from '../src/agent/path-policy.js';

test('path policy permits descendants and rejects escapes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-path-'));
  const policy = new PathPolicy([root]);
  assert.equal(policy.resolve('child.txt', root), path.join(root, 'child.txt'));
  assert.throws(() => policy.resolve(path.join(root, '..', 'escape.txt')), PathDeniedError);
});

test('star allowlist intentionally permits any resolved path', () => {
  const policy = new PathPolicy(parseAllowedRoots('*'));
  const expected = path.resolve(os.tmpdir(), 'outside.txt');
  assert.equal(policy.resolve(expected), expected);
});


test('real-path enforcement blocks symlink escapes when supported', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-root-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-outside-'));
  const outsideFile = path.join(outside, 'secret.txt');
  await fs.writeFile(outsideFile, 'outside', 'utf8');

  const link = path.join(root, 'escape');
  try {
    await fs.symlink(
      outside,
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch (error) {
    t.skip(
      'This environment does not permit symlink/junction creation: ' +
        (error instanceof Error ? error.message : String(error)),
    );
    return;
  }

  const policy = new PathPolicy([root]);
  assert.equal(policy.resolve(path.join(link, 'secret.txt')), path.join(link, 'secret.txt'));
  await assert.rejects(
    () => policy.resolveExisting(path.join(link, 'secret.txt')),
    PathDeniedError,
  );
  await assert.rejects(
    () => policy.resolveForCreate(path.join(link, 'new.txt')),
    PathDeniedError,
  );
});
