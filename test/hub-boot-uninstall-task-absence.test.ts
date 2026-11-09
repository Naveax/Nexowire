import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {
  hubBootInstallTaskAbsenceGuard,
  hubBootTaskVisibilityProbe,
} from '../src/hub/hub-boot-lifecycle.js';

const win=process.platform==='win32';
const ps='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const source=readFileSync(new URL('../src/hub/hub-boot-lifecycle.ts',import.meta.url),'utf8');

test('SYSTEM uninstall checks task visibility before stopping and again before deleting launcher',()=>{
  const start=source.indexOf('export async function uninstallHubBootLifecycle(');
  const end=source.indexOf('export interface WindowsRebootAgentTaskEvidence',start);
  assert.ok(start>=0&&end>start);
  const uninstall=source.slice(start,end);
  const expected=[
    'verifyWindowsPrivateAcl(parent)',
    'hubBootTaskVisibilityProbe',
    'hubBootInstallTaskAbsenceGuard',
    'Stop-ScheduledTask -TaskName $boot',
    'Unregister-ScheduledTask -TaskName $boot',
    'hubBootTaskVisibilityProbe',
    'HUB_BOOT_TASK_REAPPEARED_BEFORE_REMOVAL',
    'hubBootInstallTaskAbsenceGuard',
    'verifyWindowsPrivateAcl(parent)',
    'await assertHubBootRootSafeToRemove(p.root)',
    'await fs.rm(p.root',
  ];
  let cursor=-1;
  for(const marker of expected){
    const next=uninstall.indexOf(marker,cursor+1);
    assert.ok(next>cursor,'Missing or misordered uninstall safety check: '+marker);
    cursor=next;
  }
  assert.equal((uninstall.match(/hubBootTaskVisibilityProbe/g)??[]).length,2);
  assert.equal((uninstall.match(/hubBootInstallTaskAbsenceGuard/g)??[]).length,2);
});

function simulateTaskProbe(hresult:number,taskVisible=false):string{
  const injected=hubBootTaskVisibilityProbe.replace(
    "    $scheduleService=New-Object -ComObject 'Schedule.Service' -ErrorAction Stop",
    "    throw ([System.Runtime.InteropServices.COMException]::new('fixture',"+hresult+"))",
  );
  assert.notEqual(injected,hubBootTaskVisibilityProbe);
  const code=[
    "$ErrorActionPreference='Stop'",
    "$boot='Nexowire Hub Boot'",
    taskVisible?"$bootTask=[pscustomobject]@{TaskName=$boot}":"$bootTask=$null",
    'try {',injected,
    "  if($null -ne $bootTask){throw 'HUB_BOOT_TASK_REAPPEARED_BEFORE_REMOVAL'}",
    hubBootInstallTaskAbsenceGuard,
    "  'SAFE_TO_DELETE'",
    "} catch { 'DELETE_DENIED:'+ [string]$_.Exception.Message }",
  ].join('\n');
  const c=spawnSync(ps,['-NoLogo','-NoProfile','-NonInteractive',
    '-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{
    encoding:'utf8',windowsHide:true,timeout:15000,
  });
  assert.equal(c.status,0,c.stderr+' '+c.stdout);
  return c.stdout.trim();
}

test('offline uninstall rejects hidden, uncertain and reappeared task without mutation',{
  skip:!win,
},()=>{
  assert.equal(simulateTaskProbe(-2147024891),
    'DELETE_DENIED:HUB_BOOT_EXISTING_TASK_VISIBILITY_UNVERIFIED');
  assert.equal(simulateTaskProbe(-2147467259),
    'DELETE_DENIED:HUB_BOOT_EXISTING_TASK_VISIBILITY_UNVERIFIED');
  assert.equal(simulateTaskProbe(-2147024894,true),
    'DELETE_DENIED:HUB_BOOT_TASK_REAPPEARED_BEFORE_REMOVAL');
  assert.equal(simulateTaskProbe(-2147024894),'SAFE_TO_DELETE');
});
