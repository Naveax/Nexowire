import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  inspectWindowsUacStatus,
  isolatedWindowsUacEnvironment,
} from '../src/agent/windows-uac-status.js';

test('UAC observer isolates PATH/PS modules/Node hooks from subprocess',()=>{
  const env=isolatedWindowsUacEnvironment();
  assert.deepEqual(env,{
    SystemRoot:'C:\\Windows',
    windir:'C:\\Windows',
    ComSpec:'C:\\Windows\\System32\\cmd.exe',
    PATH:'C:\\Windows\\System32;C:\\Windows',
    PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
  });
  for(const key of ['NODE_OPTIONS','NODE_PATH','APPDATA','TEMP','USERPROFILE']){
    assert.equal((env as NodeJS.ProcessEnv)[key],undefined);
  }
});
test('UAC observer source pins PowerShell and CimCmdlets and bounds output',()=>{
  const src=readFileSync(new URL('../src/agent/windows-uac-status.ts',import.meta.url),'utf8');
  assert.ok(src.includes("UAC_POWERSHELL=UAC_SYSTEM32+'\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe'"));
  assert.ok(src.includes("Import-Module -Name 'C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\Modules\\\\CimCmdlets\\\\CimCmdlets.psd1'"));
  assert.ok(src.includes('spawn(UAC_POWERSHELL, ['));
  assert.ok(src.includes('env:isolatedWindowsUacEnvironment()'));
  assert.ok(src.includes('cwd:UAC_SYSTEM32'));
  assert.ok(src.includes('shell:false'));
  assert.ok(src.includes('outputBytes>64*1024'));
  assert.ok(!src.includes("spawn('powershell.exe'"));
});
test('real read-only UAC observation ignores fake executable and module search dir',{
  skip:process.platform!=='win32',
},async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'nx-uac-shell-spoof-'));
  const fake=path.join(dir,'powershell.exe');
  writeFileSync(fake,'MALICIOUS EXECUTABLE NEVER RUN');
  const prevPath=process.env.PATH;
  const prevModule=process.env.PSModulePath;
  try{
    process.env.PATH=dir+';'+(prevPath||'');
    process.env.PSModulePath=dir;
    const result=await inspectWindowsUacStatus({platform:'win32',accessMode:'safe'});
    assert.ok(['pending','clear','unknown'].includes(result.observation));
    assert.equal(result.autoClickConsentSupported,false);
    assert.equal(result.brokerElevated,false);
    assert.equal(readFileSync(fake,'utf8'),'MALICIOUS EXECUTABLE NEVER RUN');
  }finally{
    if(prevPath===undefined)delete process.env.PATH;else process.env.PATH=prevPath;
    if(prevModule===undefined)delete process.env.PSModulePath;else process.env.PSModulePath=prevModule;
    rmSync(dir,{recursive:true,force:true});
  }
});
