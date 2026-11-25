import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  parseWindowsJobCompletion,validateWindowsJobRuntimeTimeout,
  launchWindowsJob,requestWindowsJobStop,type WindowsJobLaunch,
} from '../src/agent/windows-job-owner.js';

const proof={pid:1234,creationFiletime:'133900000000000001',guardianPid:4321,
  exitCode:0,signal:null};
const record=(reason:number,code:number)=>'NWJOB6 1234 133900000000000001 4321 '+reason+' '+code+'\n';

test('local Job terminal record requires exact root, guardian, protocol outcome and actual exit',()=>{
  assert.deepEqual(parseWindowsJobCompletion({...proof,raw:record(0,0)}),
    {state:'local_job_empty',reason:'natural',rootExitCode:0});
  for(const [reason,exitCode,label] of [[1,125,'stopped'],[2,124,'timeout'],[3,78,'owner_lost']] as const){
    assert.deepEqual(parseWindowsJobCompletion({...proof,exitCode,raw:record(reason,exitCode)}),
      {state:'local_job_empty',reason:label,rootExitCode:exitCode});
  }
  for(const invalid of [
    {...proof,raw:''}, {...proof,raw:record(0,0),pid:9876},
    {...proof,raw:record(0,0),guardianPid:9999},
    {...proof,raw:record(0,0),creationFiletime:'133900000000000002'},
    {...proof,raw:record(0,0),signal:'SIGTERM' as const},
    {...proof,raw:record(0,0),exitCode:512},
    {...proof,raw:record(1,125),exitCode:0},
    {...proof,raw:record(2,124),exitCode:null},
    {...proof,raw:record(0,4294967296),exitCode:1},
    {...proof,raw:record(0,0)+'extra'},
    {...proof,raw:record(4,0)},
  ])assert.deepEqual(parseWindowsJobCompletion(invalid),{state:'unknown'});
});

test('managed lifetime budget is explicit, bounded and rejects invalid numeric input',()=>{
  assert.equal(validateWindowsJobRuntimeTimeout(undefined),0);
  assert.equal(validateWindowsJobRuntimeTimeout(1),1);
  assert.equal(validateWindowsJobRuntimeTimeout(600000),600000);
  for(const invalid of [0,-1,1.5,NaN,Infinity,600001])
    assert.throws(()=>validateWindowsJobRuntimeTimeout(invalid),/Invalid native Job lifetime budget/);
});

test('canonical native guardian uses exact Job HANDLE cleanup and does not issue external authority',()=>{
  const native=readFileSync(new URL('../native/windows-job-owner.c',import.meta.url),'utf8');
  const owner=readFileSync(new URL('../src/agent/windows-job-owner.ts',import.meta.url),'utf8');
  const manager=readFileSync(new URL('../src/agent/process-manager.ts',import.meta.url),'utf8');
  const worker=readFileSync(new URL('../src/agent/process-worker.ts',import.meta.url),'utf8');
  const attestation=readFileSync(new URL('../src/agent/windows-job-kernel-attestation.ts',import.meta.url),'utf8');
  const cleanup=native.slice(native.indexOf('static BOOL terminate_and_observe_empty('),native.indexOf('static BOOL publish_managed_terminal('));
  assert.match(cleanup,/TerminateJobObject\(job,reason\)/);
  assert.match(cleanup,/QueryInformationJobObject\(job,JobObjectBasicAccountingInformation/);
  assert.match(cleanup,/a\.ActiveProcesses==0/);
  assert.match(cleanup,/GetTickCount64\(\)-start<5000/);
  assert.match(native,/PROC_THREAD_ATTRIBUTE_HANDLE_LIST/);
  assert.match(native,/childSession!=session/);
  assert.match(native,/WinLocalSystemSid/);
  assert.match(native,/EqualSid\(/);
  assert.match(native,/WaitForSingleObject\(pi\.hProcess,0\)==WAIT_OBJECT_0/);
  assert.match(native,/if\(!terminal\)return managed \? 512 : 77/);
  assert.match(attestation,/WINDOWS_JOB_KERNEL_GUARDIAN_IDENTITY_MISMATCH/);
  assert.match(attestation,/WINDOWS_JOB_KERNEL_ROOT_SESSION_MISMATCH/);
  assert.match(owner,/--lifecycle-v6/);
  assert.match(owner,/await verifyWindowsKernelJob\(/);
  const stop=owner.slice(owner.indexOf('export async function requestWindowsJobStop('));
  assert.doesNotMatch(stop,/\.kill\(|taskkill/);
  assert.match(manager,/await job\.completion/);
  assert.match(worker,/await job\.completion/);
  assert.match(worker,/unknown\?'orphaned':'exited'/);
  assert.doesNotMatch(owner,/TERMINAL_DRAINED|productionRollbackAuthorized:\s*true/);
});

const nativeWindowsOnly=process.platform!=='win32'?'Windows native Job required':false;
async function awaitTerminal(launch:WindowsJobLaunch){
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    return await Promise.race([
      launch.completion,
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('native completion missing')),12000);}),
    ]);
  }finally{if(timer)clearTimeout(timer);}
}

test('Windows managed native timeout observes empty Job including synthetic descendants',{
  skip:nativeWindowsOnly,timeout:30000,
},async()=>{
  const script="require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000);";
  const launch=await launchWindowsJob(process.execPath,['-e',script],{
    guardOnParentExit:true,runtimeTimeoutMs:1500,onOutput:()=>{},
  });
  try{
    const completion=await awaitTerminal(launch);
    assert.equal(completion.state,'local_job_empty');
    if(completion.state==='local_job_empty')assert.equal(completion.reason,'timeout');
    assert.equal(launch.child.exitCode,124);
  }finally{
    if(!launch.closed())await requestWindowsJobStop(launch);
  }
});

test('Windows cooperative stop observes empty Job without killing guardian by PID',{
  skip:nativeWindowsOnly,timeout:30000,
},async()=>{
  let ready!:()=>void;
  const marker=new Promise<void>(resolve=>{ready=resolve;});
  const script="require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log('NW_READY');setInterval(()=>{},1000);";
  const launch=await launchWindowsJob(process.execPath,['-e',script],{
    guardOnParentExit:true,runtimeTimeoutMs:10000,
    onOutput:(stream,chunk)=>{if(stream==='stdout'&&chunk.toString().includes('NW_READY'))ready();},
  });
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{
    await Promise.race([marker,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('fixture not ready')),5000);})]);
    assert.equal(await requestWindowsJobStop(launch),'requested');
    const completion=await awaitTerminal(launch);
    assert.equal(completion.state,'local_job_empty');
    if(completion.state==='local_job_empty')assert.equal(completion.reason,'stopped');
    assert.equal(launch.child.exitCode,125);
  }finally{
    if(timer)clearTimeout(timer);
    if(!launch.closed())await requestWindowsJobStop(launch);
  }
});
