import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  isolatedAutoUpdateTaskEnvironment,
  readAutoUpdateScheduledTask,
  renderAutoUpdateTaskInstallScript,
} from '../src/update/auto-update.js';

test('automatic updater task controller isolates PATH, PS modules and process hooks',()=>{
  const oldPath=process.env.PATH;
  const oldMod=process.env.PSModulePath;
  try{
    process.env.PATH='C:\\malicious\\tools';
    process.env.PSModulePath='C:\\malicious\\modules';
    const env=isolatedAutoUpdateTaskEnvironment();
    assert.deepEqual(env,{
      SystemRoot:'C:\\Windows',
      windir:'C:\\Windows',
      ComSpec:'C:\\Windows\\System32\\cmd.exe',
      PATH:'C:\\Windows\\System32;C:\\Windows',
      PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
    });
    assert.equal((env as NodeJS.ProcessEnv).NODE_OPTIONS,undefined);
  }finally{
    if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;
    if(oldMod===undefined)delete process.env.PSModulePath;else process.env.PSModulePath=oldMod;
  }
});
test('updater task uses fixed interpreter and pinned ScheduledTasks manifest',()=>{
  const source=readFileSync(new URL('../src/update/auto-update.ts',import.meta.url),'utf8');
  assert.ok(source.includes("AUTO_UPDATE_POWERSHELL=AUTO_UPDATE_SYSTEM32+'\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe'"));
  assert.ok(source.includes('spawn(AUTO_UPDATE_POWERSHELL, ['));
  assert.ok(source.includes("Import-Module -Name 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\ScheduledTasks\\ScheduledTasks.psd1'"));
  assert.ok(source.includes('env:isolatedAutoUpdateTaskEnvironment()'));
  assert.ok(source.includes('cwd:AUTO_UPDATE_SYSTEM32'));
  assert.ok(source.includes('shell:false'));
  assert.doesNotMatch(source,/spawn\('powershell\.exe'/);
  const script=renderAutoUpdateTaskInstallScript('C:\\Users\\test\\.nexowire\\auto-update\\launch.ps1');
  assert.ok(script.includes("New-ScheduledTaskAction -Execute 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'"));
  assert.doesNotMatch(script,/New-ScheduledTaskAction -Execute 'powershell\.exe'/);
  assert.match(script,/-RunLevel Limited/);
});
test('actual updater task status ignores spoofed executable and module dir',{
  skip:process.platform!=='win32',
},async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'nexowire-update-task-spoof-'));
  const fake=path.join(dir,'powershell.exe');
  const oldPath=process.env.PATH;
  const oldModule=process.env.PSModulePath;
  const oldNode=process.env.NODE_OPTIONS;
  writeFileSync(fake,'INVALID EXE');
  try{
    process.env.PATH=dir+';'+(oldPath??'');
    process.env.PSModulePath=dir;
    process.env.NODE_OPTIONS='--require '+path.join(dir,'fake-hook.js');
    const result=await readAutoUpdateScheduledTask();
    assert.equal(typeof result,'object');
    assert.notEqual(result,null);
    assert.equal(typeof (result as Record<string,unknown>).installed,'boolean');
    assert.equal(readFileSync(fake,'utf8'),'INVALID EXE');
  }finally{
    if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;
    if(oldModule===undefined)delete process.env.PSModulePath;else process.env.PSModulePath=oldModule;
    if(oldNode===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=oldNode;
    rmSync(dir,{recursive:true,force:true});
  }
});
