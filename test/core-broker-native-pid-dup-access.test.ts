import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
type PidReport={
 inspectedFixturePid:number;nativeIdentityEvidenceAvailable:boolean;
 processCreationFiletime:string|null;nativeImagePath:string|null;
 actualProcessImagePathMatched:boolean;expectedCreationFiletimeMatched:boolean;
 processDupHandleOpenAccess:'ALLOW'|'DENIED'|string;
 inspectingCallerToken:{integrityRid:number|null;elevated:boolean|null;evidenceError:string;tokenIsIndependentOfInstalledBroker:true};
 actualKernelHandleWasDuplicated:false;installedBrokerProcessAttested:false;
 separateLowPrivilegeCallerBoundaryVerified:false;
 protectedJobHandleInheritanceAndDaclVerified:false;
 productionReady:false;elevatedDispatchEnabled:false;
};
const provider=path.resolve('scripts/audit-core-broker-fixture-pid-handle.ps1');
function probe(root:string,pid:number,marker:string,image:string,time=''):PidReport {
 const r=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',provider,
 '-FixtureRoot',root,'-TargetPid',String(pid),'-ExpectedMarker',marker,
 '-ExpectedImagePath',image,'-ExpectedCreationFiletime',time],
 {encoding:'utf8',windowsHide:true,timeout:16000,maxBuffer:16384});
 assert.equal(r.status,0,'read-only Win32 PID query: '+(r.stderr??'').slice(0,1800));
 return JSON.parse(r.stdout.trim()) as PidReport;
}
test('native synthetic PID+creation FILETIME and process DUP_HANDLE rights are observed but never signed Broker proof',{
 skip:process.platform!=='win32',timeout:50000,
},async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx03-own-process-'));
 const marker='NX03_FIXTURE_'+randomBytes(16).toString('hex');
 await fs.writeFile(path.join(root,'.nx03-test-owned-process'),marker);
 const imageCommand=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command',
  '[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName'],
  {encoding:'utf8',windowsHide:true,timeout:9000});
 assert.equal(imageCommand.status,0);
 const image=imageCommand.stdout.trim();
 assert.match(path.win32.basename(image),/^pwsh\.exe$/i);
 const child=spawn('pwsh.exe',['-NoProfile','-NonInteractive','-Command',
  "$null='"+marker+"'; Start-Sleep -Seconds 30"],{windowsHide:true,stdio:'ignore'});
 try{
  assert.ok(child.pid && child.pid!==process.pid);
  await new Promise(resolve=>setTimeout(resolve,500));
  const observed=probe(root,child.pid,marker,image);
  assert.equal(observed.nativeIdentityEvidenceAvailable,true);
  assert.match(observed.processCreationFiletime??'',/^[1-9][0-9]{10,19}$/);
  assert.equal(observed.actualProcessImagePathMatched,true);
  assert.equal(observed.expectedCreationFiletimeMatched,false,
    'without an external expected FILETIME, witness must not claim binding');
  assert.ok((observed.inspectingCallerToken.integrityRid??0)>=4096,
    'native token integrity must be known for the same caller that opens DUP_HANDLE');
  assert.equal(typeof observed.inspectingCallerToken.elevated,'boolean');
  assert.equal(observed.inspectingCallerToken.tokenIsIndependentOfInstalledBroker,true);
  assert.equal(observed.processDupHandleOpenAccess,'ALLOW',
   'same-user synthetic process proves PROCESS_DUP_HANDLE exposure, not protection');
  const exact=probe(root,child.pid,marker,image,observed.processCreationFiletime??'');
  assert.equal(exact.expectedCreationFiletimeMatched,true);
  const stale=probe(root,child.pid,marker,image,
    (BigInt(observed.processCreationFiletime??'0')+10_000_000n).toString());
  assert.equal(stale.expectedCreationFiletimeMatched,false);
  for(const evidence of [observed,exact,stale]){
   assert.equal(evidence.installedBrokerProcessAttested,false);
   assert.equal(evidence.separateLowPrivilegeCallerBoundaryVerified,false);
   assert.equal(evidence.protectedJobHandleInheritanceAndDaclVerified,false);
   assert.equal(evidence.actualKernelHandleWasDuplicated,false);
   assert.equal(evidence.productionReady,false);
   assert.equal(evidence.elevatedDispatchEnabled,false);
  }
 }finally{
  // Only this test-spawned, identity-known disposable pwsh process.
  child.kill();
  await fs.rm(root,{recursive:true,force:true});
 }
});
test('native PID provider rejects unrelated user/installed processes and missing fixture ownership',{
 skip:process.platform!=='win32',timeout:20000,
},async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx03-own-process-deny-'));
 try{
  const marker='NX03_FIXTURE_'+randomBytes(16).toString('hex');
  await fs.writeFile(path.join(root,'.nx03-test-owned-process'),marker);
  const r=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',provider,
   '-FixtureRoot',root,'-TargetPid',String(process.pid),'-ExpectedMarker',marker,
   '-ExpectedImagePath','C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'],
    {encoding:'utf8',windowsHide:true,timeout:9000});
  assert.notEqual(r.status,0);
  assert.match((r.stderr??'')+(r.stdout??''),/UNRELATED_PROCESS_NOT_INSPECTED|SYNTHETIC_POWERSHELL_ONLY/);
 }finally{await fs.rm(root,{recursive:true,force:true})}
});
