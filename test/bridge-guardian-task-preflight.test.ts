import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  BRIDGE_GUARDIAN_TASK_NAME,
  BRIDGE_GUARDIAN_SOURCE_ROOT,
  BRIDGE_GUARDIAN_LAUNCHER,
  BRIDGE_GUARDIAN_POWERSHELL,
  verifyBridgeGuardianTaskSnapshot,
  inspectGuardianSourceChainSnapshotOnly,
} from '../src/agent/bridge-guardian-task-preflight.js';

const SID = 'S-1-5-21-100-200-300-1001';
const canonical = () => ({
  name:BRIDGE_GUARDIAN_TASK_NAME,
  taskPath:'\\',
  state:'Running',
  principal:{
    userSid:SID,runLevel:'Highest',logonType:'Interactive',
  },
  actions:[{
    execute:BRIDGE_GUARDIAN_POWERSHELL,
    arguments:'-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
      BRIDGE_GUARDIAN_LAUNCHER + '"',
    workingDirectory:BRIDGE_GUARDIAN_SOURCE_ROOT,
  }],
  triggers:[{type:'Logon',userSid:SID,enabled:true}],
});

test('canonical guardian snapshot is only task-identity evidence, not ACL or Hub health',()=>{
  const result=verifyBridgeGuardianTaskSnapshot(canonical(),SID);
  assert.equal(result.taskName,'Nexowire Bridge Guardian');
  assert.equal(result.actionVerified,true);
  assert.equal(result.logonTriggerVerified,true);
  assert.equal(result.sourceAclVerified,false);
  assert.equal(result.hubChannelVerified,false);
  assert.equal(Object.isFrozen(result),true);
});

test('task with wrong name, user, token elevation, logon context, state or path is rejected',()=>{
  const t=canonical();
  for(const modified of [
    {...t,name:'Nexowire Privileged Broker'},
    {...t,name:'Nexowire Stack'},
    {...t,name:'Nexowire Bridge Guardian '},
    {...t,taskPath:'\\Users\\'},
    {...t,state:'Disabled'},
    {...t,state:'Ready'},
    {...t,principal:{...t.principal,userSid:'S-1-5-18'}},
    {...t,principal:{...t.principal,runLevel:'Limited'}},
    {...t,principal:{...t.principal,logonType:'ServiceAccount'}},
  ]){
    assert.throws(
      ()=>verifyBridgeGuardianTaskSnapshot(modified,SID),
      /BRIDGE_GUARDIAN_TASK_IDENTITY_UNVERIFIED/,
    );
  }
  assert.throws(()=>verifyBridgeGuardianTaskSnapshot(t,'S-1-5-18'),
    /BRIDGE_GUARDIAN_CURRENT_USER_SID_INVALID/);
});

test('Guardian action must be one pinned System32 PowerShell executable and protected launcher',()=>{
  const t=canonical();
  for(const modified of [
    {...t,actions:[]},
    {...t,actions:[...t.actions,...t.actions]},
    {...t,actions:[{...t.actions[0],execute:'powershell.exe'}]},
    {...t,actions:[{...t.actions[0],execute:'C:\\Users\\Public\\powershell.exe'}]},
    {...t,actions:[{...t.actions[0],arguments:t.actions[0]!.arguments+' -EncodedCommand ABC'}]},
    {...t,actions:[{...t.actions[0],arguments:t.actions[0]!.arguments.replace('launch.ps1','other.ps1')}]},
    {...t,actions:[{...t.actions[0],workingDirectory:'C:\\Users\\Public'}]},
  ]) {
    assert.throws(
      ()=>verifyBridgeGuardianTaskSnapshot(modified,SID),
      /BRIDGE_GUARDIAN_TASK_ACTION_UNVERIFIED/,
    );
  }
});

test('recovery must be scheduled separately for the expected user logon',()=>{
  const t=canonical();
  for(const modified of [
    {...t,triggers:[]},
    {...t,triggers:[{type:'Logon',userSid:SID,enabled:false}]},
    {...t,triggers:[{type:'Logon',userSid:'S-1-5-21-1-2-3-1002',enabled:true}]},
    {...t,triggers:[{type:'Time',userSid:null,enabled:true}]},
    {...t,triggers:[...t.triggers,{type:'Time',userSid:null,enabled:true}]},
    {...t,triggers:[...t.triggers,{type:'Other',userSid:null,enabled:true}]},
    {...t,triggers:[...t.triggers,{type:'Logon',userSid:SID,enabled:true}]},
    {...t,triggers:[...t.triggers,{type:'Logon',userSid:SID,enabled:false}]},
    {...t,triggers:[{type:'Other',userSid:null,enabled:false},...t.triggers]},
    {...t,triggers:[{type:'Logon',userSid:null,enabled:true},...t.triggers]},
  ]) {
    assert.throws(
      ()=>verifyBridgeGuardianTaskSnapshot(modified,SID),
      /BRIDGE_GUARDIAN_TASK_LOGON_TRIGGER_UNVERIFIED/,
    );
  }
});

