import assert from 'node:assert/strict';
import test from 'node:test';
import { checkScriptDefinitions, classify, executeStage } from '../../../scripts/delegated/k20/command-status.mjs';

test('typecheck, build and test are independent named stages', () => {
  const stages = checkScriptDefinitions({ scripts: { typecheck: 'tsc --noEmit', build: 'tsc', test: 'node --test' } });
  assert.deepEqual(stages.map(x => x.defined), [true, true, true]);
  assert.deepEqual(stages.map(x => x.command), ['npm run typecheck', 'npm run build', 'npm run test']);
  assert.deepEqual(checkScriptDefinitions({ scripts: { build: 'tsc' } }).map(x => x.defined), [false, true, false]);
});

test('failure status is never normalized to PASS', () => {
  assert.equal(classify({ status: 0 }), 'PASS');
  assert.equal(classify({ status: 2 }), 'FAIL');
  assert.equal(classify({ status: null, error: { code: 'ENOENT' } }), 'NOT_RUN');
  assert.equal(classify({ status: null, error: { code: 'ETIMEDOUT' } }), 'TIMEOUT');
  assert.equal(classify({ status: null, signal: 'SIGKILL' }), 'NOT_RUN');
});

test('unavailable child spawning is NOT_RUN, while a nonzero status is FAIL', () => {
  // Sandboxed environments may reject child-process spawning with EPERM.
  const stage = { name: 'negative', script: '__k20_nonexistent_script__' };
  const result = executeStage(stage, process.cwd(), 5_000);
  assert.ok(['FAIL', 'NOT_RUN'].includes(result.status));
  if (result.errorCode) assert.equal(result.status, 'NOT_RUN');
  else assert.notEqual(result.exitCode, 0);
});
