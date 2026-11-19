import test from 'node:test';
import assert from 'node:assert/strict';
import {useWindowsJobForProcess} from '../../src/agent/process-launch-mode.js';
import {readFileSync} from 'node:fs';

test('physical Windows Job CI forces native ownership instead of inheriting local-owner',()=>{
  const workflow=readFileSync(new URL('../../.github/workflows/ci.yml',import.meta.url),'utf8');
  const start=workflow.indexOf('      - name: Physical Windows Job Object regressions');
  assert.ok(start>=0);
  const end=workflow.indexOf('      - name:',start+10);
  const step=workflow.slice(start,end<0?undefined:end);
  assert.match(step,/NEXOWIRE_CORE_APPROVAL_MODE:\s*native/);
  assert.match(step,/process-manager-tree-cleanup\.test\.ts/);
});

test('all native Windows Job owner acceptance cases respect the production launch profile',()=>{
  const suite=readFileSync(new URL('../windows-job-owner.test.ts',import.meta.url),'utf8');
  const cases=[...suite.matchAll(/^test\('/gm)].length;
  const nativeOnly=[...suite.matchAll(/skip:nativeWindowsJobOnly/g)].length;
  assert.equal(cases,8,'new Job owner tests must be reviewed for local-owner semantics');
  assert.equal(nativeOnly,cases,'every physical Job test must use the native-only selector');
  assert.match(suite,/useWindowsJobForProcess\(\)/);
});

test('personal local-owner mode uses standard user process launch on Windows',()=>{
  assert.equal(useWindowsJobForProcess({NEXOWIRE_CORE_APPROVAL_MODE:'local-owner'},'win32'),false);
  assert.equal(useWindowsJobForProcess({},'win32'),true);
  assert.equal(useWindowsJobForProcess({NEXOWIRE_CORE_APPROVAL_MODE:'native'},'win32'),true);
  assert.equal(useWindowsJobForProcess({NEXOWIRE_CORE_APPROVAL_MODE:'typo'},'win32'),true);
  assert.equal(useWindowsJobForProcess({},'linux'),false);
});
