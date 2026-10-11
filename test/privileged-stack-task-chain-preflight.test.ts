import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,appendFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {
  verifyPrivilegedStackTaskSnapshot,
  auditProtectedPrivilegedStackLauncherReadOnly,
  inspectProtectedStackLauncherSnapshotOnly,
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

test('launcher snapshot verifies fixed child and two ACL nodes before dependency inventory',{
  skip:process.platform!=='win32',
},()=>{
  const root=mkdtempSync(join(tmpdir(),'nwx-stack-launcher-'));
  const launcher=join(root,'run-stack.ps1');
  writeFileSync(launcher,'Write-Output SAFE');
  try {
    const inspected:string[]=[];
    let inventories=0;
    const count=inspectProtectedStackLauncherSnapshotOnly(root,launcher,p=>{
      inspected.push(p);
    },()=>{inventories++;return 12});
    assert.equal(count,12);
    assert.deepEqual(inspected,[root,launcher]);
    assert.equal(inventories,1);
  } finally {rmSync(root,{recursive:true,force:true})}
});

test('launcher snapshot rejects changing launcher during ACL inspection',{
  skip:process.platform!=='win32',
},()=>{
  const root=mkdtempSync(join(tmpdir(),'nwx-stack-launcher-'));
  const launcher=join(root,'run-stack.ps1');
  writeFileSync(launcher,'initial');
  try {
    let inventoryCalled=false;
    assert.throws(()=>inspectProtectedStackLauncherSnapshotOnly(root,launcher,p=>{
      if(p===launcher)appendFileSync(launcher,'-changed');
    },()=>{inventoryCalled=true;return 1}),
    /STACK_TASK_LAUNCHER_CHANGED_DURING_AUDIT/);
    assert.equal(inventoryCalled,false);
  } finally {rmSync(root,{recursive:true,force:true})}
});

test('launcher snapshot rejects changes during dependency inventory and new root children',{
  skip:process.platform!=='win32',
},()=>{
  for(const change of ['launcher-write','new-child','launcher-delete'] as const){
    const root=mkdtempSync(join(tmpdir(),'nwx-stack-launcher-'));
    const launcher=join(root,'run-stack.ps1');
    writeFileSync(launcher,'initial');
    try {
      assert.throws(()=>inspectProtectedStackLauncherSnapshotOnly(
        root,launcher,()=>{},()=>{
          if(change==='launcher-write')appendFileSync(launcher,'-changed');
          if(change==='new-child')writeFileSync(join(root,'unexpected.js'),'x');
          if(change==='launcher-delete')rmSync(launcher);
          return 7;
        }),
      /STACK_TASK_LAUNCHER_CHANGED_DURING_AUDIT/,change);
    } finally {rmSync(root,{recursive:true,force:true})}
  }
});

test('launcher snapshot rejects fake source paths and incomplete dependency inventory',{
  skip:process.platform!=='win32',
},()=>{
  const root=mkdtempSync(join(tmpdir(),'nwx-stack-launcher-'));
  const launcher=join(root,'run-stack.ps1');
  writeFileSync(launcher,'initial');
  try {
    for(const candidate of [
      join(root,'sub','run-stack.ps1'),
      join(root,'other.ps1'),
      join(dirname(root),'run-stack.ps1'),
    ]){
      assert.throws(()=>inspectProtectedStackLauncherSnapshotOnly(
        root,candidate,()=>{},()=>5),
      /STACK_TASK_LAUNCHER_SOURCE_UNTRUSTED/);
    }
    assert.throws(()=>inspectProtectedStackLauncherSnapshotOnly(
      root,launcher,()=>{},()=>0),
    /STACK_TASK_DEPENDENCY_INVENTORY_UNTRUSTED/);
  } finally {rmSync(root,{recursive:true,force:true})}
});

test('non-Windows fixture roots cannot be substituted for the protected Stack path',{
  skip:process.platform==='win32',
},()=>{
  const root=mkdtempSync(join(tmpdir(),'nwx-stack-launcher-'));
  try{
    assert.throws(()=>inspectProtectedStackLauncherSnapshotOnly(
      root,join(root,'run-stack.ps1'),()=>{},()=>1,
    ),/STACK_TASK_LAUNCHER_SOURCE_UNTRUSTED/);
  }finally{rmSync(root,{recursive:true,force:true})}
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
