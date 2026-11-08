import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {
  assessWindowsUnattendedRebootReadiness,
} from '../src/hub/hub-boot-lifecycle.js';

const systemAgent={installed:true,systemIdentity:true,bootTrigger:true,interactiveOnly:false};
const userAgent={installed:true,systemIdentity:false,bootTrigger:false,interactiveOnly:true};

test('installed user-logon Hub and interactive Agent cannot certify pre-login reconnect',()=>{
  const result=assessWindowsUnattendedRebootReadiness({
    systemHubInstalled:false,
    agent:userAgent,
    autoAdminLogon:false,
  });
  assert.equal(result.startupTopologyReady,false);
  assert.equal(result.remoteRebootAccepted,false);
  assert.deepEqual(result.blockers,[
    'SYSTEM_HUB_BOOT_NOT_INSTALLED',
    'NATIVE_AGENT_LOGON_ONLY',
    'PRELOGIN_REMOTE_RECOVERY_NOT_VERIFIED',
  ]);
});

test('SYSTEM Hub alone is not enough while Native Agent still needs an interactive logon',()=>{
  const result=assessWindowsUnattendedRebootReadiness({
    systemHubInstalled:true,
    agent:userAgent,
    autoAdminLogon:false,
  });
  assert.equal(result.startupTopologyReady,false);
  assert.deepEqual(result.blockers,[
    'NATIVE_AGENT_LOGON_ONLY',
    'PRELOGIN_REMOTE_RECOVERY_NOT_VERIFIED',
  ]);
});

test('unverified startup task and missing agent are individually blocked',()=>{
  const missing=assessWindowsUnattendedRebootReadiness({
    systemHubInstalled:true,agent:{installed:false,systemIdentity:false,bootTrigger:false,interactiveOnly:false},
    autoAdminLogon:false,
  });
  assert.ok(missing.blockers.includes('NATIVE_AGENT_NOT_INSTALLED'));
  const untrusted=assessWindowsUnattendedRebootReadiness({
    systemHubInstalled:true,
    agent:{installed:true,systemIdentity:false,bootTrigger:true,interactiveOnly:false},
    autoAdminLogon:false,
  });
  assert.ok(untrusted.blockers.includes('NATIVE_AGENT_PRELOGIN_IDENTITY_UNVERIFIED'));
});

test('even a SYSTEM startup Agent requires physical pre-login reconnect proof',()=>{
  const result=assessWindowsUnattendedRebootReadiness({
    systemHubInstalled:true,agent:systemAgent,autoAdminLogon:false,
  });
  assert.equal(result.startupTopologyReady,true);
  assert.equal(result.remoteRebootAccepted,false);
  assert.deepEqual(result.blockers,['PRELOGIN_REMOTE_RECOVERY_NOT_VERIFIED']);
});

test('Windows auto-login is not a substitute for a proven pre-login Agent',()=>{
  const result=assessWindowsUnattendedRebootReadiness({
    systemHubInstalled:false,agent:userAgent,autoAdminLogon:true,
  });
  assert.equal(result.remoteRebootAccepted,false);
  assert.equal(result.autoAdminLogon,true);
  assert.ok(result.blockers.includes('NATIVE_AGENT_LOGON_ONLY'));
});

test('CI explicitly runs this preflight on Windows Node 22 and Node 24',()=>{
  const workflow=readFileSync(new URL('../.github/workflows/ci.yml',import.meta.url),'utf8');
  const job=workflow.slice(workflow.indexOf('  connection-v2-negative-windows:'),
    workflow.indexOf('  connection-v2-native-git-dag:'));
  assert.match(job,/node-version: \[22, 24\]/);
  assert.match(job,/test\/windows-unattended-reboot-readiness\.test\.ts/);
  assert.match(job,/WINDOWS_UNATTENDED_REBOOT_READINESS_RED/);
});

test('real CLI shows the Work-PC reboot blockers without rebooting or changing task state',{
  skip:process.platform!=='win32',
},()=>{
  const run=spawnSync(process.execPath,[
    '--import','tsx','src/cli.ts','hub','reboot-readiness',
  ],{cwd:process.cwd(),encoding:'utf8',windowsHide:true,timeout:20_000});
  assert.equal(run.status,0,run.stderr.slice(0,700));
  const data=JSON.parse(run.stdout);
  assert.equal(data.remoteRebootAccepted,false);
  assert.ok(data.blockers.includes('PRELOGIN_REMOTE_RECOVERY_NOT_VERIFIED'));
  assert.equal(typeof data.startupTopologyReady,'boolean');
});
