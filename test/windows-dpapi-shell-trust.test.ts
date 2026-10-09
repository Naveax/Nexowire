import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {
  windowsDpapiChildEnvironment,
  protectWindowsUserSecretForPurpose,
  unprotectWindowsUserSecretForPurpose,
  unprotectWindowsUserSecretForPurposeSync,
  protectWindowsMachineSecretForPurpose,
  unprotectWindowsMachineSecretForPurpose,
  unprotectWindowsMachineSecretForPurposeSync,
  WindowsDpapiError,
} from '../src/security/windows-dpapi.js';

test('DPAPI subprocess environment excludes poisoned PATH/module/preload/user hooks',()=>{
  const oldPath=process.env.PATH;
  const oldModulePath=process.env.PSModulePath;
  const oldNodeOptions=process.env.NODE_OPTIONS;
  try{
    process.env.PATH='C:\\untrusted\\attacker';
    process.env.PSModulePath='C:\\untrusted\\modules';
    process.env.NODE_OPTIONS='--require C:\\untrusted\\inject.js';
    const env=windowsDpapiChildEnvironment();
    assert.deepEqual(env,{
      SystemRoot:'C:\\Windows',
      windir:'C:\\Windows',
      ComSpec:'C:\\Windows\\System32\\cmd.exe',
      PATH:'C:\\Windows\\System32;C:\\Windows',
      PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
    });
  }finally{
    if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;
    if(oldModulePath===undefined)delete process.env.PSModulePath;else process.env.PSModulePath=oldModulePath;
    if(oldNodeOptions===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=oldNodeOptions;
  }
});
test('DPAPI secret subprocess pins system PowerShell for sync and async calls',()=>{
  const source=readFileSync(new URL('../src/security/windows-dpapi.ts',import.meta.url),'utf8');
  assert.ok(source.includes("const DPAPI_POWERSHELL = DPAPI_WINDOWS_SYSTEM32 + '\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe'"));
  assert.equal((source.match(/DPAPI_POWERSHELL,/g)||[]).length,2);
  assert.ok(source.includes("      DPAPI_POWERSHELL,"));
  assert.ok(source.includes('env:windowsDpapiChildEnvironment()'));
  assert.ok(source.includes('timeout:DPAPI_TIMEOUT_MS'));
  assert.ok(source.includes('maxBuffer:DPAPI_MAX_BYTES'));
  assert.ok(source.includes('child.kill()'));
  assert.ok(!source.includes("spawn(\n      'powershell.exe'"));
  assert.ok(!source.includes("spawnSync(\n    'powershell.exe'"));
  assert.ok(!source.includes('result.stderr.trim()'));
});
test('real DPAPI user and machine secrets survive both sync and async unseal with poisoned search paths',{
  skip:process.platform!=='win32',
},async()=>{
  const temporary=mkdtempSync(path.join(tmpdir(),'nx-dpapi-spoof-powershell-'));
  const oldPath=process.env.PATH;
  const oldModulePath=process.env.PSModulePath;
  const oldNodeOptions=process.env.NODE_OPTIONS;
  try{
    // Invalid executable shadows every PATH-discovered powershell.exe.
    writeFileSync(path.join(temporary,'powershell.exe'),'FAKE EXECUTABLE MUST NOT RUN');
    process.env.PATH=temporary+';'+(oldPath??'');
    process.env.PSModulePath=temporary;
    process.env.NODE_OPTIONS='--require '+path.join(temporary,'hook.js');
    const unique='test-p0-'+Date.now().toString(36);
    const secret='isolated synthetic DPAPI secret: '+unique;
    const ciphertext=await protectWindowsUserSecretForPurpose(secret,unique);
    assert.notEqual(ciphertext,secret);
    assert.equal(await unprotectWindowsUserSecretForPurpose(ciphertext,unique),secret);
    assert.equal(unprotectWindowsUserSecretForPurposeSync(ciphertext,unique),secret);
    await assert.rejects(()=>unprotectWindowsUserSecretForPurpose(ciphertext,unique+'-different'),
      (error:unknown)=>error instanceof WindowsDpapiError&&error.code==='WINDOWS_DPAPI_FAILED'&&!error.message.includes(secret));
    const machineCipher=await protectWindowsMachineSecretForPurpose(secret,'p0-machine-'+unique);
    assert.equal(await unprotectWindowsMachineSecretForPurpose(machineCipher,'p0-machine-'+unique),secret);
    assert.equal(unprotectWindowsMachineSecretForPurposeSync(machineCipher,'p0-machine-'+unique),secret);
    assert.equal(readFileSync(path.join(temporary,'powershell.exe'),'utf8'),'FAKE EXECUTABLE MUST NOT RUN');
  }finally{
    if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;
    if(oldModulePath===undefined)delete process.env.PSModulePath;else process.env.PSModulePath=oldModulePath;
    if(oldNodeOptions===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=oldNodeOptions;
    rmSync(temporary,{recursive:true,force:true});
  }
});
