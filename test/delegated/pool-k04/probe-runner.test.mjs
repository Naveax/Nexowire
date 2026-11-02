import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probeRunner } from './probe-runner.mjs';

function fixtureRunner({ pattern = String.raw`/\.test\.(?:mjs|cjs|js|ts)$/`, spawn = true } = {}) {
  return `
    const roots = [resolve('test/delegated'), resolve('scripts/delegated/ci-watch-k13')];
    const tests = [];
    function collect(directory) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) collect(path);
        else if (entry.isFile() && ${pattern}.test(entry.name)) tests.push(path);
      }
    }
    for (const root of roots) collect(root);
    ${spawn ? `if (tests.length) spawnSync(process.execPath, ['--test', '--import', 'tsx', ...tests], { shell: false });` : ''}
  `;
}

test('T-238: supported mjs/cjs/js/ts tests are discovered recursively', () => {
  const result = probeRunner(fixtureRunner());
  assert.equal(result.ok, true);
  assert.equal(result.selected.length, 5);
  assert.deepEqual(result.missing, []);
});

test('T-238: a ts-only pattern cannot falsely PASS when mjs/cjs/js are skipped', () => {
  const result = probeRunner(fixtureRunner({ pattern: String.raw`/\.test\.ts$/` }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, [
    'nested/nested.test.mjs', 'nested/nested.test.cjs',
    'nested/nested.test.js', 'watch.test.mjs',
  ]);
});

test('T-238: accidental inclusion of spec.mjs and JSX tests is flagged', () => {
  const result = probeRunner(fixtureRunner({ pattern: String.raw`/\.(?:test|spec)\.(?:mjs|cjs|js|ts|jsx)$/` }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.unexpected, ['nested/ignored.spec.mjs', 'nested/ignored.test.jsx']);
});

test('T-238: collecting names without actually invoking the test runner is not PASS', () => {
  const result = probeRunner(fixtureRunner({ spawn: false }));
  assert.equal(result.ok, false);
  assert.equal(result.spawnCount, 0);
});

test('T-238: empty source and unexpected filesystem traversal fail visibly', () => {
  assert.throws(() => probeRunner(''), /empty/);
  assert.throws(() => probeRunner(`readdirSync(resolve('unexpected/root'));`), /Unexpected test discovery path/);
});
