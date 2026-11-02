import assert from 'node:assert/strict';
import test from 'node:test';
import { evidence } from '../../../scripts/delegated/k20/pr-evidence.mjs';

test('empty evidence never asserts PASS or CI success', () => {
  const output = evidence();
  assert.match(output, /NOT_RUN/);
  assert.doesNotMatch(output, /\| PASS \|/);
  assert.match(output, /HEAD: `NOT_RECORDED`/);
});

test('preserves exact SHA, failure and blocked evidence with Markdown escaping', () => {
  const output = evidence({ branch: 'k20/test', sha: 'a'.repeat(40), base: 'b'.repeat(40),
    scope: 'Safe | QA', tests: [
      { name: 'static', status: 'PASS', details: '4/4' },
      { name: 'live', status: 'BLOCKED', details: 'requires owner | credentials' },
      { name: 'build', status: 'FAIL', details: 'exit 2' },
    ] });
  assert.match(output, /Safe \\\| QA/);
  assert.match(output, /\| live \| BLOCKED \| requires owner \\\| credentials/);
  assert.match(output, /HEAD: `a{40}`/);
  assert.match(output, /\| build \| FAIL \| exit 2/);
});

test('rejects unsupported status and abbreviated SHA', () => {
  assert.throws(() => evidence({ sha: '123abc' }));
  assert.throws(() => evidence({ tests: [{ name: 'ci', status: 'GREEN' }] }));
});
