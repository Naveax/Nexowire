import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  MACHINE_STARTUP_ADMISSION_PS,MACHINE_STARTUP_EVIDENCE_PS,
  assertOnlineMachineCutoverAdmission,
} from '../src/security/windows-machine-startup-admission.js';

test('online cutover admission is denied without an independent installed guard and forward authority',()=>{
  const attempt=assertOnlineMachineCutoverAdmission as (proof?:unknown)=>void;
  for(const fake of [undefined,true,{guarded:true,forwardAuthorized:true},
    {phase:'COMMITTED',targetRoot:'C:\\ProgramData\\Nexowire\\versions\\1.0.9-123456789abc'}]){
    assert.throws(()=>attempt(fake),/MACHINE_UPDATE_CANONICAL_STARTUP_AUTHORITY_REQUIRED/);
  }
});

test('startup probe has fixed protected paths and no state mutation or positive permit',()=>{
  const code=MACHINE_STARTUP_ADMISSION_PS.split(/\r?\n/).filter(l=>!l.trim().startsWith('#')).join('\n');
  assert.match(code,/Assert-NxStartupDirectoryTrust 'C:\\' \$true/);
  assert.match(code,/Assert-NxStartupDirectoryTrust 'C:\\ProgramData' \$true/);
  assert.match(code,/Assert-NxStartupEvidence 'C:\\ProgramData\\Nexowire'/);
  assert.match(code,/\[IO\.Directory\]::GetAccessControl/);
  assert.match(code,/\[IO\.Directory\]::GetFileSystemEntries/);
  assert.match(code,/GetTask\('Nexowire Hub Cutover Recovery'\)/);
  assert.match(code,/if\(-not \$nxRecoveryAbsent\)\{throw/);
  assert.doesNotMatch(code,/\b(?:Start|Stop|Enable|Disable|Register|Unregister)-ScheduledTask\b|Start-Process|Remove-Item|Set-Content|WriteAll|::Delete\(|::Exists\(|\bTest-Path\b/);
  assert.doesNotMatch(code,/\$env:/);
});

test('canonical Hub and Broker both check the same guard before process launch and installer mutation',()=>{
  const hub=readFileSync(new URL('../src/hub/hub-boot-lifecycle.ts',import.meta.url),'utf8');
  const broker=readFileSync(new URL('../src/agent/privileged-broker-lifecycle.ts',import.meta.url),'utf8');
  const update=readFileSync(new URL('../src/update/machine-update.ts',import.meta.url),'utf8');
  const hubBuilder=hub.slice(hub.indexOf('export function buildHubBootLauncher('));
  const brokerBuilder=broker.slice(broker.indexOf('export function buildPrivilegedBrokerLauncher('));
  for(const [builder,launch] of [[hubBuilder,'$process=Start-Process'],[brokerBuilder,"'& ' +"]] as const){
    assert.ok(builder.indexOf('MACHINE_STARTUP_ADMISSION_PS,')>=0);
    assert.ok(builder.indexOf('MACHINE_STARTUP_ADMISSION_PS,')<builder.indexOf(launch));
  }
  const install=hub.slice(hub.indexOf('export async function installHubBootLifecycle('));
  assert.ok(install.indexOf('assertMachineStartupStateReadOnly();')>=0);
  assert.ok(install.indexOf('assertMachineStartupStateReadOnly();')<install.indexOf('readProtectedSecretFile('));
  const brokerInstall=broker.slice(broker.indexOf('export async function installPrivilegedBrokerTask('));
  assert.ok(brokerInstall.indexOf('assertMachineStartupStateReadOnly();')>=0);
  assert.ok(brokerInstall.indexOf('assertMachineStartupStateReadOnly();')<brokerInstall.indexOf('await loadOrCreatePrivilegedBrokerToken('));
  const schedule=update.slice(update.indexOf('export async function scheduleOfficialMachineUpdate('));
  const deny=schedule.indexOf('assertOnlineMachineCutoverAdmission();');
  for(const effect of ['assertMachineUpdateTreeProtectedBeforeWrite();','await extractVerifiedRuntime(input)','await fs.mkdir','await fs.writeFile','const child = spawn(']){
    assert.ok(deny>=0&&schedule.indexOf(effect)>deny,effect);
  }
});

function runPS(script:string):string{
  // Fixture evaluates only functions with disposable paths, never the
  // production invocation, real COM scheduler, or privileged task actions.
  assert.doesNotMatch(script,/Schedule\.Service|GetTask\(|(?:Start|Stop|Enable|Disable|Register|Unregister)-ScheduledTask|Start-Process/);
  const result=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',[
    '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
    Buffer.from(script,'utf16le').toString('base64'),
  ],{
    encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:128*1024,
    env:{...process.env,SystemRoot:'C:\\Windows',windir:'C:\\Windows',
      PATH:'C:\\Windows\\System32;C:\\Windows',
      PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'},
  });
  assert.equal(result.error,undefined);
  assert.equal(result.signal,null);
  assert.equal(result.status,0,result.stderr||result.stdout);
  return result.stdout.trim();
}
const q=(s:string)=>"'"+s.replaceAll("'","''")+"'";

test('Windows exact evidence function denies fence, residual or unknown recovery and permits only clean observations',{
  skip:process.platform!=='win32',
},t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'nx-ai01-startup-admission-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const cases=[
    {name:'clean',accept:true,prepare:()=>{}},
    {name:'empty-update',accept:true,prepare:(p:string)=>mkdirSync(path.join(p,'update'))},
    {name:'v1-fence',accept:false,prepare:(p:string)=>{mkdirSync(path.join(p,'update'));writeFileSync(path.join(p,'update','machine-activation-fence.json'),'{"version":1,"targetRoot":"same"}')}},
    {name:'torn-fence',accept:false,prepare:(p:string)=>{mkdirSync(path.join(p,'update'));writeFileSync(path.join(p,'update','machine-activation-fence.json'),'')}},
    {name:'residual-succeeded-status',accept:false,prepare:(p:string)=>{mkdirSync(path.join(p,'update'));writeFileSync(path.join(p,'update','machine-status.json'),'{"state":"succeeded"}')}},
    {name:'residual-helper',accept:false,prepare:(p:string)=>{mkdirSync(path.join(p,'update'));writeFileSync(path.join(p,'update','apply-machine-fixture.ps1'),'fixture only')}},
    {name:'unknown-update-artifact',accept:false,prepare:(p:string)=>{mkdirSync(path.join(p,'update'));writeFileSync(path.join(p,'update','unknown'),'fixture')}},
    {name:'recovery-dir',accept:false,prepare:(p:string)=>mkdirSync(path.join(p,'hub-cutover-recovery'))},
    {name:'terminal-looking-recovery',accept:false,prepare:(p:string)=>{mkdirSync(path.join(p,'hub-cutover-recovery'));writeFileSync(path.join(p,'hub-cutover-recovery','journal.json'),'{"phase":"ROLLED_BACK"}')}},
    {name:'update-wrong-type',accept:false,prepare:(p:string)=>writeFileSync(path.join(p,'update'),'not a directory')},
    {name:'inaccessible-update',accept:false,prepare:(p:string)=>mkdirSync(path.join(p,'update'))},
    {name:'missing-root',accept:false,prepare:()=>{}},
  ];
  for(const c of cases){
    const fixture=path.join(root,c.name);
    if(c.name!=='missing-root'){mkdirSync(fixture);c.prepare(fixture);}
  }
  // Override only the OS ACL verifier on disposable fixture paths. Actual
  // evidence enumeration and denial logic is unchanged; no ACL PASS inferred.
  const fixtureTrust=String.raw`
function Assert-NxStartupDirectoryTrust([string]$directory,[bool]$outer){
  if($directory -like '*\inaccessible-update\update'){throw 'FIXTURE_ACCESS_DENIED'}
  $attributes=[IO.File]::GetAttributes($directory)
  if(($attributes -band [IO.FileAttributes]::Directory) -eq 0 -or
     ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'FIXTURE_TYPE_DENIED'}
}
`;
  const script=["$ErrorActionPreference='Stop'",MACHINE_STARTUP_EVIDENCE_PS,fixtureTrust,
    '$out=@()',
    ...cases.map(c=>"try{Assert-NxStartupEvidence "+q(path.join(root,c.name))+";$out+=('"+c.name+":ALLOW')}catch{$out+=('"+c.name+":DENY')}"),
    '$out -join [Environment]::NewLine',
  ].join('\n');
  assert.deepEqual(runPS(script).split(/\r?\n/),cases.map(c=>c.name+':'+(c.accept?'ALLOW':'DENY')));
});

test('Windows COM failure classifier accepts only the exact not-found HRESULT',{
  skip:process.platform!=='win32',
},()=>{
  const script=["$ErrorActionPreference='Stop'",MACHINE_STARTUP_EVIDENCE_PS,
    ...[-2147024894,-2147024891,-2147467259].map(code=>
      "Test-NxRecoveryTaskNotFound ([Exception]::new('wrapper',[Runtime.InteropServices.COMException]::new('fixture',"+code+")))"),
  ].join('\n');
  assert.deepEqual(runPS(script).split(/\r?\n/),['True','False','False']);
});
