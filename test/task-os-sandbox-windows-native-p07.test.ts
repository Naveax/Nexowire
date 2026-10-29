import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,writeFileSync,unlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {executeTaskWithOsSandbox} from '../src/agent/task-os-sandbox-worker.js';

const source=readFileSync(new URL('../native/task-os-sandbox-windows-appcontainer-probe-p07.c',import.meta.url),'utf8');
test('#07 Windows diagnostic uses real AppContainer token readback before resuming its fixed payload',()=>{
  for(const api of ['CreateAppContainerProfile','DeleteAppContainerProfile',
    'PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES','TokenIsAppContainer','TokenAppContainerSid',
    'TokenCapabilities','TokenIntegrityLevel','TokenPrivileges','TokenGroups','CREATE_SUSPENDED','AssignProcessToJobObject',
    'CreateRestrictedToken','DISABLE_MAX_PRIVILEGE','LUA_TOKEN','SE_GROUP_USE_FOR_DENY_ONLY','CreateProcessAsUserW',
    'TOKEN_ADJUST_DEFAULT','TOKEN_ASSIGN_PRIMARY','restricted_worker_integrity_lower',
    'CreateWindowStationW','CWF_CREATE_ONLY','CreateDesktopW','GetUserObjectInformationW','lpDesktop=desktopPath',
    'PROCESS_DUP_HANDLE','CREATE_BREAKAWAY_FROM_JOB','JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE',
    'JobObjectBasicProcessIdList','WSAEACCES','independent_descendant_readback'])assert.ok(source.includes(api),api);
  assert.ok(source.indexOf('independent_suspended_token_readback')<source.lastIndexOf('ResumeThread(child.hThread)'));
  assert.doesNotMatch(source,/\b(?:ShellExecute|CreateService|SwitchDesktop|SendInput|system|popen)\w*\s*\(/);
  assert.match(source,/productionWorkerInstalled/);assert.match(source,/NOT_PROVEN/);
  for(const field of ['tokenFailure','tokenAppContainer','tokenElevated','integrityRid','capabilityCount','packageMatches'])
    assert.ok(source.includes(field),field);
});

test('#07 a successful-looking AppContainer diagnostic cannot enable arbitrary production task execution',async()=>{
  await assert.rejects(executeTaskWithOsSandbox({capability:'shell.exec'},
    {kind:'windows_appcontainer_fixed_probe_v1',state:'OBSERVED',coreAuthority:true}),
    (e:unknown)=>!!e&&typeof e==='object'&&'code' in e&&e.code==='OS_TASK_SANDBOX_UNAVAILABLE');
});

test('#07 minimal Windows profile environment never inherits the parent process block',()=>{
  assert.match(source,/CreateEnvironmentBlock\(&block,token,FALSE\)/);
  assert.match(source,/DestroyEnvironmentBlock\(block\)/);
  assert.match(source,/L"APPDATA",L"LOCALAPPDATA",L"PATH",L"SystemDrive",L"SystemRoot"/);
  assert.match(source,/L"TEMP",L"TMP",L"USERPROFILE",L"windir"/);
  assert.match(source,/PATH=%ls\\\\System32/);
  assert.match(source,/NEXOWIRE_SANDBOX_PARENT_SECRET/);
  assert.doesNotMatch(source,/environment=\s*block/);
});

test('#07 real Windows AppContainer fixed-payload isolation, descendant and cleanup diagnostic',{
  skip:process.platform!=='win32'||process.env.NEXOWIRE_RUN_WINDOWS_APPCONTAINER_DIAGNOSTIC!=='1'
    ?'Disposable Windows AppContainer diagnostic not requested; production containment NOT_PROVEN':false,
  timeout:45000,
},t=>{
  const exe=fileURLToPath(new URL('../native/task-os-sandbox-windows-appcontainer-probe-p07.exe',import.meta.url));
  for(const args of [[],['--run','cmd.exe'],['--selftest-only'],['--grandchild-fixed'],['--selftest-only',os.tmpdir()]]){
    const denied=spawnSync(exe,args,{encoding:'utf8',timeout:3000,windowsHide:true});
    assert.ok(denied.status===64||denied.status===24,String(denied.error??denied.stderr));
    assert.equal(denied.stdout,'');
  }
  const root=mkdtempSync(path.join(os.tmpdir(),'nw07-appcontainer-ci-'));
  try{
    const sentinel=path.join(root,'pre-existing-guard.txt');writeFileSync(sentinel,'preserve-fixture');
    const oldRoot=spawnSync(exe,['--selftest-only',root],{encoding:'utf8',timeout:3000,windowsHide:true});
    assert.equal(oldRoot.status,64);assert.equal(oldRoot.stdout,'');
    assert.equal(readFileSync(sentinel,'utf8'),'preserve-fixture');unlinkSync(sentinel);
    const run=spawnSync(exe,['--selftest-only',root],{encoding:'utf8',timeout:35000,
      windowsHide:true,maxBuffer:8192});
    assert.ok(run.status===0||run.status===77,String(run.error??run.stderr)+' '+run.stdout);
    const report=JSON.parse(run.stdout) as Record<string,unknown>;
    assert.equal(report.kind,'windows_appcontainer_fixed_probe_v1');assert.equal(report.coreAuthority,false);
    assert.equal(report.productionWorkerInstalled,false);assert.equal(report.physicalAcceptance,'NOT_PROVEN');
    if(run.status===77){
      assert.equal(report.state,'UNAVAILABLE');
      t.skip('OS_DIAGNOSTIC_BLOCKED at '+String(report.stage)+' error '+String(report.win32Error));return;
    }
    assert.equal(report.state,'OBSERVED');assert.equal(report.workerExit,0);
    assert.equal(report.privateDesktopObserved,true);
    assert.equal(report.tokenAppContainer,1);assert.equal(report.tokenElevated,0);
    assert.equal(report.integrityRid,4096);assert.equal(report.capabilityCount,0);
    assert.equal(report.unexpectedEnabledPrivileges,0);
    assert.equal(report.unexpectedPrivileges,0);
    assert.ok(report.adminGroupMode===0||report.adminGroupMode===1);
    assert.equal(report.stage,'job_close_and_kernel_drain');
    t.diagnostic('FIXED_TEST_PAYLOAD_ONLY: token, private station/desktop, canary ACL, parent DUP_HANDLE, loopback, breakaway, descendant and Job-close checks; no production sandbox acceptance');
  }finally{rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
