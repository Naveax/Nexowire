import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { ProcessManager } from '../src/agent/process-manager.js';
import { PathPolicy } from '../src/agent/path-policy.js';

interface Proof { ProcessId: number; Name: string; CreationDate: string; CommandLine: string|null }

function getProof(pid:number):Proof|undefined {
  const script="$p=Get-CimInstance Win32_Process -Filter 'ProcessId="+pid+
    "'; if($p) {$p | Select-Object ProcessId,Name,CommandLine,"+
    "@{N='CreationDate';E={$_.CreationDate.ToUniversalTime().ToString('o')}} | ConvertTo-Json -Compress}";
  const result=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],
    {encoding:'utf8',timeout:8000,windowsHide:true}).trim();
  return result ? JSON.parse(result) as Proof : undefined;
}

async function waitReady(child:ChildProcessWithoutNullStreams):Promise<void>{
  await new Promise<void>((resolve,reject)=>{
    let text='';
    const timer=setTimeout(()=>reject(new Error('Synthetic handle holder not ready')),10_000);
    const done=()=>clearTimeout(timer);
    child.once('error',error=>{done();reject(error)});
    child.once('exit',code=>{done();reject(new Error('Holder exited early: '+code))});
    child.stdout.on('data',(chunk:Buffer)=>{
      text+=chunk.toString('utf8');
      if(text.includes('NW_HOLDER_READY')){done();resolve()}
    });
  });
}

test('named Job query handle is a production cleanup caveat under forced guardian death', {
  skip:process.platform!=='win32',
  timeout:45_000,
},async()=>{
  const marker='NW_HOLDER_'+randomBytes(10).toString('hex');
  const manager=new ProcessManager();
  const session=await manager.start({
    shell:'powershell',command:'node -e "const marker=\''+marker+'\';setInterval(()=>{},1000)"'
  },new PathPolicy(['*']));
  let holder:ChildProcessWithoutNullStreams|undefined;
  let guardian:Proof|undefined;
  try{
    assert.equal(session.treeOwnership,'windows_job');
    assert.ok(session.pid && session.jobGuardianPid);
    guardian=getProof(session.jobGuardianPid);
    assert.ok(guardian?.Name.toLowerCase()==='windows-job-owner.exe' &&
      guardian.CommandLine?.includes(marker),'guardian PID must be exact synthetic session: '+JSON.stringify(guardian));
    const match=/--job\s+"?(Local\\Nexowire-[0-9a-f-]{36})"?/i.exec(guardian.CommandLine!);
    assert.ok(match,'guard must have a unique named Job');
    const rootBefore=getProof(session.pid);
    assert.ok(rootBefore && rootBefore.Name.toLowerCase()==='powershell.exe');
    holder=spawn('powershell.exe',[
      '-NoLogo','-NoProfile','-NonInteractive','-File',
      path.resolve('test/fixtures/windows-job-hold-query.ps1'),match[1]!
    ],{cwd:process.cwd(),windowsHide:true,stdio:['pipe','pipe','pipe']});
    await waitReady(holder);
    assert.equal(getProof(guardian.ProcessId)?.CreationDate,guardian.CreationDate);
    const killed=spawnSync('taskkill.exe',['/PID',String(guardian.ProcessId),'/F'],
      {windowsHide:true,encoding:'utf8',timeout:5000});
    assert.equal(killed.status,0,'kill only the uniquely verified synthetic guardian');
    const stillAlive=getProof(session.pid);
    assert.equal(stillAlive?.CreationDate,rootBefore.CreationDate,
      'query-only Job handle held elsewhere prevents KILL_ON_JOB_CLOSE');
    holder.stdin.write('\n');
    holder.stdin.end();
    const holderPid=holder.pid;
    if(holderPid) await new Promise<void>(resolve=>holder!.once('close',()=>resolve()));
    for(let i=0;i<35;i++){
      if(!getProof(session.pid))break;
      await new Promise(r=>setTimeout(r,100));
    }
    assert.equal(getProof(session.pid),undefined,
      'releasing last synthetic query handle must finally reap root');
  }finally{
    if(holder){
      holder.stdin.end();
      // Only synthetic owned holder; do not touch system processes.
      if(holder.exitCode===null) holder.kill();
    }
    await manager.stop({session_id:session.sessionId}).catch(()=>undefined);
    if(guardian && getProof(guardian.ProcessId)?.CreationDate===guardian.CreationDate &&
      getProof(guardian.ProcessId)?.CommandLine?.includes(marker)){
      spawnSync('taskkill.exe',['/PID',String(guardian.ProcessId),'/F'],
        {windowsHide:true,stdio:'ignore',timeout:5000});
    }
  }
});
