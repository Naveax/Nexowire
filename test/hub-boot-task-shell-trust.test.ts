import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {protectedHubTaskShellEnvironment} from '../src/hub/hub-boot-lifecycle.js';

const input={
  NEXOWIRE_HUB_BOOT_TASK_NAME:'Nexowire Hub Boot',
  NEXOWIRE_HUB_TASK_NAME:'Nexowire Hub',
  NEXOWIRE_HUB_BOOT_LAUNCHER:'C:\\ProgramData\\Nexowire\\hub-boot\\launch.ps1',
  PATH:'C:\\Users\\other\\Downloads\\malicious',
  PSModulePath:'C:\\Users\\other\\Downloads\\modules',
  NODE_OPTIONS:'--require C:\\Users\\other\\Downloads\\hook.js',
  APPDATA:'C:\\Users\\other\\AppData\\Roaming',
  TEMP:'C:\\Users\\other\\AppData\\Local\\Temp',
};

test('Hub Boot Scheduled Task PowerShell uses allowlisted fixed system environment',()=>{
  const result=protectedHubTaskShellEnvironment(input);
  assert.deepEqual(Object.keys(result).sort(),[
    'SystemRoot','windir','ComSpec','PATH','PSModulePath',
    'NEXOWIRE_HUB_BOOT_TASK_NAME','NEXOWIRE_HUB_TASK_NAME','NEXOWIRE_HUB_BOOT_LAUNCHER',
  ].sort());
  assert.equal(result.SystemRoot,'C:\\Windows');
  assert.equal(result.ComSpec,'C:\\Windows\\System32\\cmd.exe');
  assert.equal(result.PATH,'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0');
  assert.equal(result.PSModulePath,'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
  assert.equal(result.NEXOWIRE_HUB_BOOT_LAUNCHER,input.NEXOWIRE_HUB_BOOT_LAUNCHER);
  for(const key of [
    'NODE_OPTIONS','NODE_PATH','NODE_EXTRA_CA_CERTS','TEMP','TMP','APPDATA',
    'LOCALAPPDATA','USERPROFILE','HOME','PSModuleAnalysisCachePath',
    'PSExecutionPolicyPreference','POWERSHELL_UPDATECHECK',
  ])assert.equal(result[key],undefined,key);
});

test('Hub Boot task shell refuses missing or oversized required inputs',()=>{
  assert.throws(()=>protectedHubTaskShellEnvironment({
    NEXOWIRE_HUB_BOOT_TASK_NAME:'Nexowire Hub Boot',
  }),/HUB_BOOT_TASK_ENV_INVALID/);
  assert.throws(()=>protectedHubTaskShellEnvironment({
    ...input,NEXOWIRE_HUB_TASK_NAME:'x'.repeat(4097),
  }),/HUB_BOOT_TASK_ENV_INVALID/);
});

test('Hub Boot calls absolute PowerShell and registers exact system executable path',()=>{
  const source=readFileSync(new URL('../src/hub/hub-boot-lifecycle.ts',import.meta.url),'utf8');
  assert.match(source,/TRUSTED_POWERSHELL=TRUSTED_SYSTEM32\+'\\\\WindowsPowerShell\\\\v1\.0\\\\powershell\.exe'/);
  assert.match(source,/spawn\(\s*TRUSTED_POWERSHELL,/);
  assert.match(source,/shell:false,cwd:TRUSTED_SYSTEM32/);
  assert.match(source,/env: protectedHubTaskShellEnvironment\(env\)/);
  assert.match(source,/New-ScheduledTaskAction -Execute 'C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1\.0\\\\powershell\.exe'/);
  assert.doesNotMatch(source,/spawn\(\s*['"]powershell\.exe['"]/);
  assert.doesNotMatch(source,/env:\s*\{\s*\.\.\.process\.env,\s*\.\.\.env/);
});
