import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  verifyPrivilegedStackTaskSnapshot,
  auditProtectedPrivilegedStackLauncherReadOnly,
  STACK_TASK,STACK_ROOT,STACK_LAUNCHER,STACK_LAUNCH_ARGS,
  WINDOWS_POWERSHELL,
} from '../src/security/privileged-stack-task-chain-preflight.js';

const sid='S-1-5-21-100-200-300-1001';
const future=()=>({
  name:STACK_TASK,taskPath:'\\',state:'Running',
  principal:{userSid:sid,runLevel:'Highest',logonType:'Interactive'},
  actions:[{
    execute:WINDOWS_POWERSHELL,
    arguments:STACK_LAUNCH_ARGS,
    workingDirectory:STACK_ROOT,
  }],
  triggers:[{type:'Logon',userSid:sid,enabled:true}],
});

test('reviewed future protected Task snapshot still NEVER authorizes OS operation',()=>{
  const out=verifyPrivilegedStackTaskSnapshot(future(),sid);
  assert.equal(out.taskIdentityVerified,true);
  assert.equal(out.protectedLauncherChainVerified,false);
  assert.equal(out.protectedDependencyTreeVerified,false);
  assert.equal(out.taskAclVerified,false);
  assert.equal(out.runningProcessAttested,false);
  assert.equal(out.remoteActuationAuthorized,false);
  assert.equal(Object.isFrozen(out),true);
});

test('actual observed unsafe task pattern: unqualified powershell and profile launcher rejected',()=>{
  const s=future();
  const actual={
    ...s,
    actions:[{
      execute:'powershell.exe',
      arguments:'-NoLogo -NoProfile -ExecutionPolicy Bypass -File "'+
        'C:\\Users\\navea\\AppData\\Local\\NexowireStack\\run-stack.ps1"',
      workingDirectory:'',
    }],
  };
  assert.throws(()=>verifyPrivilegedStackTaskSnapshot(actual,sid),
    /STACK_TASK_UNPROTECTED_ACTION_DENIED/);
});

test('pinned System32 PowerShell with user-writable launcher or missing flags is rejected',()=>{
  const s=future();
  for(const action of [
    {...s.actions[0],execute:'powershell.exe'},
    {...s.actions[0],execute:'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe'},
    {...s.actions[0],execute:'C:\\Users\\Public\\powershell.exe'},
    {...s.actions[0],workingDirectory:'C:\\Users\\navea\\AppData\\Local\\NexowireStack'},
    {...s.actions[0],arguments:s.actions[0]!.arguments.replace(STACK_LAUNCHER,
      'C:\\Users\\navea\\AppData\\Local\\NexowireStack\\run-stack.ps1')},
    {...s.actions[0],arguments:s.actions[0]!.arguments.replace('-NonInteractive ','')},
    {...s.actions[0],arguments:s.actions[0]!.arguments+' -EncodedCommand ABC'},
  ]) {
    assert.throws(()=>verifyPrivilegedStackTaskSnapshot(
      {...s,actions:[action]},sid,
    ),/STACK_TASK_UNPROTECTED_ACTION_DENIED/);
  }
});

test('Task principal and recovery triggers must match exactly one current owner SID',()=>{
  const s=future();
  for(const changed of [
    {...s,state:'Ready'},
    {...s,principal:{...s.principal,runLevel:'Limited'}},
    {...s,principal:{...s.principal,logonType:'ServiceAccount'}},
    {...s,principal:{...s.principal,userSid:'S-1-5-18'}},
    {...s,actions:[...s.actions,...s.actions]},
    {...s,triggers:[...s.triggers,...s.triggers]},
    {...s,triggers:[]},
  ]){
    assert.throws(()=>verifyPrivilegedStackTaskSnapshot(changed,sid),
      /STACK_TASK_IDENTITY_UNVERIFIED/);
  }
  for(const trigger of [
    {...s.triggers[0],type:'Time'},
    {...s.triggers[0],enabled:false},
    {...s.triggers[0],userSid:'S-1-5-21-100-200-300-1011'},
  ]){
    assert.throws(()=>verifyPrivilegedStackTaskSnapshot(
      {...s,triggers:[trigger]},sid,
    ),/STACK_TASK_TRIGGER_UNVERIFIED/);
  }
  assert.throws(()=>verifyPrivilegedStackTaskSnapshot(s,'S-1-5-18'),
    /STACK_TASK_CURRENT_USER_SID_UNVERIFIED/);
});

test('unknown Task fields and aliases cannot be used to inject actuation permissions',()=>{
  assert.throws(()=>verifyPrivilegedStackTaskSnapshot({
    ...future(),permissionToRun:true,
  },sid));
  assert.throws(()=>verifyPrivilegedStackTaskSnapshot({
    ...future(),actions:[{...future().actions[0],injectedShell:'cmd.exe'}],
  },sid));
  assert.throws(()=>verifyPrivilegedStackTaskSnapshot({
    ...future(),name:'Nexowire Stack Backup',
  },sid));
});

test('production pinned source check remains read-only; no actuation/install path',()=>{
  const file=readFileSync(
    new URL('../src/security/privileged-stack-task-chain-preflight.ts',import.meta.url),
    'utf8',
  );
  assert.match(file,/auditPrivilegedStackDependencyTree\(\)/);
  assert.match(file,/verifyWindowsPrivateAcl\(p\)/);
  assert.match(file,/lstatSync\(p\)/);
  assert.match(file,/st\.nlink!==1/);
  assert.match(file,/remoteActuationAuthorized:false/);
  assert.doesNotMatch(file,
    /Register-ScheduledTask|Start-ScheduledTask|Stop-ScheduledTask|icacls\.exe|spawnSync|chmodSync|writeFileSync/);
  if(process.platform!=='win32'){
    assert.throws(()=>auditProtectedPrivilegedStackLauncherReadOnly(),
      /STACK_TASK_WINDOWS_ONLY/);
  }
});
