import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';

test('hostile outer Job process budget blocks nested helper root without unmanaged fallback', {
  skip:process.platform!=='win32',timeout:22000,
},async()=>{
  // Self-contained native fixture creates an outer Job and only its own
  // suspended synthetic helper. No existing user/Agent process is signaled.
  const probe=path.resolve('test/fixtures/windows-job-hostile-nested.exe');
  await fs.access(probe);
  const result=spawnSync(probe,[],{
    cwd:process.cwd(),windowsHide:true,encoding:'utf8',
    timeout:15000,maxBuffer:8192});
  assert.equal(result.status,0,
    'fail-closed hostile nested Job probe: '+(result.stderr??'').slice(0,450));
  assert.match(result.stdout,/NX_HOSTILE_NESTED_FAIL_CLOSED/);
  assert.doesNotMatch(result.stdout,/UNEXPECTED_ROOT|FALSE_SUCCESS/);
});
