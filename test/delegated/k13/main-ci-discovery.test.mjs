import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { inspectDiscovery } from '../../../scripts/delegated/k13/inspect-main-ci-discovery.mjs';

test('explicit CI paths are distinct from npm glob uncertainty', () => {
  const ci = 'run: node --test test/delegated/a.test.mjs test/delegated/k20/*.test.mjs';
  const pkg = { scripts: { test: 'node --test test/**/*.test.ts' } };
  const items = [
    'test/delegated/a.test.mjs',
    'test/delegated/k20/b.test.mjs',
    'test/delegated/k16/c.test.ts',
    'test/delegated/k09/d.test.mjs',
  ];
  const report = inspectDiscovery(ci, pkg, items);
  assert.equal(report.explicit_ci, 2);
  assert.equal(report.npm_glob_unverified, 1);
  assert.deepEqual(report.not_referenced, ['test/delegated/k09/d.test.mjs']);
  assert.equal(report.conclusion, 'INCOMPLETE_OR_UNVERIFIED_DISCOVERY');
});

test('green source workflow text alone never asserts actual test execution', () => {
  const report = inspectDiscovery('test/delegated/a.test.mjs', { scripts: {} },
    ['test/delegated/a.test.mjs']);
  assert.equal(report.conclusion, 'SOURCE_PATHS_REFERENCED_NOT_EXECUTION_PROOF');
});
