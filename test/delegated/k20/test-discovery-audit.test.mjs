import assert from 'node:assert/strict';
import test from 'node:test';
import { discover } from '../../../scripts/delegated/k20/test-discovery-audit.mjs';
import { resolve } from 'node:path';

const root = process.cwd();
const paths = [resolve(root, 'test/a.test.ts'), resolve(root, 'test/delegated/k20/new.test.mjs')];

test('explicit TS-only pattern flags MJS tests; does not claim they were run', () => {
  const r = discover(root, 'node --test --import tsx test/**/*.test.ts', paths);
  assert.equal(r.status, 'POTENTIAL_GAP');
  assert.deepEqual(r.potentiallyExcluded, ['test/delegated/k20/new.test.mjs']);
  assert.match(r.note, /No test process was run/);
});

test('multiple explicit patterns cover extensions, still no execution proof', () => {
  const r = discover(root, 'node --test test/**/*.test.ts test/**/*.test.mjs', paths);
  assert.equal(r.status, 'PATTERN_COVERED_NOT_EXECUTED');
  assert.equal(r.potentiallyExcluded.length, 0);
});

test('unrecognized syntax fails closed to UNKNOWN', () => {
  const r = discover(root, 'node --test custom-runner.js', paths);
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.potentiallyExcluded.length, 2);
});
