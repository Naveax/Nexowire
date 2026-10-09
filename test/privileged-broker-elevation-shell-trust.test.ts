import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  isWindowsProcessElevated,
  brokerElevationShellEnvironment,
} from '../src/agent/privileged-broker.js';

test('Broker token elevation probe uses strictly fixed Windows OS environment',()=>{
  const env=brokerElevationShellEnvironment();
  assert.deepEqual(env,{
    SystemRoot:'C:\\Windows',
    windir:'C:\\Windows',
    ComSpec:'C:\\Windows\\System32\\cmd.exe',
    PATH:'C:\\Windows\\System32;C:\\Windows',
    PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
  });
  for(const key of ['NODE_OPTIONS','NODE_PATH','APPDATA','TEMP','USERPROFILE'])
    assert.equal((env as NodeJS.ProcessEnv)[key],undefined);
});
test('Broker elevation probe cannot resolve an interpreter using caller PATH',()=>{
  const source=readFileSync(new URL('../src/agent/privileged-broker.ts',import.meta.url),'utf8');
  assert.ok(source.includes("BROKER_ELEVATION_POWERSHELL=BROKER_ELEVATION_SYSTEM32+'\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe'"));
  assert.ok(source.includes('    BROKER_ELEVATION_POWERSHELL,'));
  assert.ok(source.includes('env:brokerElevationShellEnvironment()'));
  assert.ok(source.includes('cwd:BROKER_ELEVATION_SYSTEM32'));
  assert.ok(source.includes('shell:false'));
  assert.ok(source.includes('timeout:15_000'));
  assert.ok(source.includes('maxBuffer:64*1024'));
  assert.ok(!source.includes("    'powershell.exe',\n    ["));
});
test('real Windows Broker elevation decision is stable under fake interpreter and module PATH',{
  skip:process.platform!=='win32',
},()=>{
  const baseline=isWindowsProcessElevated();
  const root=mkdtempSync(path.join(tmpdir(),'nx-broker-elevation-spoof-'));
  const fake=path.join(root,'powershell.exe');
  const previous=Object.fromEntries(['PATH','PSModulePath','NODE_OPTIONS'].map(k=>[k,process.env[k]]));
  writeFileSync(fake,'INVALID EXECUTABLE');
  try{
    process.env.PATH=root+';'+(previous.PATH||'');
    process.env.PSModulePath=root;
    process.env.NODE_OPTIONS='--require '+path.join(root,'evil.js');
    assert.equal(isWindowsProcessElevated(),baseline);
    assert.equal(readFileSync(fake,'utf8'),'INVALID EXECUTABLE');
  }finally{
    for(const [key,value] of Object.entries(previous)){
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
    rmSync(root,{recursive:true,force:true});
  }
});
