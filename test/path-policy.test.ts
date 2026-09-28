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
