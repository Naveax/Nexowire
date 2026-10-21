import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { ProcessManager } from '../src/agent/process-manager.js';
import { PathPolicy } from '../src/agent/path-policy.js';

interface Proof { ProcessId:number; Name:string; CreationDate:string; CommandLine:string|null }
function exactProcess(pid:number):Proof|undefined {
  const script="$p=Get-CimInstance Win32_Process -Filter 'ProcessId="+pid+
    "'; if($p){$p|Select-Object ProcessId,Name,CommandLine,"+
    "@{N='CreationDate';E={$_.CreationDate.ToUniversalTime().ToString('o')}}|ConvertTo-Json -Compress}";
  const raw=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],
    {encoding:'utf8',timeout:8000,windowsHide:true}).trim();
  return raw ? JSON.parse(raw) as Proof : undefined;
}

test('unnamed Job cannot be reopened by a guessed Local Job name and guardian death reaps root', {
  skip:process.platform!=='win32',
  timeout:40_000,
},async()=>{
  const marker='NW_UNNAMED_'+randomBytes(12).toString('hex');
  const manager=new ProcessManager();
  const session=await manager.start({
    shell:'powershell',
    command:'node -e "const marker=\''+marker+'\';setInterval(()=>{},1000)"',
  },new PathPolicy(['*']));
  let guardian:Proof|undefined;
  try{
    assert.equal(session.treeOwnership,'windows_job');
    assert.ok(session.jobGuardianPid && session.pid);
    guardian=exactProcess(session.jobGuardianPid);
    assert.ok(guardian?.Name.toLowerCase()==='windows-job-owner.exe' &&
      guardian.CommandLine?.includes(marker),'must bind guardian to exact synthetic marker');
    assert.doesNotMatch(guardian.CommandLine!,/--job\s+Local\\Nexowire-/i,
      'unnamed guardian must never advertise a reopenable Job name');

    // The old named-Job attack cannot obtain a Job handle by querying a
    // guessed Local namespace name. This PowerShell test fixture only opens
    // JOB_OBJECT_QUERY. It neither writes host state nor kills any PID.
    const expectedName='Local\\Nexowire-'+randomUUID();
    const attempt=spawnSync('powershell.exe',[
      '-NoProfile','-NonInteractive','-File',
      'test/fixtures/windows-job-hold-query.ps1',expectedName
    ],{cwd:process.cwd(),encoding:'utf8',windowsHide:true,timeout:8_000});
    assert.notEqual(attempt.status,0,'unknown Job name must not open');

    const root=exactProcess(session.pid);
    assert.ok(root && root.Name.toLowerCase()==='powershell.exe');
    const currentGuardian=exactProcess(guardian.ProcessId);
    assert.equal(currentGuardian?.CreationDate,guardian.CreationDate);
    assert.ok(currentGuardian?.CommandLine?.includes(marker));
    const killed=spawnSync('taskkill.exe',['/PID',String(guardian.ProcessId),'/F'],
      {windowsHide:true,stdio:'ignore',timeout:5000});
    assert.equal(killed.status,0,'only the verified fixture guardian is terminated');
    for(let i=0;i<25;i++){
      if(!exactProcess(session.pid))break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(exactProcess(session.pid),undefined,
      'unnamed Job handle closure must reap root after guardian death');
  }finally{
    if(guardian && exactProcess(guardian.ProcessId)?.CreationDate===guardian.CreationDate &&
       exactProcess(guardian.ProcessId)?.CommandLine?.includes(marker)){
      spawnSync('taskkill.exe',['/PID',String(guardian.ProcessId),'/F'],
        {windowsHide:true,stdio:'ignore',timeout:5000});
    }
    await manager.stop({session_id:session.sessionId}).catch(()=>undefined);
  }
});
