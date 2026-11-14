import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const execFileAsync=promisify(execFile);
const script=resolve('scripts/diagnose-broker-compat.ps1');
const win=process.platform==='win32';

test('Broker compatibility diagnostic does not narrow UInt32 task results to Int32',async()=>{
  const source=await readFile(script,'utf8');
  assert.match(source,/\[long\]\$taskInfo\.LastTaskResult/);
  assert.match(source,/if \(\$null -ne \$taskInfo\.LastTaskResult\)/);
  assert.doesNotMatch(source,/\[int\]\$taskInfo\.LastTaskResult/);
  assert.doesNotMatch(source,/Start-ScheduledTask|Stop-ScheduledTask|Register-ScheduledTask/);
});

async function checkResult(value:number|null, options:{state?:'Running'|'Ready';multipleInstances?:'IgnoreNew'|'Queue'}={}):Promise<Record<string,unknown>>{
  const server=createServer((_req,res)=>{
    res.writeHead(401,{'content-type':'application/json'});
    res.end('{"ok":false}');
  });
  try{
    server.listen(0,'127.0.0.1');
    await once(server,'listening');
    const address=server.address();
    assert.ok(address&&typeof address!=='string');
    const escaped=script.replaceAll("'","''");
    const taskValue=value===null?'$null':'[uint32]'+value;
    const ps=[
      '$ErrorActionPreference="Stop"',
      '$ProgressPreference="SilentlyContinue"',
      "function Get-ScheduledTask { param([string]$TaskName) [pscustomobject]@{State='"+(options.state??'Running')+"';Settings=[pscustomobject]@{MultipleInstances='"+(options.multipleInstances??'IgnoreNew')+"'}} }",
      'function Get-ScheduledTaskInfo { param([string]$TaskName) [pscustomobject]@{LastTaskResult='+taskValue+'} }',
      "& '"+escaped+"' -Port "+address.port+" -StackPackageRoot '"+process.cwd().replaceAll("'","''")+"'",
    ].join('\r\n');
    const {stdout,stderr}=await execFileAsync('powershell.exe',[
      '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(ps,'utf16le').toString('base64'),
    ],{windowsHide:true,timeout:20000,maxBuffer:128*1024});
    assert.ok(!stderr.trim() || stderr.startsWith('#< CLIXML'),stderr);
    return JSON.parse(stdout) as Record<string,unknown>;
  }finally{
    await new Promise<void>((done)=>server.close(()=>done()));
  }
}

test('Broker 0x800710E0 is not benign without Running and IgnoreNew', {skip:!win},async()=>{
  for(const options of [{state:'Ready',multipleInstances:'IgnoreNew'},
    {state:'Running',multipleInstances:'Queue'}] as const){
    const report=await checkResult(0x800710e0,options);
    assert.equal(report.brokerTaskLastResultClassification,'TASK_FAILURE_OR_UNVERIFIED');
    assert.equal(report.privilegedHealthVerified,false);
  }
});

for(const [name,result] of [
  ['0',0],
  ['0x800710E0',0x800710e0],
  ['0xC000013A',0xc000013a],
  ['0xFFFFFFFF',0xffffffff],
  ['null',null],
] as const){
  test('Windows Broker result preserves '+name,{skip:!win},async()=>{
    const report=await checkResult(result);
    assert.equal(report.brokerTaskState,'Running');
    assert.equal(report.brokerTaskLastResult,result);
    assert.equal(report.brokerTaskMultipleInstances,'IgnoreNew');
    assert.equal(report.brokerTaskLastResultClassification,
      result===null?'NO_LAST_RESULT':result===0?'SUCCESS':
      result===0x800710e0?'POSSIBLE_IGNORE_NEW':'TASK_FAILURE_OR_UNVERIFIED');
    assert.equal(report.unauthenticatedHealthStatus,401);
    assert.equal(report.privilegedHealthVerified,false,
      'Task Scheduler/HTTP status cannot attest elevated Broker authority');
  });
}