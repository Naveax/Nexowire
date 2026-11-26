import test from 'node:test';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {reviewScheduledAgentV6Evidence,scheduledAgentV6ForwardSigningBytes,scheduledAgentV6ReleaseSigningBytes,scheduledAgentV6ForwardEnvelopeSha256,type ScheduledAgentV6Forward,type ScheduledAgentV6Release,type ScheduledAgentV6ReviewInput} from '../src/agent/windows-scheduled-v6-evidence.js';
import assert from 'node:assert/strict';
import {readFileSync,existsSync,mkdtempSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {installNativeAgentLifecycle,startNativeAgentLifecycle,restartNativeAgentLifecycle} from '../src/agent/native-agent-lifecycle.js';
import {installStagedSystemAgentPrelogin} from '../src/agent/windows-prelogin-lifecycle.js';
import {
  parseWindowsJobCompletion,validateWindowsJobRuntimeTimeout,
  parseWindowsJobV6Assignment,assertSameWindowsJobHelperIdentity,
  launchWindowsJob,requestWindowsJobStop,assertScheduledAgentJobMigrationAdmission,type WindowsJobLaunch,
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
    {...proof,raw:record(0,0)+'\n'},
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
  assert.match(cleanup,/a\.ActiveProcesses==0 && rootWait==WAIT_OBJECT_0/);
  assert.match(cleanup,/WaitForSingleObject\(root,0\)/);
  assert.match(cleanup,/GetTickCount64\(\)-start<5000/);
  assert.match(native,/PROC_THREAD_ATTRIBUTE_HANDLE_LIST/);
  assert.match(native,/PROC_THREAD_ATTRIBUTE_JOB_LIST/);
  assert.match(native,/if\(!managed && !AssignProcessToJobObject\(job,pi.hProcess\)\)/);
  assert.match(native,/GetHandleInformation\(job,&jobHandleFlags\)/);
  const heldTerminal=native.indexOf('terminalFile=CreateFileW(terminalPath');
  const resume=native.indexOf('ResumeThread(pi.hThread)',heldTerminal);
  const publish=native.indexOf('publish_managed_terminal(terminalFile',resume);
  assert.ok(heldTerminal>=0&&heldTerminal<resume&&resume<publish);
  const preResumeStop=native.indexOf('empty=terminate_and_observe_empty(job,pi.hProcess,ownerLost?78:125)',heldTerminal);
  assert.ok(preResumeStop>heldTerminal&&preResumeStop<resume,'admitted early STOP must drain without resuming');
  assert.match(native,/FILE_ATTRIBUTE_NORMAL\|FILE_FLAG_OPEN_REPARSE_POINT/);
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
  let output='';
  const script="require('node:child_process').spawn(process.execPath,['-e',\"console.log('NW_CHILD_READY');setInterval(()=>{},1000)\"],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000);";
  const launch=await launchWindowsJob(process.execPath,['-e',script],{
    guardOnParentExit:true,runtimeTimeoutMs:5000,
    onOutput:(stream,chunk)=>{if(stream==='stdout')output+=chunk.toString();},
  });
  try{
    const completion=await awaitTerminal(launch);
    assert.equal(completion.state,'local_job_empty');
    if(completion.state==='local_job_empty')assert.equal(completion.reason,'timeout');
    assert.equal(launch.child.exitCode,124);
    assert.match(output,/NW_CHILD_READY/,'descendant itself must execute before timeout');
  }finally{
    if(!launch.closed())await requestWindowsJobStop(launch);
  }
});

