import test from 'node:test';
import assert from 'node:assert/strict';
import {useWindowsJobForProcess} from '../../src/agent/process-launch-mode.js';

test('personal local-owner mode uses standard user process launch on Windows',()=>{
  assert.equal(useWindowsJobForProcess({NEXOWIRE_CORE_APPROVAL_MODE:'local-owner'},'win32'),false);
  assert.equal(useWindowsJobForProcess({},'win32'),true);
  assert.equal(useWindowsJobForProcess({NEXOWIRE_CORE_APPROVAL_MODE:'native'},'win32'),true);
  assert.equal(useWindowsJobForProcess({NEXOWIRE_CORE_APPROVAL_MODE:'typo'},'win32'),true);
  assert.equal(useWindowsJobForProcess({},'linux'),false);
});
