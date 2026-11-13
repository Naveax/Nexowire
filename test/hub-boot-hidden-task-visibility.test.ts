import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {
  assessWindowsUnattendedRebootReadiness,
  classifyHubBootTaskPresence,
  hubBootTaskVisibilityProbe,
} from '../src/hub/hub-boot-lifecycle.js';

const windows=process.platform==='win32';
const powershell=String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;

function executeProbe(code:string):{status:number|null;state:string;error:string}{
  const script=[
    "$ErrorActionPreference='Stop'",
    "$boot='Nexowire Hub Boot'",
    '$bootTask=$null',
    code,
    '[pscustomobject]@{state=$bootVisibility}|ConvertTo-Json -Compress',
  ].join('\n');
  const r=spawnSync(powershell,[
    '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
    Buffer.from(script,'utf16le').toString('base64'),
  ],{encoding:'utf8',timeout:15000,windowsHide:true});
  const state=r.status===0?JSON.parse(r.stdout).state:'';
  return {status:r.status,state,error:r.stderr};
}

test('COM error 0x80070005 is never misreported as an absent SYSTEM task',{
  skip:!windows,
},()=>{
  const error=[
    ['-2147024891','access-denied'],
    ['-2147024894','not-installed'],
    ['-2147467259','visibility-unverified'],
  ] as const;
  for(const [hresult,expected] of error){
    const simulated=hubBootTaskVisibilityProbe.replace(
      "    $scheduleService=New-Object -ComObject 'Schedule.Service' -ErrorAction Stop",
      "    throw ([System.Runtime.InteropServices.COMException]::new('disposable',"+hresult+"))",
    );
    assert.notEqual(simulated,hubBootTaskVisibilityProbe,'Mock must only change COM construction');
    const result=executeProbe(simulated);
    assert.equal(result.status,0,result.error);
    assert.equal(result.state,expected,hresult);
  }
});

test('real read-only COM query classifies hidden or absent SYSTEM task without mutating it',{
  skip:!windows,
},()=>{
  const result=executeProbe(hubBootTaskVisibilityProbe);
  assert.equal(result.status,0,result.error);
  assert.ok([
    'not-installed','access-denied','identity-unverified','visibility-unverified',
  ].includes(result.state),'Unexpected read-only scheduler classification: '+result.state);
});

test('protected SYSTEM task presence never invents absence from access-denied',()=>{
  assert.equal(classifyHubBootTaskPresence(false,'access-denied'),'unverified');
  assert.equal(classifyHubBootTaskPresence(false,'visibility-unverified'),'unverified');
  assert.equal(classifyHubBootTaskPresence(false,'identity-unverified'),'present');
  assert.equal(classifyHubBootTaskPresence(false,'not-installed'),'absent');
  assert.equal(classifyHubBootTaskPresence(true,'running'),'present');
  assert.equal(classifyHubBootTaskPresence(true,'ready'),'present');
  // A contradictory unseen state must remain unknown rather than being
  // classified absent merely because Get-ScheduledTask returned null.
  assert.equal(classifyHubBootTaskPresence(false,'unexpected'),'unverified');
});

test('uncertain SYSTEM task visibility cannot be treated as installed or reboot-ready',()=>{
  for(const state of ['access-denied','identity-unverified','visibility-unverified']){
    const result=assessWindowsUnattendedRebootReadiness({
      systemHubInstalled:false,
      systemHubTaskState:state,
      agent:{installed:true,systemIdentity:true,bootTrigger:true,interactiveOnly:false},
      autoAdminLogon:false,
    });
    assert.equal(result.startupTopologyReady,false);
    assert.equal(result.remoteRebootAccepted,false);
    assert.deepEqual(result.blockers,[
      'SYSTEM_HUB_BOOT_VISIBILITY_UNVERIFIED',
      'PRELOGIN_REMOTE_RECOVERY_NOT_VERIFIED',
    ]);
  }
});

test('genuinely absent SYSTEM task still reports its separate not-installed blocker',()=>{
  const result=assessWindowsUnattendedRebootReadiness({
    systemHubInstalled:false,
    systemHubTaskState:'not-installed',
    agent:{installed:true,systemIdentity:true,bootTrigger:true,interactiveOnly:false},
    autoAdminLogon:false,
  });
  assert.deepEqual(result.blockers,[
    'SYSTEM_HUB_BOOT_NOT_INSTALLED',
    'PRELOGIN_REMOTE_RECOVERY_NOT_VERIFIED',
  ]);
});
