import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  WindowsDpapiError,
  windowsDpapiChildEnvironment,
  protectWindowsUserSecretForPurpose,
  unprotectWindowsUserSecretForPurpose,
} from '../src/security/windows-dpapi.js';
import { classifyFailure } from '../src/protocol/error-contract-v2.js';
import { CORE_EXECUTOR_DISPATCH_ENABLED } from '../src/security/core-broker-executor-contract.js';

const REQUEST='qa02-dpapi-crash-request-20261021';
const OPERATION='qa02-dpapi-crash-operation-20261021';

// No DPAPI subprocess is launched by this negative QA file. Existing native
// Windows tests are run unmodified in a separately isolated hosted CI job.
test('QA02 #683 DPAPI timeout is observed failure, not UAC consent, broker high token, or verified effect',()=>{
  const child=new WindowsDpapiError(
    'WINDOWS_DPAPI_FAILED','Windows DPAPI child failed or timed out.',
  );
  assert.equal(child.name,'WindowsDpapiError');
  assert.equal(child.code,'WINDOWS_DPAPI_FAILED');
  assert.equal(CORE_EXECUTOR_DISPATCH_ENABLED,false);
  for(const code of ['WINDOWS_DPAPI_FAILED','UNAVAILABLE','MUTATION_STATE_UNKNOWN']){
    const result=classifyFailure({
      code,observedAt:'windows_wsl',dispatched:'unknown',readOnly:false,
      correlationId:REQUEST,operationId:OPERATION,
    });
    assert.equal(result.contractVersion,2);
    assert.equal(result.dispatchState,'unknown');
    assert.equal(result.retrySafety,'reconcile_first');
    assert.equal(result.correlationId,REQUEST);
    assert.equal(result.operationId,OPERATION);
    assert.notEqual(result.certainty,'confirmed',
      'a DPAPI timeout does not prove the ultimate provider cause');
  }
});

test('QA02 #683 failed CurrentUser secret read after possible dispatch cannot trigger blind elevated replay',()=>{
  for(const dispatched of [true,'unknown'] as const){
    const result=classifyFailure({
      code:'WINDOWS_DPAPI_FAILED',observedAt:'windows_wsl',
      dispatched,readOnly:false,correlationId:REQUEST,operationId:OPERATION,
    });
    assert.equal(result.retrySafety,'reconcile_first');
    assert.equal(result.causeLayer,'undetermined');
    assert.equal(result.certainty,'unknown');
  }
  const notSent=classifyFailure({
    code:'WINDOWS_DPAPI_FAILED',observedAt:'windows_wsl',
    dispatched:false,readOnly:false,
  });
  assert.equal(notSent.dispatchState,'not_dispatched');
  assert.equal(notSent.retrySafety,'manual_review');
});

test('QA02 #683 malformed DPAPI purpose and ciphertext fail before a Windows subprocess or any plaintext fallback',async()=>{
  // These reject during argument validation, so they run safely on all OSes.
  await assert.rejects(
    ()=>protectWindowsUserSecretForPurpose('do-not-execute','../fake-purpose'),
    (e:unknown)=>e instanceof WindowsDpapiError &&
      e.code==='WINDOWS_DPAPI_PURPOSE_INVALID',
  );
  await assert.rejects(
    ()=>unprotectWindowsUserSecretForPurpose('not-base64!','qa02-purpose'),
    (e:unknown)=>e instanceof WindowsDpapiError &&
      e.code==='WINDOWS_DPAPI_INVALID_CIPHERTEXT',
  );
});

test('QA02 #683 DPAPI child has bounded hardened invocation and no caller PATH/module hijacking',async()=>{
  const source=await fs.readFile(path.resolve('src/security/windows-dpapi.ts'),'utf8');
  assert.match(source,/DPAPI_TIMEOUT_MS\s*=\s*180_000/);
  assert.match(source,/DPAPI_MAX_BYTES\s*=\s*2\s*\*\s*1024\s*\*\s*1024/);
  assert.match(source,/child\.once\('close'/);
  assert.match(source,/code\s*!==\s*0\s*\|\|\s*signal\s*!==\s*null/);
  assert.match(source,/WindowsDpapiError\('WINDOWS_DPAPI_FAILED'/);
  const env=windowsDpapiChildEnvironment();
  assert.equal(env.SystemRoot,'C:\\Windows');
  assert.equal(env.PATH,'C:\\Windows\\System32;C:\\Windows');
  assert.equal(env.PSModulePath,'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
  assert.equal(env.NODE_OPTIONS,undefined);
});

test('QA02 #683 untrusted user profile values are not admitted as DPAPI child executable paths',()=>{
  const old=process.env.USERPROFILE;
  try {
    process.env.USERPROFILE='..\\attacker;Invoke-Expression';
    const rejected=windowsDpapiChildEnvironment();
    assert.equal(rejected.USERPROFILE,undefined);
  }finally{
    if(old===undefined)delete process.env.USERPROFILE;
    else process.env.USERPROFILE=old;
  }
});
