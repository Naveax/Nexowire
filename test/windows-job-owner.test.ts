import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {ProcessManager} from '../src/agent/process-manager.js';
import {PathPolicy} from '../src/agent/path-policy.js';

interface WinProc {
  ProcessId: number;
  ParentProcessId: number;
  Name: string;
  CommandLine: string | null;
  CreationDate: string;
}
function exactProcess(pid:number):WinProc|undefined {
  const script="$p=Get-CimInstance Win32_Process -Filter 'ProcessId="+pid+"'; if($p){ $p | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{N='CreationDate';E={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress }";
  const raw=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],
    {encoding:'utf8',windowsHide:true,timeout:9000}).trim();
  return raw?JSON.parse(raw) as WinProc:undefined;
}
function markedChild(marker:string):WinProc|undefined {
  const script="$m="+JSON.stringify(marker)+"; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($m) -and $_.CommandLine.Contains('setInterval') } | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{N='CreationDate';E={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress";
  const raw=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],
    {encoding:'utf8',windowsHide:true,timeout:9000}).trim();
  if (!raw) return undefined;
  const found=JSON.parse(raw) as WinProc|WinProc[];
  assert.ok(!Array.isArray(found), 'exactly one marked fixture is required');
  return found;
}

test('Windows Job guardian death kills only its attached synthetic descendants', {
  skip:process.platform!=='win32',timeout:32_000,
},async()=>{
  const marker='NW_GUARD_DEATH_'+randomBytes(12).toString('hex');
  const manager=new ProcessManager();
  const session=await manager.start({
    command:"node -e \"const marker='"+marker+"';setInterval(() => {}, 1000)\"",
    shell:'powershell',
  },new PathPolicy(['*']));
  let childProof:WinProc|undefined;
  try {
    assert.equal(session.treeOwnership,'windows_job');
    assert.ok(session.jobGuardianPid && session.pid && session.processCreationFiletime);
    for(let i=0;i<20;i++){
      childProof=markedChild(marker);
      if(childProof) break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(childProof, 'one uniquely marked job child must exist');
    const rootProof=exactProcess(session.pid!);
    assert.ok(rootProof && /powershell\.exe/i.test(rootProof.Name),
      'test shell root PID must resolve to its expected executable');
    const actualTime=new Date(rootProof.CreationDate).getTime();
    const attestedTime=Number(BigInt(session.processCreationFiletime!)/10_000n-11_644_473_600_000n);
    assert.ok(Math.abs(actualTime-attestedTime)<1000,
      'Win32 root process creation timestamp must match native attestation');
    const guardProof=exactProcess(session.jobGuardianPid!);
    assert.ok(guardProof && guardProof.Name.toLowerCase()==='windows-job-owner.exe' &&
      guardProof.CommandLine?.includes(marker),
      'guardian PID and its unique test command must both match before cleanup');
    const guardNow=exactProcess(guardProof.ProcessId);
    assert.equal(guardNow?.CreationDate,guardProof.CreationDate,
      'no guardian PID reuse before test-owned termination');
    const terminated=spawnSync('taskkill.exe',['/PID',String(guardProof.ProcessId),'/F'],
      {windowsHide:true,stdio:'ignore',timeout:5000});
    assert.equal(terminated.status,0,'terminate only the marker-matching test guardian');
    let lingering:WinProc|undefined;
    for(let i=0;i<20;i++){
      lingering=markedChild(marker);
      if(!lingering)break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(lingering,undefined,
      'non-inheritable KILL_ON_JOB_CLOSE handle must kill descendants');
  } finally {
    // Never terminate anything lacking the unique marker AND PID time proof.
    if(childProof){
      const current=markedChild(marker);
      if(current?.ProcessId===childProof.ProcessId &&
         current.CreationDate===childProof.CreationDate){
        spawnSync('taskkill.exe',['/PID',String(childProof.ProcessId),'/F'],
          {windowsHide:true,stdio:'ignore',timeout:5000});
      }
    }
    try {await manager.stop({session_id:session.sessionId});}catch{}
  }
});


test('Windows volatile Job is killed when its exact synthetic Agent parent crashes', {
  skip:process.platform!=='win32',timeout:35_000,
},async()=>{
  const marker='NW_PARENT_DEATH_'+randomBytes(12).toString('hex');
  const {spawn}=await import('node:child_process');
  const fixture=spawn(process.execPath,
    ['--import','tsx','test/fixtures/windows-job-parent-crash.ts',marker],
    {cwd:process.cwd(),windowsHide:true,stdio:['ignore','pipe','pipe']});
  let proof:WinProc|undefined;
  let fixtureProof:WinProc|undefined;
  try{
    const published=await new Promise<{parentPid:number;guardianPid:number;rootPid:number}>((resolve,reject)=>{
      let text='';
      const timer=setTimeout(()=>reject(new Error('fixture launch timeout')),12_000);
      fixture.once('error',reject);
      fixture.stdout.on('data',(data:Buffer)=>{
        text+=data.toString('utf8');
        const newline=text.indexOf('\n');
        if(newline>=0){
          clearTimeout(timer);
          try{resolve(JSON.parse(text.slice(0,newline)) as {parentPid:number;guardianPid:number;rootPid:number})}
          catch(error){reject(error)}
        }
      });
    });
    assert.equal(published.parentPid,fixture.pid);
    assert.ok(published.guardianPid && published.rootPid);
    for(let i=0;i<20;i++){
      proof=markedChild(marker);
      if(proof)break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(proof,'test Job descendant must be running');
    fixtureProof=exactProcess(fixture.pid!);
    assert.ok(fixtureProof?.CommandLine?.includes('windows-job-parent-crash.ts') &&
      fixtureProof.CommandLine?.includes(marker),
      'fixture PID must have exact unique marker and expected test entrypoint');
    assert.equal(exactProcess(fixture.pid!)?.CreationDate,fixtureProof!.CreationDate);
    const result=spawnSync('taskkill.exe',['/PID',String(fixture.pid),'/F'],
      {windowsHide:true,stdio:'ignore',timeout:5000});
    assert.equal(result.status,0,'terminate only the verified synthetic Agent PID');
    let remaining:WinProc|undefined;
    for(let i=0;i<20;i++){
      remaining=markedChild(marker);
      if(!remaining)break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(remaining,undefined,
      'guardian must close volatile Job if its owning Agent process exits');
  }finally{
    if(fixtureProof){
      const now=exactProcess(fixtureProof.ProcessId);
      if(now?.CreationDate===fixtureProof.CreationDate &&
        now.CommandLine?.includes(marker)){
        spawnSync('taskkill.exe',['/PID',String(now.ProcessId),'/F'],
          {windowsHide:true,stdio:'ignore',timeout:5000});
      }
    }
    if(proof){
      const now=markedChild(marker);
      if(now?.ProcessId===proof.ProcessId && now.CreationDate===proof.CreationDate){
        spawnSync('taskkill.exe',['/PID',String(now.ProcessId),'/F'],
          {windowsHide:true,stdio:'ignore',timeout:5000});
      }
    }
  }
});


test('Windows Job preserves separate stdin/stdout/stderr pipes', {
  skip:process.platform!=='win32',timeout:18_000,
},async()=>{
  const manager=new ProcessManager();
  const session=await manager.start({
    shell:'cmd',
    command:'echo WINJOB_STDOUT & echo WINJOB_STDERR 1>&2',
  },new PathPolicy(['*']));
  assert.equal(session.jobMembershipVerified, 'root_at_launch');
  assert.equal(session.descendantCoverage, 'job_members_only');
  assert.equal(session.outOfJobDescendants, 'unknown');
  let stdout='',stderr='',cursor=0,status='running';
  try{
    for(let attempt=0;attempt<30;attempt++){
      const read=await manager.read({session_id:session.sessionId,after_seq:cursor,wait_ms:500});
      cursor=read.nextSeq;status=read.session.status;
      for(const evt of read.events){
        if(evt.stream==='stdout')stdout+=evt.text;
        else stderr+=evt.text;
      }
      if(status==='exited')break;
    }
    assert.equal(status,'exited');
    assert.match(stdout,/WINJOB_STDOUT/);
    assert.match(stderr,/WINJOB_STDERR/);
  }finally{
    if(status==='running') await manager.stop({session_id:session.sessionId});
  }
});

test('Win32 Job launch is fail-closed when the requested image cannot be started', {
  skip:process.platform!=='win32',timeout:14_000,
},async()=>{
  const {launchWindowsJob}=await import('../src/agent/windows-job-owner.js');
  const name='NX_NONEXISTENT_'+randomBytes(12).toString('hex')+'.exe';
  await assert.rejects(()=>launchWindowsJob(name,[],{guardOnParentExit:true}),
    (error:unknown)=>error instanceof Error &&
      'code' in error && error.code==='WINDOWS_JOB_LAUNCH_UNCONFIRMED');
});


test('Windows durable sidecar worker crash closes owned Job without killing Agent', {
  skip:process.platform!=='win32',timeout:42_000,
},async()=>{
  const {promises:fs}=await import('node:fs');
  const os=await import('node:os');
  const path=await import('node:path');
  const marker='NW_DURABLE_CRASH_'+randomBytes(12).toString('hex');
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'nw-job-worker-crash-'));
  const manager=new ProcessManager({
    stateFile:path.join(tmp,'state.json'),
    workerRoot:path.join(tmp,'workers'),
    workerEntrypoint:path.resolve('src/cli.ts'),
    workerExecArgv:process.execArgv,
  });
  await manager.initialize();
  let childProof:WinProc|undefined,workerProof:WinProc|undefined;
  let ownedSessionId:string|undefined;
  try{
    const session=await manager.start({
      shell:'powershell',durable:true,
      command:"node -e \"const marker='"+marker+"';setInterval(() => {}, 1000)\"",
    },new PathPolicy(['*']));
    assert.equal(session.durable,true);
    ownedSessionId=session.sessionId;
    const statusFile=path.join(tmp,'workers',session.sessionId,'status.json');
    const workerStatus=JSON.parse(await fs.readFile(statusFile,'utf8')) as {
      workerPid:number;childPid:number;sessionId:string;
    };
    assert.equal(workerStatus.sessionId,session.sessionId);
    for(let i=0;i<20;i++){
      childProof=markedChild(marker);
      if(childProof)break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(childProof,'unique durable shell child must be running before worker crash');
    workerProof=exactProcess(workerStatus.workerPid);
    assert.ok(workerProof?.CommandLine?.includes('process-worker') &&
      workerProof.CommandLine?.includes(session.sessionId),
      'verify exact worker PID and unique session directory before termination');
    assert.equal(exactProcess(workerStatus.workerPid)?.CreationDate,workerProof!.CreationDate);
    const kill=spawnSync('taskkill.exe',['/PID',String(workerStatus.workerPid),'/F'],
      {windowsHide:true,stdio:'ignore',timeout:5000});
    assert.equal(kill.status,0,'kill only exact marker-associated synthetic durable worker');
    let lingering:WinProc|undefined;
    for(let i=0;i<20;i++){
      lingering=markedChild(marker);
      if(!lingering)break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(lingering,undefined,
      'guardian must reap durable descendants after their own sidecar dies');
  }finally{
    // Only stop the unique managed durable session created by this fixture.
    if(ownedSessionId) await manager.stop({session_id:ownedSessionId}).catch(()=>undefined);
    await manager.shutdown().catch(()=>undefined);
    if(childProof){
      const now=markedChild(marker);
      if(now?.ProcessId===childProof.ProcessId && now.CreationDate===childProof.CreationDate){
        spawnSync('taskkill.exe',['/PID',String(now.ProcessId),'/F'],
          {windowsHide:true,stdio:'ignore',timeout:5000});
      }
    }
    await fs.rm(tmp,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});


test('Windows helper path cannot be replaced by inherited environment', {
  skip:process.platform!=='win32',
  timeout:18_000,
},async()=>{
  const {launchWindowsJob}=await import('../src/agent/windows-job-owner.js');
  const key='NEXOWIRE_WINDOWS_JOB_HELPER';
  const original=process.env[key];
  // node.exe exists, but is not the trusted Win32 Job guardian. If selected,
  // it cannot publish the Job attestation. The pinned package helper must win.
  process.env[key]=process.execPath;
  try{
    const launch=await launchWindowsJob(
      process.execPath,['-e','process.exit(0)'],
      {guardOnParentExit:true},
    );
    if(!launch.closed()){
      await new Promise<void>((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(new Error('Job guardian did not exit')),10_000);
        launch.child.once('close',()=>{clearTimeout(timeout);resolve();});
        launch.child.once('error',error=>{clearTimeout(timeout);reject(error);});
      });
    }
    assert.equal(launch.child.exitCode,0,
      'trusted helper must run to successful Job and process completion');
  }finally{
    if(original===undefined) delete process.env[key];
    else process.env[key]=original;
  }
});


test('Windows Job fast-exit stdout and stderr are drained before exited status', {
  skip:process.platform!=='win32',timeout:35_000,
},async()=>{
  // Reproduce #565: short-lived synthetic commands must never finalize
  // before the guardian's inherited pipes have been fully consumed.
  const manager=new ProcessManager();
  for(let iteration=0;iteration<12;iteration++){
    const marker='NW_JOB_STREAM_'+randomBytes(6).toString('hex');
    const session=await manager.start({
      shell:'cmd',command:'echo '+marker+'_OUT & echo '+marker+'_ERR 1>&2',
    },new PathPolicy(['*']));
    assert.equal(session.treeOwnership,'windows_job');
    let stdout='',stderr='',cursor=0,status='running';
    try{
      for(let i=0;i<35;i++){
        const read=await manager.read({
          session_id:session.sessionId,after_seq:cursor,wait_ms:250,
        });
        cursor=read.nextSeq;
        status=read.session.status;
        for(const event of read.events){
          if(event.stream==='stdout')stdout+=event.text;
          else stderr+=event.text;
        }
        if(status==='exited')break;
      }
      assert.equal(status,'exited','synthetic fast-exit must finish');
      assert.ok(stdout.includes(marker+'_OUT'),'stdout lost, iteration '+iteration);
      assert.ok(stderr.includes(marker+'_ERR'),'stderr lost, iteration '+iteration);
    }finally{
      if(status==='running'||status==='orphaned'){
        await manager.stop({session_id:session.sessionId}).catch(()=>undefined);
      }
    }
  }
});
