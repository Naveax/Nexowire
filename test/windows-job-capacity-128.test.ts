import test from 'node:test';
import assert from 'node:assert/strict';
import {ProcessManager} from '../src/agent/process-manager.js';
import {PathPolicy} from '../src/agent/path-policy.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {performance} from 'node:perf_hooks';

const execFileAsync=promisify(execFile);

test('Windows physical 128-session retention/reclaim budget with owned Job guardians', {
  skip:process.platform!=='win32',
  timeout:180_000,
}, async () => {
  const manager=new ProcessManager({maxSessions:128,exitedRetentionMs:120_000});
  const policy=new PathPolicy(['*']);
  const ids:string[]=[];
  try{
    for(let group=0;group<16;group++){
      // Bounded parallelism avoids 128 simultaneous shells while still
      // checking the 128-slot retention accounting and native Job ownership.
      const wave=await Promise.all(Array.from({length:8},()=>manager.start({
        command:'exit /b 0',shell:'cmd',
      },policy)));
      for(const started of wave){
        assert.equal(started.treeOwnership,'windows_job');
        ids.push(started.sessionId);
      }
    }
    assert.equal(ids.length,128);
    assert.equal(manager.list().length,128);
    for(let attempt=0;attempt<50;attempt++){
      if(manager.list().every(x=>x.status==='exited'))break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(manager.list().every(x=>x.status==='exited'),'all 128 synthetic shells must exit');
    const replacement=await manager.start({command:'exit /b 0',shell:'cmd'},policy);
    assert.equal(replacement.treeOwnership,'windows_job');
    assert.equal(manager.list().length,128,'129th start must safely reclaim one exited slot');
    assert.equal(manager.list().some(x=>x.sessionId===replacement.sessionId),true);
    assert.equal(ids.filter(id=>manager.list().some(x=>x.sessionId===id)).length,127,
      'exactly one safely exited session must be reclaimed');
    const pruned=await manager.prune({older_than_ms:0});
    assert.ok(pruned.removed>0);
  } finally {
    await manager.shutdown();
  }
});


/**
 * Disposable Windows-only measurement. Compile the same seven Win32 P/Invokes
 * as the independent verifier in FRESH PowerShell 5.1 processes. Output
 * provides compilation latency and process-launch overhead separately.
 * No Job or root process is created by this compilation-only benchmark.
 */
test('Windows PowerShell Add-Type and Job start pressure diagnostics', {
  skip:process.platform!=='win32',
  timeout:100_000,
},async(t)=>{
  const systemRoot=process.env.SystemRoot;
  assert.ok(systemRoot&&/^[a-zA-Z]:\\Windows$/i.test(systemRoot),
    'benchmark must use the trusted system Windows PowerShell binary');
  const powershell=path.win32.join(systemRoot,'System32','WindowsPowerShell',
    'v1.0','powershell.exe');
  const script=[
    "$ErrorActionPreference='Stop'",
    "$watch=[Diagnostics.Stopwatch]::StartNew()",
    "Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class NXJobProbeBenchmark {',
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    '  public static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);',
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    '  public static extern IntPtr GetCurrentProcess();',
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    '  [return:MarshalAs(UnmanagedType.Bool)]',
    '  public static extern bool DuplicateHandle(IntPtr source,IntPtr handle,IntPtr target,out IntPtr duplicate,uint access,bool inherit,uint options);',
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    '  [return:MarshalAs(UnmanagedType.Bool)]',
    '  public static extern bool IsProcessInJob(IntPtr process,IntPtr job,[MarshalAs(UnmanagedType.Bool)]out bool inside);',
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    '  [return:MarshalAs(UnmanagedType.Bool)]',
    '  public static extern bool GetProcessTimes(IntPtr process,out long creation,out long exit,out long kernel,out long user);',
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    '  [return:MarshalAs(UnmanagedType.Bool)]',
    '  public static extern bool QueryInformationJobObject(IntPtr job,int info,IntPtr buf,uint length,IntPtr returned);',
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    '  [return:MarshalAs(UnmanagedType.Bool)]',
    '  public static extern bool CloseHandle(IntPtr handle);',
    '}',
    "'@",
    '$watch.Stop()',
    "[Console]::Out.WriteLine('NX_ADD_TYPE_MS='+$watch.Elapsed.TotalMilliseconds.ToString([Globalization.CultureInfo]::InvariantCulture))",
  ].join('\n');
  const encoded=Buffer.from(script,'utf16le').toString('base64');
  const policy=new PathPolicy(['*']);
  for(const concurrency of [1,4,8]){
    const compile=await Promise.all(Array.from({length:concurrency},async()=>{
      const start=performance.now();
      const {stdout}=await execFileAsync(powershell,
        ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded],
        {windowsHide:true,timeout:9000,maxBuffer:16384});
      const match=/^NX_ADD_TYPE_MS=([0-9]+(?:\.[0-9]+)?)$/m.exec(stdout.trim());
      assert.ok(match,'PowerShell must provide measured Add-Type compilation time');
      return {compileMs:Number(match[1]),totalMs:performance.now()-start};
    }));
    t.diagnostic('ADD_TYPE_MEASURE '+JSON.stringify({
      concurrency,
      compileMs:compile.map(x=>Math.round(x.compileMs)),
      processAndCompileMs:compile.map(x=>Math.round(x.totalMs)),
      definition:'PowerShell 5.1, fresh process, production-equivalent PInvoke declarations',
    }));

    // These ARE real kernel-attested native Job launches. Require every
    // Job proof and BOTH stream outputs, not merely an exit code or marker.
    const manager=new ProcessManager({maxSessions:concurrency,exitedRetentionMs:120_000});
    try {
      const launchStart=performance.now();
      const sessions=await Promise.all(Array.from({length:concurrency},(_,index)=>{
        const marker='NW_LOAD_'+concurrency+'_'+index;
        return manager.start({
          command:'echo '+marker+'_OUT & echo '+marker+'_ERR 1>&2',
          shell:'cmd',
        },policy).then(session=>({session,marker}));
      }));
      const launchMs=performance.now()-launchStart;
      for(const {session,marker} of sessions){
        assert.equal(session.treeOwnership,'windows_job');
        assert.equal(session.jobMembershipVerified,'root_at_launch');
        let stdout='',stderr='',cursor=0,status='running';
        for(let attempt=0;attempt<50;attempt++){
          const read=await manager.read({
            session_id:session.sessionId,after_seq:cursor,wait_ms:100,
          });
          cursor=read.nextSeq;
          status=read.session.status;
          for(const event of read.events){
            if(event.stream==='stdout')stdout+=event.text;
            else stderr+=event.text;
          }
          if(status==='exited')break;
        }
        assert.equal(status,'exited','verified Job root must exit');
        assert.ok(stdout.includes(marker+'_OUT'),'stdout lost at concurrency '+concurrency);
        assert.ok(stderr.includes(marker+'_ERR'),'stderr lost at concurrency '+concurrency);
      }
      t.diagnostic('JOB_START_MEASURE '+JSON.stringify({
        concurrency,wallMs:Math.round(launchMs),
        completeSessions:sessions.length,stdoutAndStderrVerified:true,
      }));
    } finally { await manager.stopAll().catch(()=>undefined);await manager.shutdown(); }
  }
});
