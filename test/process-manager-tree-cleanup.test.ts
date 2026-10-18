import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {ProcessManager} from '../src/agent/process-manager.js';
import {PathPolicy} from '../src/agent/path-policy.js';

type RunningChild={ProcessId:number;ParentProcessId:number;CreationDate:string};
function findExactFixture(marker:string):RunningChild[]{
  const script=[
    "$ErrorActionPreference='Stop';",
    "$name="+JSON.stringify(marker)+';',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" |",
    "Where-Object {$_.CommandLine -and $_.CommandLine.Contains($name) -and $_.CommandLine.Contains('setInterval')} |",
    "Select-Object ProcessId,ParentProcessId,@{N='CreationDate';E={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress",
  ].join(' ');
  const raw=execFileSync('powershell.exe',[
    '-NoLogo','-NoProfile','-NonInteractive','-Command',script,
  ],{encoding:'utf8',timeout:9000,windowsHide:true}).trim();
  if(!raw)return [];
  const parsed=JSON.parse(raw) as RunningChild|RunningChild[];
  return Array.isArray(parsed)?parsed:[parsed];
}
test('Windows process.stop exposes bounded tree termination evidence and checks child', {
  skip:process.platform!=='win32',
  timeout:22_000,
},async()=>{
  const marker='NW_TREE_TEST_'+randomBytes(12).toString('hex');
  const manager=new ProcessManager();
  const started=await manager.start({
    command:"node -e \"const marker='"+marker+"';setInterval(() => {}, 1000)\"",
    name:'isolated-owned-child-cleanup-test',
  },new PathPolicy(['*']));
  let descendants:RunningChild[]=[];
  try{
    for(let i=0;i<10;i++){
      descendants=findExactFixture(marker);
      if(descendants.length)break;
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    assert.equal(descendants.length,1,'a uniquely marked child must start');
    const result=await manager.stop({session_id:started.sessionId});
    const treeCleanup='treeCleanup' in result ? result.treeCleanup : undefined;
    assert.ok(
      treeCleanup==='requested'||treeCleanup==='unconfirmed',
      'tree cleanup outcome must never be silently omitted',
    );
    assert.equal(treeCleanup,'requested',
      'live shell root should be terminated via confirmed taskkill exit 0');
    let lingering:RunningChild[]=[];
    for(let i=0;i<10;i++){
      lingering=findExactFixture(marker);
      if(!lingering.length)break;
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    assert.deepEqual(lingering,[],
      'node child must exit when the owned PowerShell root is stopped');
  }finally{
    // Narrow fixture-only cleanup. Never terminate unrelated processes.
    for(const old of descendants){
      const current=findExactFixture(marker).find(x=>x.ProcessId===old.ProcessId);
      if(current && current.CreationDate===old.CreationDate){
        spawnSync('taskkill.exe',['/PID',String(old.ProcessId),'/F'],{
          stdio:'ignore',windowsHide:true,timeout:5000,
        });
      }
    }
    try{await manager.stop({session_id:started.sessionId})}catch{}
  }
});

test('Windows exited root does NOT certify descendants after lost shell PID', {
  skip:process.platform!=='win32',
  timeout:23_000,
},async()=>{
  const marker='NW_ORPHAN_TEST_'+randomBytes(12).toString('hex');
  const manager=new ProcessManager();
  const started=await manager.start({
    command:"node -e \"const marker='"+marker+"';setInterval(() => {}, 1000)\"",
    name:'isolated-lost-parent-cleanup-test',
  },new PathPolicy(['*']));
  let descendants:RunningChild[]=[];
  try{
    for(let i=0;i<10;i++){
      descendants=findExactFixture(marker);
      if(descendants.length)break;
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    assert.equal(descendants.length,1,'expected one own synthetic child');
    assert.ok(Number.isSafeInteger(started.pid) && Number(started.pid)>0);
    // Recreate the earlier physical failure: only the shell root exits,
    // while its tracked Node child inherits handles and keeps running.
    const killed=spawnSync('taskkill.exe',['/PID',String(started.pid),'/F'],{
      windowsHide:true,stdio:'ignore',timeout:5000,
    });
    assert.equal(killed.status,0,'fixture root should be killed without /T');
    const result=await manager.stop({session_id:started.sessionId});
    const cleanup='treeCleanup' in result?result.treeCleanup:undefined;
    assert.equal(cleanup,'unconfirmed',
      'a missing root process may have live descendants; never report success');
    assert.equal(findExactFixture(marker).length,1,
      'owned child survives absent-root cleanup, verifying why result is uncertain');
  }finally{
    // Test owns a unique marker + exact PID/creation timestamp; no broad
    // process termination and no mutation of real user applications.
    for(const old of descendants){
      const current=findExactFixture(marker).find(x=>x.ProcessId===old.ProcessId);
      if(current && current.CreationDate===old.CreationDate){
        spawnSync('taskkill.exe',['/PID',String(old.ProcessId),'/F'],{
          stdio:'ignore',windowsHide:true,timeout:5000,
        });
      }
    }
    try{await manager.stop({session_id:started.sessionId})}catch{}
  }
});
