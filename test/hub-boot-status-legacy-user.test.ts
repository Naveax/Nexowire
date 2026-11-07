import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {hubBootStatusIdentityInspection} from '../src/hub/hub-boot-lifecycle.js';

const powershell=String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;

test('read-only Boot status describes a legacy user task but still rejects foreign Boot tasks',{
  skip:process.platform!=='win32',
},()=>{
  const cases=[
    {label:'no Boot or user task',change:'',expected:null},
    {label:'valid user task, Boot absent',change:"$userTask.Actions[0].Execute=$exe",expected:null},
    {label:'first-party legacy user task, Boot absent',change:"$userTask.Actions[0].Execute='powershell.exe'",expected:null},
    {label:'first-party legacy user task with installed Boot',change:"$userTask.Actions[0].Execute='powershell.exe'; $bootTask=$validBootTask",expected:null},
    {label:'relative impostor user task',change:"$userTask.Actions[0].Execute='.\\powershell.exe'",expected:'HUB_USER_TASK_IDENTITY_MISMATCH'},
    {label:'legacy user task with foreign description',change:"$userTask.Actions[0].Execute='powershell.exe';$userTask.Description='not Nexowire'",expected:'HUB_USER_TASK_IDENTITY_MISMATCH'},
    {label:'foreign installed Boot must still fail',change:"$bootTask=$validBootTask; $bootTask.Actions[0].Execute='C:\\Other\\powershell.exe'",expected:'THROW'},
  ] as const;
  for(const item of cases){
    const lines=[
      "$ErrorActionPreference='Stop'",
      "$boot='Nexowire Hub Boot'",
      "$user='Nexowire Hub'",
      "$env:NEXOWIRE_HUB_BOOT_LAUNCHER='C:\\ProgramData\\Nexowire\\hub-boot\\launch.ps1'",
      "$env:NEXOWIRE_HUB_USER_LAUNCHER='C:\\Users\\test\\.nexowire\\hub-service\\launch.ps1'",
      "$exe='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
      "$bootArgs='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"' + $env:NEXOWIRE_HUB_BOOT_LAUNCHER + '\"'",
      "$userArgs='-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"' + $env:NEXOWIRE_HUB_USER_LAUNCHER + '\"'",
      "$localUser=[Security.Principal.WindowsIdentity]::GetCurrent().Name",
      "$validBootTask=[pscustomobject]@{TaskPath='\\';TaskName=$boot;Actions=@([pscustomobject]@{Execute=$exe;Arguments=$bootArgs});Principal=[pscustomobject]@{UserId='NT AUTHORITY\\SYSTEM';LogonType='ServiceAccount';RunLevel='Highest'}}",
      "$bootTask=$null",
      "$userTask=[pscustomobject]@{TaskPath='\\';TaskName=$user;Description='Nexowire first-party Hub';Actions=@([pscustomobject]@{Execute=$exe;Arguments=$userArgs});Principal=[pscustomobject]@{UserId=$localUser;LogonType='Interactive';RunLevel='Limited'}}",
      item.label==='no Boot or user task'?'$userTask=$null':item.change,
      hubBootStatusIdentityInspection,
      '[pscustomobject]@{identityError=$userTaskIdentityError}|ConvertTo-Json -Compress',
    ];
    const run=spawnSync(powershell,[
      '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(lines.join('\n'),'utf16le').toString('base64'),
    ],{encoding:'utf8',windowsHide:true,timeout:15000});
    if(item.expected==='THROW'){
      assert.notEqual(run.status,0,item.label);
      assert.match(run.stdout+run.stderr,/HUB_(BOOT|USER)_TASK_IDENTITY_MISMATCH/,item.label);
    }else{
      assert.equal(run.status,0,item.label+': '+(run.stderr||run.stdout).slice(0,500));
      assert.equal(JSON.parse(run.stdout).identityError,item.expected,item.label);
    }
  }
});
