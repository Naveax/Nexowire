import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  isolatedHubLifecycleTaskEnv,inspectLegacyStackHubSupervisor,
} from '../src/hub/hub-lifecycle.js';

const input={
  NEXOWIRE_HUB_TASK_NAME:'Nexowire Hub',
  NEXOWIRE_HUB_LAUNCHER:'C:\\Users\\test\\.nexowire\\hub-service\\launch.ps1',
  NEXOWIRE_HUB_PREFLIGHT_PORT:'43110',
  NEXOWIRE_HUB_RESTART_REQUIRED:'0',
  PATH:'C:\\Users\\test\\download\\spoof',
  PSModulePath:'C:\\Users\\test\\modules\\spoof',
  NODE_OPTIONS:'--require C:\\Users\\test\\inject.js',
  APPDATA:'C:\\Users\\test\\AppData\\Roaming',
  TEMP:'C:\\Users\\test\\Temp',
  GH_HOST:'attack.invalid',
};
test('user Hub task shell passes only trusted Windows system paths and task-specific inputs',()=>{
  const env=isolatedHubLifecycleTaskEnv(input);
  assert.deepEqual(Object.keys(env).sort(),[
    'SystemRoot','windir','ComSpec','PATH','PSModulePath',
    'NEXOWIRE_HUB_TASK_NAME','NEXOWIRE_HUB_LAUNCHER',
    'NEXOWIRE_HUB_PREFLIGHT_PORT','NEXOWIRE_HUB_RESTART_REQUIRED',
  ].sort());
  assert.equal(env.PATH,'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0');
  assert.equal(env.PSModulePath,'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
  for(const key of [
    'NODE_OPTIONS','NODE_PATH','APPDATA','TEMP','USERPROFILE',
    'GH_HOST','GH_CONFIG_DIR','PSExecutionPolicyPreference',
  ])assert.equal(env[key],undefined,key);
  for(const key of [
    'NEXOWIRE_HUB_TASK_NAME','NEXOWIRE_HUB_LAUNCHER',
    'NEXOWIRE_HUB_PREFLIGHT_PORT','NEXOWIRE_HUB_RESTART_REQUIRED',
  ])assert.equal(env[key],input[key as keyof typeof input],key);
});
test('refuse empty and oversized caller-selected lifecycle task fields',()=>{
  for(const key of ['NEXOWIRE_HUB_TASK_NAME','NEXOWIRE_HUB_LAUNCHER'] as const){
    assert.throws(()=>isolatedHubLifecycleTaskEnv({...input,[key]:''}),/HUB_TASK_ENV_INVALID/);
    assert.throws(()=>isolatedHubLifecycleTaskEnv({...input,[key]:'x'.repeat(4097)}),/HUB_TASK_ENV_INVALID/);
  }
});
test('powershell spawn, task action and inbox modules are pinned to system paths',()=>{
  const source=readFileSync(new URL('../src/hub/hub-lifecycle.ts',import.meta.url),'utf8');
  assert.match(source,/HUB_POWERSHELL = HUB_SYSTEM32 \+ '\\\\WindowsPowerShell\\\\v1\.0\\\\powershell\.exe'/);
  assert.match(source,/spawn\(\s*HUB_POWERSHELL,/);
  assert.match(source,/cwd:HUB_SYSTEM32/);
  assert.match(source,/shell:false/);
  assert.match(source,/env: isolatedHubLifecycleTaskEnv\(env\)/);
  assert.ok(source.includes("ScheduledTasks\\ScheduledTasks.psd1"));
  assert.ok(source.includes("NetTCPIP\\NetTCPIP.psd1"));
  assert.match(source,/New-ScheduledTaskAction -Execute 'C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1\.0\\\\powershell\.exe'/);
  assert.doesNotMatch(source,/spawn\(\s*['"]powershell\.exe['"]/);
  assert.doesNotMatch(source,/env:\s*\{\s*\.\.\.process\.env,\s*\.\.\.env/);
});
test('read-only supervisor preflight resists poisoned PATH and module directory',{
  skip:process.platform!=='win32',
},async()=>{
  const temporary=mkdtempSync(path.join(tmpdir(),'nx-hub-task-fake-powershell-'));
  try{
    // An invalid fake executable would break any PATH-resolved powershell.exe.
    writeFileSync(path.join(temporary,'powershell.exe'),'NOT A REAL EXE');
    const result=await inspectLegacyStackHubSupervisor({
      ...input,
      PATH:temporary+';'+(process.env.PATH||''),
      PSModulePath:temporary,
      NEXOWIRE_HTTP_PORT:'43110',
    });
    assert.equal(result.mode,'inspection-only');
    assert.equal(result.safeToCutover,false);
    assert.equal(typeof result.standaloneHubLifecycleBlocked,'boolean');
    assert.equal(typeof result.hubPort,'number');
  }finally{
    rmSync(temporary,{recursive:true,force:true});
  }
});
