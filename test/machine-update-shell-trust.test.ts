import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  isolatedMachineUpdateChildEnvironment,
  renderMachineCutoverScript,
} from '../src/update/machine-update.js';

test('machine update CLI subprocess environment never inherits executable/module hooks',()=>{
  const old=Object.fromEntries(['PATH','PSModulePath','NODE_OPTIONS','NODE_PATH','ProgramData'].map(k=>[k,process.env[k]]));
  try{
    process.env.PATH='C:\\Untrusted\\bin';
    process.env.PSModulePath='C:\\Untrusted\\Modules';
    process.env.NODE_OPTIONS='--require C:\\Untrusted\\hook.js';
    process.env.ProgramData='C:\\Untrusted\\Arbitrary';
    const env=isolatedMachineUpdateChildEnvironment();
    assert.deepEqual(env,{
      SystemRoot:'C:\\Windows',
      windir:'C:\\Windows',
      ComSpec:'C:\\Windows\\System32\\cmd.exe',
      PATH:'C:\\Windows\\System32;C:\\Windows',
      PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
    });
  }finally{
    for(const [k,v] of Object.entries(old)){
      if(v===undefined)delete process.env[k];else process.env[k]=v;
    }
  }
});
test('high-integrity updater shell, ACL tool and detached cutover launch are pinned',()=>{
  const source=readFileSync(new URL('../src/update/machine-update.ts',import.meta.url),'utf8');
  assert.ok(source.includes("UPDATE_POWERSHELL=UPDATE_SYSTEM32+'\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe'"));
  assert.ok(source.includes("UPDATE_ICACLS=UPDATE_SYSTEM32+'\\\\icacls.exe'"));
  assert.ok(source.includes('spawnSync(\n    UPDATE_ICACLS,'));
  assert.ok(source.includes('spawnSync(\n    UPDATE_POWERSHELL,'));
  assert.ok(source.includes('const child = spawn(\n    UPDATE_POWERSHELL,'));
  assert.ok((source.match(/env:isolatedMachineUpdateChildEnvironment\(\)/g)||[]).length===3);
  assert.ok((source.match(/cwd:UPDATE_SYSTEM32/g)||[]).length===3);
  assert.ok((source.match(/shell:false/g)||[]).length===3);
  assert.ok((source.match(/timeout:180_000/g)||[]).length===2);
  assert.ok((source.match(/maxBuffer:2\*1024\*1024/g)||[]).length===2);
  assert.doesNotMatch(source,/spawnSync\(\s*'icacls.exe'/);
  assert.doesNotMatch(source,/spawnSync\(\s*'powershell.exe'/);
  assert.doesNotMatch(source,/spawn\(\s*'powershell.exe'/);
  assert.match(renderMachineCutoverScript({
    version:'1.0.5',buildId:'1.0.5-012345abcdef',
    targetRoot:'C:\\ProgramData\\Nexowire\\versions\\1.0.5-012345abcdef',
  }),/rolled_back/);
});
test('actual trusted Windows shell remains callable when PATH starts with a fake interpreter',{
  skip:process.platform!=='win32',
},()=>{
  const root=mkdtempSync(path.join(tmpdir(),'nx-machine-updater-shell-spoof-'));
  const fake=path.join(root,'powershell.exe');
  writeFileSync(fake,'ATTACKER FILE NOT EXECUTED');
  const oldPath=process.env.PATH;
  const oldModule=process.env.PSModulePath;
  try{
    process.env.PATH=root+';'+(oldPath||'');
    process.env.PSModulePath=root;
    const result=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoLogo','-NoProfile','-NonInteractive','-Command','[Console]::WriteLine(7)'],{
        cwd:'C:\\Windows\\System32',shell:false,
        env:isolatedMachineUpdateChildEnvironment(),
        encoding:'utf8',timeout:180_000,maxBuffer:2*1024*1024,
      });
    assert.equal(result.status,0,result.stderr);
    assert.equal(result.stdout.trim(),'7');
    assert.equal(readFileSync(fake,'utf8'),'ATTACKER FILE NOT EXECUTED');
  }finally{
    if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;
    if(oldModule===undefined)delete process.env.PSModulePath;else process.env.PSModulePath=oldModule;
    rmSync(root,{recursive:true,force:true});
  }
});
