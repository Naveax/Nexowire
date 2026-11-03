import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { inventory, ownerForPath } from '../../../scripts/delegated/k20/test-ownership.mjs';

test('delegated owner comes from directory, not a test name guess', () => {
  assert.equal(ownerForPath('test/delegated/k20/foo.test.mjs'), 'K20');
  assert.equal(ownerForPath('test/delegated/k19/foo.test.mjs'), 'K19');
  assert.equal(ownerForPath('test/foo.test.ts'), 'upstream/unassigned');
});

test('collisions distinguish repeated basename from actual file/path ownership', () => {
  const root = process.cwd();
  const report = inventory(root, [
    resolve(root, 'test/delegated/k20/check.test.mjs'),
    resolve(root, 'test/delegated/k19/check.test.mjs'),
    resolve(root, 'test/independent.test.ts'),
  ]);
  assert.equal(report.total, 3);
  assert.deepEqual(report.basenameCollisions, [{
    name: 'check.test.mjs',
    paths: ['test/delegated/k19/check.test.mjs', 'test/delegated/k20/check.test.mjs'],
    owners: ['K19', 'K20'],
  }]);
});

test('refuses paths outside repository', () => {
  assert.throws(() => inventory(process.cwd(), ['/etc/passwd']));
});
