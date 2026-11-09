import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {
  hubBootInstallTaskAbsenceGuard,
  hubBootTaskVisibilityProbe,
} from '../src/hub/hub-boot-lifecycle.js';

const win=process.platform==='win32';
const ps=String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const source=readFileSync(new URL('../src/hub/hub-boot-lifecycle.ts',import.meta.url),'utf8');

function execute(probe:string,taskExists=false):string{
  const script=[
    "$ErrorActionPreference='Stop'",
    "$boot='Nexowire Hub Boot'",
    taskExists?"$bootTask=[pscustomobject]@{ TaskName=$boot }":"$bootTask=$null",
    'try {',probe,hubBootInstallTaskAbsenceGuard,
    "  if($null -ne $bootTask){throw 'HUB_BOOT_EXISTING_TASK_INSTALL_DENIED'}",
    "  'TASK_ABSENCE_PROVED'",
    "}catch { 'TASK_MUTATION_DENIED:'+ [string]$_.Exception.Message }",
  ].join('\n');
  const child=spawnSync(ps,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
    Buffer.from(script,'utf16le').toString('base64')],{
    encoding:'utf8',windowsHide:true,timeout:15000,
  });
  assert.equal(child.status,0,child.stderr+' '+child.stdout);
  return child.stdout.trim();
}

test('SYSTEM boot install preflight, register and rollback each independently prove task absence',()=>{
  const start=source.indexOf('export async function installHubBootLifecycle(');
  const end=source.indexOf('export async function uninstallHubBootLifecycle(',start);
  assert.ok(start>=0&&end>start);
  const install=source.slice(start,end);
  const anchors=[
    'const taskPreflight = await runPowerShellJson',
    'hubBootTaskVisibilityProbe',
    'hubBootInstallTaskAbsenceGuard',
    'readProtectedSecretFile(',
    'hubBootTaskVisibilityProbe',
    'hubBootInstallTaskAbsenceGuard',
    'Register-ScheduledTask -TaskName $boot',
    'hubBootTaskVisibilityProbe',
    'hubBootInstallTaskAbsenceGuard',
    'hubBootRollbackTaskOwnershipGuard',
    'await fs.rm(p.root',
  ];
  let last=-1;
  for(const name of anchors){
    const at=install.indexOf(name,last+1);
    assert.ok(at>last,'Missing or reordered task trust check: '+name);
    last=at;
  }
  assert.match(hubBootInstallTaskAbsenceGuard,/HUB_BOOT_EXISTING_TASK_VISIBILITY_UNVERIFIED/);
  assert.match(hubBootTaskVisibilityProbe,/2147024891/);
  assert.match(hubBootTaskVisibilityProbe,/2147024894/);
});

test('hidden or unverified task never passes the mutating install guard on Windows',{
  skip:!win,
},()=>{
  for(const [hresult,error] of [
    ['-2147024891','VISIBILITY_UNVERIFIED'],
    ['-2147467259','VISIBILITY_UNVERIFIED'],
  ] as const){
    const fake=hubBootTaskVisibilityProbe.replace(
      "    $scheduleService=New-Object -ComObject 'Schedule.Service' -ErrorAction Stop",
      "    throw ([System.Runtime.InteropServices.COMException]::new('fixture',"+hresult+"))",
    );
    assert.notEqual(fake,hubBootTaskVisibilityProbe);
    const result=execute(fake);
    assert.match(result,/TASK_MUTATION_DENIED:HUB_BOOT_EXISTING_TASK_VISIBILITY_UNVERIFIED/);
    assert.ok(result.includes(error));
  }
});

test('COM verified absence is accepted but a visible task is never overwritten',{
  skip:!win,
},()=>{
  const missing=hubBootTaskVisibilityProbe.replace(
    "    $scheduleService=New-Object -ComObject 'Schedule.Service' -ErrorAction Stop",
    "    throw ([System.Runtime.InteropServices.COMException]::new('fixture',-2147024894))",
  );
  assert.equal(execute(missing),'TASK_ABSENCE_PROVED');
  assert.equal(execute(hubBootTaskVisibilityProbe,true),
    'TASK_MUTATION_DENIED:HUB_BOOT_EXISTING_TASK_INSTALL_DENIED');
});

test('real Windows task lookup is read-only and refuses an ACL-hidden SYSTEM task',{
  skip:!win,
},()=>{
  const script=[
    "$ErrorActionPreference='Stop'",
    "$boot='Nexowire Hub Boot'",
    "$bootTask=Get-ScheduledTask -TaskName $boot -TaskPath '\\' -ErrorAction SilentlyContinue",
    hubBootTaskVisibilityProbe,
    "'TASK_VISIBILITY='+$bootVisibility",
    'try {',
    hubBootInstallTaskAbsenceGuard,
    "  if($null -ne $bootTask){throw 'HUB_BOOT_EXISTING_TASK_INSTALL_DENIED'}",
    "  'TASK_MUTATION_ALLOWED'",
    "}catch { 'TASK_MUTATION_DENIED='+[string]$_.Exception.Message }",
  ].join('\n');
  const child=spawnSync(ps,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
    Buffer.from(script,'utf16le').toString('base64')],{
    encoding:'utf8',windowsHide:true,timeout:15000,
  });
  assert.equal(child.status,0,child.stderr+' '+child.stdout);
  if(child.stdout.includes('TASK_VISIBILITY=access-denied')||
     child.stdout.includes('TASK_VISIBILITY=visibility-unverified')||
     child.stdout.includes('TASK_VISIBILITY=identity-unverified')){
    assert.match(child.stdout,/TASK_MUTATION_DENIED=HUB_BOOT_EXISTING_TASK_VISIBILITY_UNVERIFIED/);
  }else if(!child.stdout.includes('TASK_MUTATION_ALLOWED')){
    assert.match(child.stdout,/TASK_MUTATION_DENIED=HUB_BOOT_EXISTING_TASK_INSTALL_DENIED/);
  }
});
