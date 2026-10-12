import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {protectedHubTaskShellEnvironment,hubBootRegisteredTaskIdentityGuard} from '../src/hub/hub-boot-lifecycle.js';

const input={
  NEXOWIRE_HUB_BOOT_TASK_NAME:'Nexowire Hub Boot',
  NEXOWIRE_HUB_TASK_NAME:'Nexowire Hub',
  NEXOWIRE_HUB_BOOT_LAUNCHER:'C:\\ProgramData\\Nexowire\\hub-boot\\launch.ps1',
  NEXOWIRE_HUB_USER_LAUNCHER:'C:\\Users\\test\\.nexowire\\hub-service\\launch.ps1',
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
    'NEXOWIRE_HUB_USER_LAUNCHER',
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

test('isolated PowerShell guard rejects substituted SYSTEM and user Hub tasks', {
  skip:process.platform!=='win32',
},()=>{
  const exe='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const scenarios=[
    {label:'valid',change:'',accept:true},
    {label:'foreign boot path',change:"$bootTask.TaskPath='\\Foreign\\'",accept:false},
    {label:'foreign boot launcher',change:"$bootTask.Actions[0].Arguments='-File C:\\Other\\script.ps1'",accept:false},
    {label:'foreign boot owner',change:"$bootTask.Principal.UserId='BUILTIN\\Administrators'",accept:false},
    {label:'foreign user command',change:"$userTask.Actions[0].Execute='C:\\Other\\powershell.exe'",accept:false},
    {label:'foreign user owner',change:"$userTask.Principal.UserId='NT AUTHORITY\\SYSTEM'",accept:false},
  ] as const;
  for(const scenario of scenarios){
    const setup=[
      "$ErrorActionPreference='Stop'",
      "$boot='Nexowire Hub Boot'",
      "$user='Nexowire Hub'",
      "$env:NEXOWIRE_HUB_BOOT_LAUNCHER='C:\\ProgramData\\Nexowire\\hub-boot\\launch.ps1'",
      "$env:NEXOWIRE_HUB_USER_LAUNCHER='C:\\Users\\test\\.nexowire\\hub-service\\launch.ps1'",
      "$exe='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
      "$bootArgs='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"' + $env:NEXOWIRE_HUB_BOOT_LAUNCHER + '\"'",
      "$userArgs='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"' + $env:NEXOWIRE_HUB_USER_LAUNCHER + '\"'",
      "$localUser=[Security.Principal.WindowsIdentity]::GetCurrent().Name",
      "$bootTask=[pscustomobject]@{TaskPath='\\';TaskName=$boot;Actions=@([pscustomobject]@{Execute=$exe;Arguments=$bootArgs});Principal=[pscustomobject]@{UserId='NT AUTHORITY\\SYSTEM';LogonType='ServiceAccount';RunLevel='Highest'}}",
      "$userTask=[pscustomobject]@{TaskPath='\\';TaskName=$user;Actions=@([pscustomobject]@{Execute=$exe;Arguments=$userArgs});Principal=[pscustomobject]@{UserId=$localUser;LogonType='Interactive';RunLevel='Limited'}}",
      scenario.change,
      hubBootRegisteredTaskIdentityGuard,
      "'GUARD_ACCEPTED'",
    ].join('\n');
    const run=spawnSync(exe,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(setup,'utf16le').toString('base64')],{
      encoding:'utf8',windowsHide:true,timeout:15000,
    });
    assert.equal(run.status===0,scenario.accept,scenario.label+': '+(run.stderr||run.stdout).slice(0,500));
    if(scenario.accept)assert.match(run.stdout,/GUARD_ACCEPTED/);
    else assert.match(run.stderr+run.stdout,/HUB_(BOOT|USER)_TASK_IDENTITY_MISMATCH/);
  }
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