test('extra unrecognized task and action fields are not interpreted as permissions',()=>{
  const t=canonical();
  assert.throws(()=>verifyBridgeGuardianTaskSnapshot({
    ...t,automaticPrivilegeGrant:true,
  },SID));
  assert.throws(()=>verifyBridgeGuardianTaskSnapshot({
    ...t,actions:[{...t.actions[0],injectedShell:'cmd.exe'}],
  },SID));
});

test('read-only Guardian source chain rejects launcher modifications during ACL read',()=>{
  const root=mkdtempSync(path.join(tmpdir(),'guardian-chain-stability-'));
  const directory=path.join(root,'guardian');
  mkdirSync(directory);
  const launcher=path.join(directory,'launch.ps1');
  writeFileSync(launcher,'original');
  try {
    const chain=[root,directory,launcher];
    const observed:string[]=[];
    inspectGuardianSourceChainSnapshotOnly(chain,p=>{observed.push(p)});
    assert.deepEqual(observed,chain);
    assert.throws(()=>inspectGuardianSourceChainSnapshotOnly(chain,p=>{
      if(p===launcher)appendFileSync(launcher,'changed');
    }),/BRIDGE_GUARDIAN_SOURCE_CHANGED_DURING_AUDIT/);
  }finally{rmSync(root,{recursive:true,force:true})}
});

test('Guardian source chain revisits protected ancestors at completion',()=>{
  const root=mkdtempSync(path.join(tmpdir(),'guardian-chain-ancestor-'));
  const directory=path.join(root,'guardian');
  mkdirSync(directory);
  const launcher=path.join(directory,'launch.ps1');
  writeFileSync(launcher,'original');
  try {
    assert.throws(()=>inspectGuardianSourceChainSnapshotOnly(
      [root,directory,launcher],p=>{
        if(p===launcher)writeFileSync(path.join(directory,'late-file'),'x');
      },
    ),/BRIDGE_GUARDIAN_SOURCE_CHANGED_DURING_AUDIT/);
  }finally{rmSync(root,{recursive:true,force:true})}
});

test('Guardian source snapshot includes read-only related SQLite audit before final check',()=>{
  const root=mkdtempSync(path.join(tmpdir(),'guardian-sidecar-window-'));
  const state=path.join(root,'state');
  mkdirSync(state);
  const db=path.join(state,'replay.sqlite');
  writeFileSync(db,'original');
  try {
    let related=0;
    const visited:string[]=[];
    inspectGuardianSourceChainSnapshotOnly([root,state,db],p=>{
      visited.push(p);
    },()=>{related++;});
    assert.deepEqual(visited,[root,state,db]);
    assert.equal(related,1);
  }finally{rmSync(root,{recursive:true,force:true})}
});

test('Guardian source snapshot rejects changed DB or parent during related-sidecar check',()=>{
  for(const change of ['database-write','new-sidecar','remove-database'] as const){
    const root=mkdtempSync(path.join(tmpdir(),'guardian-sidecar-race-'));
    const state=path.join(root,'state');
    mkdirSync(state);
    const db=path.join(state,'replay.sqlite');
    writeFileSync(db,'original');
    try {
      assert.throws(()=>inspectGuardianSourceChainSnapshotOnly(
        [root,state,db],()=>{},()=>{
          if(change==='database-write')appendFileSync(db,'changed');
          if(change==='new-sidecar')writeFileSync(db+'-journal','x');
          if(change==='remove-database')rmSync(db);
        },
      ),/BRIDGE_GUARDIAN_SOURCE_CHANGED_DURING_AUDIT/,change);
    }finally{rmSync(root,{recursive:true,force:true})}
  }
});

test('preflight source is read-only and does not try to install/enable protected tasks',()=>{
  const code=readFileSync(
    new URL('../src/agent/bridge-guardian-task-preflight.ts',import.meta.url),
    'utf8',
  );
  assert.match(code,/verifyWindowsPrivateAcl/);
  assert.match(code,/lstatSync/);
  assert.match(code,/stat\.nlink!==1/);
  assert.doesNotMatch(code,/hardenWindowsProgramDataAcl|icacls\.exe|Register-ScheduledTask|Unregister-ScheduledTask|Start-ScheduledTask|Enable-ScheduledTask|Stop-ScheduledTask|Disable-ScheduledTask/);
});