test('Windows cooperative stop observes empty Job without killing guardian by PID',{
  skip:nativeWindowsOnly,timeout:30000,
},async()=>{
  let ready!:()=>void;
  const marker=new Promise<void>(resolve=>{ready=resolve;});
  const script="require('node:child_process').spawn(process.execPath,['-e',\"console.log('NW_CHILD_READY');setInterval(()=>{},1000)\"],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000);";
  const launch=await launchWindowsJob(process.execPath,['-e',script],{
    guardOnParentExit:true,runtimeTimeoutMs:10000,
    onOutput:(stream,chunk)=>{if(stream==='stdout'&&chunk.toString().includes('NW_CHILD_READY'))ready();},
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


test('Windows immediate STOP after admission observes the exact empty Job', {
  skip:nativeWindowsOnly,timeout:45000,
},async()=>{
  // No readiness delay: STOP may arrive before the guardian's first resume.
  // A real admitted long-running root must either be stopped while suspended
  // or stopped after resume, never be reported UNKNOWN merely for this race.
  for(let attempt=0;attempt<3;attempt++){
    const launch=await launchWindowsJob(process.execPath,['-e','setInterval(()=>{},1000)'],{
      guardOnParentExit:true,runtimeTimeoutMs:15000,
      onOutput:()=>{},
    });
    try{
      assert.equal(await requestWindowsJobStop(launch),'requested');
      assert.deepEqual(await awaitTerminal(launch),{
        state:'local_job_empty',reason:'stopped',rootExitCode:125,
      });
      assert.equal(launch.child.exitCode,125);
    }finally{
      if(!launch.closed())await requestWindowsJobStop(launch);
    }
  }
});

test('NWJOB3 historical receipts cannot authorize new scheduled Agent activation or task registration',async()=>{
  assert.throws(()=>assertScheduledAgentJobMigrationAdmission(),/NATIVE_AGENT_TASK_JOB_PROTOCOL_MIGRATION_REQUIRED/);
  const options={platform:'win32' as const,env:{NEXOWIRE_CORE_AUTHORITY_URL:'https://invalid.example.test'}};
  for(const call of [
    ()=>installNativeAgentLifecycle(options),
    ()=>startNativeAgentLifecycle(options),
    ()=>restartNativeAgentLifecycle(options),
    ()=>installStagedSystemAgentPrelogin(),
  ])await assert.rejects(call,/NATIVE_AGENT_TASK_JOB_PROTOCOL_MIGRATION_REQUIRED/);
  const task=readFileSync(new URL('../src/agent/native-agent-lifecycle.ts',import.meta.url),'utf8');
  const control=task.slice(task.indexOf('async function controlWindows('));
  assert.ok(control.indexOf("if(action!=='stop')assertScheduledAgentJobMigrationAdmission();")<
    control.indexOf('await windowsAgentTaskOwnerReadback(options)'));
  assert.match(task,/NWJOB3/,'historical receipt readback remains available');
});

test('Windows historical NWJOB3 argv fails before root creation without release handshake',{
  skip:nativeWindowsOnly,timeout:15000,
},()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'nx-legacy-job-denial-'));
  try{
    const marker=path.join(dir,'old.status'),effect=path.join(dir,'root-effect.txt');
    const rootScript="require('node:fs').writeFileSync(process.argv[1],'unexpected legacy activation')";
    const result=spawnSync(path.resolve('native/windows-job-owner.exe'),
      ['--status',marker,'--cwd','-','--parent',String(process.pid),'--',
        process.execPath,'-e',rootScript,effect],
      {shell:false,windowsHide:true,encoding:'utf8',timeout:5000,maxBuffer:8192});
    assert.equal(result.error,undefined);
    assert.equal(result.status,64);
    assert.match(result.stderr,/legacy_nwjob3_release_handshake_required/);
    assert.equal(existsSync(marker),false);
    assert.equal(existsSync(effect),false);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('v6 assignment decoder binds canonical numeric identity and excludes legacy or malformed records',()=>{
  const line='NWJOB6 1234 133900000000000001 128 133900000000000000 0\n';
  assert.deepEqual(parseWindowsJobV6Assignment(line),{pid:1234,
    creationFiletime:'133900000000000001',jobHandle:'128',
    guardianCreationFiletime:'133900000000000000',sessionId:0});
  for(const bad of [
    'NWJOB3 1234 133900000000000001','NWJOB5 1234 133900000000000001 128',
    line.replace('1234','4294967296'),line.replace('1234','01234'),
    line.replace(' 128 ',' 0 '),line.replace(' 0\n',' 4294967296\n'),
    line.replace('133900000000000000','133900000000000002'),
    line.replace('133900000000000001','9999999999999999999'),
    line+'\n',' '+line,line.replace(' 0\n',' 00\n'),
  ])assert.throws(()=>parseWindowsJobV6Assignment(bad),/Invalid v6 suspended-root identity/);
});

test('release refuses a jointly replaced helper and build manifest or a same-byte different file',()=>{
  const original={digest:'a'.repeat(64),signature:'1:2:100:4:5'};
  assert.doesNotThrow(()=>assertSameWindowsJobHelperIdentity(original,{...original}));
  assert.throws(()=>assertSameWindowsJobHelperIdentity(original,{...original,digest:'b'.repeat(64)}),
    /helper changed during suspended-root admission/);
  assert.throws(()=>assertSameWindowsJobHelperIdentity(original,{...original,signature:'1:3:100:4:5'}),
    /helper changed during suspended-root admission/);
  const owner=readFileSync(new URL('../src/agent/windows-job-owner.ts',import.meta.url),'utf8');
  const launch=owner.slice(owner.indexOf('export async function launchWindowsJob('));
  const initial=launch.indexOf('identity:initialHelperIdentity');
  const spawn=launch.indexOf('child = spawn(');
  const verify=launch.indexOf('await verifyWindowsKernelJob(');
  const compare=launch.indexOf('assertSameWindowsJobHelperIdentity(initialHelperIdentity');
  const release=launch.indexOf("await fs.writeFile(release,'verified'");
  assert.ok(initial>=0&&initial<spawn&&spawn<verify&&verify<compare&&compare<release);
});

test('prelogin installed identity review is explicitly non-authoritative and uses separate expected hashes',()=>{
  const source=readFileSync(new URL('../src/agent/windows-prelogin-lifecycle.ts',import.meta.url),'utf8');
  const review=source.slice(source.indexOf('export async function reviewSystemAgentV6InstalledIdentity('),
    source.indexOf('function assertWindowsElevation('));
  assert.match(review,/expected\.launcherSha256/);
  assert.match(review,/helper\.digest!==expected\.helperSha256/);
  assert.match(review,/handle\.stat\(\{bigint:true\}\)/);
  assert.match(review,/activationAuthorized:false,releaseAuthorized:false/);
  assert.doesNotMatch(review,/writeFile|spawn|Register-ScheduledTask|Enable-ScheduledTask/);
});

function bootBoundFixture(){
  const fk=generateKeyPairSync('ed25519'),rk=generateKeyPairSync('ed25519');
  const pin=(k:typeof fk)=>{const d=k.publicKey.export({format:'der',type:'spki'});
    return {encoded:d.toString('base64'),hash:createHash('sha256').update(d).digest('hex')};};
  const fp=pin(fk),rp=pin(rk),now=1795700000000;
  const observed:ScheduledAgentV6ReviewInput['observed']={
    deviceId:'11111111-1111-4111-8111-111111111111',
    installationId:'22222222-2222-4222-8222-222222222222',
    bootEpoch:'33333333-3333-4333-8333-333333333333',
    attemptId:'44444444-4444-4444-8444-444444444444',
    sourceCommit:'a'.repeat(40),fenceGeneration:3,fenceSha256:'b'.repeat(64),
    taskName:'Nexowire Prelogin Agent',taskDefinitionSha256:'c'.repeat(64),
    principalSid:'S-1-5-18',sessionId:0,runtimeManifestSha256:'d'.repeat(64),
    launcherSha256:'e'.repeat(64),helperSha256:'f'.repeat(64),
    launcherIdentity:'1:2:100:4:5',helperIdentity:'1:3:100:4:5',
  };
  const actual={rootPid:1000,rootCreationFiletime:'133900000000000001',
    guardianPid:999,guardianCreationFiletime:'133900000000000000',sessionId:0};
  const f:ScheduledAgentV6Forward={kind:'nexowire.scheduled-agent-v6.forward.v1',
    binding:observed,issuedAtMs:now-1000,expiresAtMs:now+10000};
  const forwardEnvelope={payload:f,signature:sign(null,scheduledAgentV6ForwardSigningBytes(f),fk.privateKey).toString('base64url')};
  const release:ScheduledAgentV6Release={kind:'nexowire.scheduled-agent-v6.release.v1',binding:observed,assignment:actual,
    forwardSha256:scheduledAgentV6ForwardEnvelopeSha256(forwardEnvelope),issuedAtMs:now-500,expiresAtMs:now+5000};
  const signRelease=(payload:ScheduledAgentV6Release)=>({payload,signature:sign(null,
    scheduledAgentV6ReleaseSigningBytes(payload),rk.privateKey).toString('base64url')});
  const input:ScheduledAgentV6ReviewInput={observed,observedAssignment:actual,nowMs:now,
    forwardEnvelope,releaseEnvelope:signRelease(release),forwardSpkiBase64:fp.encoded,forwardSpkiSha256:fp.hash,
    releaseSpkiBase64:rp.encoded,releaseSpkiSha256:rp.hash};
  return {input,release,signRelease,forwardEnvelope};
}

test('independent boot-bound forward and release signatures are reviewed but never grant activation',()=>{
  const {input}=bootBoundFixture();
  const result=reviewScheduledAgentV6Evidence(input);
  assert.equal(result.signaturesVerified,true);
  assert.equal(result.bindingMatched,true);
  assert.equal(result.activationAuthorized,false);
  assert.equal(result.releaseAuthorized,false);
  assert.equal(result.consumed,false);
});

test('reboot, attempt replay, changed installed bytes, task identity or fence reject old signed evidence',()=>{
  const {input}=bootBoundFixture();
  const changes:Partial<ScheduledAgentV6ReviewInput['observed']>[]=[
    {bootEpoch:'55555555-5555-4555-8555-555555555555'},
    {attemptId:'55555555-5555-4555-8555-555555555555'},
    {fenceGeneration:4},{fenceSha256:'9'.repeat(64)},
    {taskDefinitionSha256:'9'.repeat(64)},{launcherSha256:'9'.repeat(64)},
    {helperSha256:'9'.repeat(64)},{launcherIdentity:'1:9:100:4:5'},
    {helperIdentity:'1:9:100:4:5'},{sessionId:1},{principalSid:'S-1-5-19'},
  ];
  for(const change of changes)assert.throws(()=>reviewScheduledAgentV6Evidence({
    ...input,observed:{...input.observed,...change},
  }),/BOOT_OR_BINDING_MISMATCH/);
  assert.throws(()=>reviewScheduledAgentV6Evidence({...input,observedAssignment:{
    ...input.observedAssignment,guardianPid:998,
  }}),/ASSIGNMENT_MISMATCH/);
});

test('wrong key, swapped signature domain, stale lease and separately signed wrong forward chain fail closed',()=>{
  const {input,release,signRelease,forwardEnvelope}=bootBoundFixture();
  assert.throws(()=>reviewScheduledAgentV6Evidence({...input,
    releaseSpkiSha256:input.forwardSpkiSha256,releaseSpkiBase64:input.forwardSpkiBase64,
  }),/INDEPENDENT_SIGNERS_REQUIRED/);
  assert.throws(()=>reviewScheduledAgentV6Evidence({...input,releaseSpkiSha256:'0'.repeat(64)}),/SIGNER_PIN_MISMATCH/);
  assert.throws(()=>reviewScheduledAgentV6Evidence({...input,releaseEnvelope:{
    payload:release,signature:forwardEnvelope.signature,
  }}),/SIGNATURE_INVALID/);
  assert.throws(()=>reviewScheduledAgentV6Evidence({...input,nowMs:release.expiresAtMs}),/EXPIRED_OR_FUTURE/);
  assert.throws(()=>reviewScheduledAgentV6Evidence({...input,releaseEnvelope:signRelease({
    ...release,forwardSha256:'0'.repeat(64),
  })}),/FORWARD_CHAIN_MISMATCH/);
  assert.throws(()=>reviewScheduledAgentV6Evidence({...input,releaseEnvelope:undefined}));
});
