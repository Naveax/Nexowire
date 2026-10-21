import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// QA19 independent forensic fixture. Original #700 RED tests remain intact.
// TEMP tree only; no services, VM, UAC or production ACL changes.
const windows=process.platform==='win32';
const auditPath=path.resolve('scripts/audit-core-broker-protected-tree.ps1');
const signerPath=path.resolve('scripts/audit-windows-job-helper-trust.ps1');
type Entry={path:string;isDirectory:boolean;evidenceAvailable:boolean;
 providerError:string;broadLowTrustWriteFound:boolean|null};
type Report={inputsInsideRoot:boolean;rejectedOutOfRootPaths:string[];
 requestedImportsCount:number;inspectedFilesCount:number;inspectedEntries:Entry[];
 allInspectedPathsHaveAclEvidence:boolean;anyInspectedPathUnsafe:boolean;
 importListIndependentlyEnumerated:boolean;signedImportManifestVerified:boolean;
 protectedCompleteImageTreeAttested:boolean;productionReady:boolean;
 elevatedCoreDispatchEnabled:boolean};
const quote=(s:string)=>"'"+s.replace(/'/g,"''")+"'";
function run(exe:string,args:string[],label:string) {
 const x=spawnSync(exe,args,{encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:1048576});
 assert.equal(x.error,undefined,label+': '+String(x.error));
 assert.equal(x.status,0,label+': '+(x.stderr??'').slice(0,2500));
 return (x.stdout??'').trim();
}
function invoke(script:string) {
 return run('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
  Buffer.from(script,'utf16le').toString('base64')],'independent PowerShell');
}
async function fixture(){
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'nx-qa19-tree-'));
 const root=path.join(temporary,'protected'),imports=path.join(root,'imports'),
  updates=path.join(root,'updater');
 await fs.mkdir(imports,{recursive:true});await fs.mkdir(updates,{recursive:true});
 const exe=path.join(root,'broker.exe'),imported=path.join(imports,'native.dll'),
  updater=path.join(updates,'updater.exe');
 for(const p of [exe,imported,updater]) await fs.writeFile(p,'TEST ONLY UNSIGNED NEVER EXECUTE');
 return {temporary,root,imports,updates,exe,imported,updater};
}
type F=Awaited<ReturnType<typeof fixture>>;
async function cleanup(f:F){await fs.rm(f.temporary,{force:true,recursive:true,maxRetries:5,retryDelay:100});}
function original(f:F):Report{
 return JSON.parse(run('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',
  auditPath,'-ProtectedInstallRoot',f.root,'-LauncherPath',f.exe,
  '-UpdaterPath',f.updater,'-ImportedModulePaths',f.imported],
  'actual #700 -File protected tree')) as Report;
}
function splatted(f:F):Report{
 const code=[
  "$ErrorActionPreference='Stop'",
  '$args=@{ProtectedInstallRoot='+quote(f.root)+';LauncherPath='+quote(f.exe)+
    ';UpdaterPath='+quote(f.updater)+';ImportedModulePaths=@('+quote(f.imported)+')}',
  '& '+quote(auditPath)+' @args',
 ].join('\n');
 return JSON.parse(invoke(code)) as Report;
}
type Native={present:{exe:boolean;imported:boolean;updater:boolean};
 aceCount:number;authenticatedUsersModify:boolean;parentAclProtected:boolean;
 ancestors:{path:string;available:boolean;unsafe:boolean;error:string}[]};
function osWitness(f:F):Native{
 const command=[
  "$ErrorActionPreference='Stop'",
  '$e='+quote(f.exe),'$i='+quote(f.imported),'$u='+quote(f.updater),
  '$d='+quote(f.imports),
  '$mask=[int64](0x2 -bor 0x4 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000)',
  "$low=@('S-1-1-0','S-1-5-11','S-1-5-32-545','S-1-5-4','S-1-5-7')",
  '$acl=[IO.FileSystemAclExtensions]::GetAccessControl([IO.DirectoryInfo]::new($d))',
  '$aces=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))',
  '$modify=$false',
  'foreach($a in $aces){if($a.AccessControlType -eq "Allow" -and $a.IdentityReference.Value -eq "S-1-5-11" -and (([int64]$a.FileSystemRights -band $mask) -ne 0)){$modify=$true}}',
  '$rows=@();$p=[IO.DirectoryInfo]::new($d)',
  'while($null -ne $p){',
  ' $avail=$false;$bad=$false;$err=""',
  ' try{$a=[IO.FileSystemAclExtensions]::GetAccessControl($p);$avail=$true',
  '  foreach($ace in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){',
  '   if($ace.AccessControlType -eq "Allow" -and ($ace.IdentityReference.Value -in $low) -and (([int64]$ace.FileSystemRights -band $mask) -ne 0)){$bad=$true}',
  '  }',
  ' }catch{$err=$_.Exception.GetType().Name}',
  ' $rows+=@{path=$p.FullName;available=$avail;unsafe=$bad;error=$err};$p=$p.Parent',
  '}',
  '[ordered]@{present=@{exe=[IO.File]::Exists($e);imported=[IO.File]::Exists($i);updater=[IO.File]::Exists($u)};',
  ' aceCount=$aces.Count;authenticatedUsersModify=$modify;parentAclProtected=[bool]$acl.AreAccessRulesProtected;',
  ' ancestors=@($rows)} | ConvertTo-Json -Compress -Depth 8',
 ].join('\n');
 return JSON.parse(invoke(command)) as Native;
}
function summary(f:F,a:Report,n:Native){
 const normal=(p:string)=>path.win32.normalize(p).toLowerCase();
 const names=new Set(a.inspectedEntries.map(e=>normal(e.path)));
 const absent=[f.exe,f.imported,f.updater,f.root,f.imports,f.updates].filter(p=>!names.has(normal(p)));
 let rootCause='PATHS_PRESENT';
 if(!n.present.exe || !n.present.imported || !n.present.updater)rootCause='MISSING_PHYSICAL_FIXTURE';
 else if(!a.inputsInsideRoot || a.rejectedOutOfRootPaths.length)rootCause='ROOT_OR_ARGUMENT_REJECTED';
 else if(absent.length)rootCause='PATH_ENUMERATION_OR_8_3_ALIAS';
 else if(!a.allInspectedPathsHaveAclEvidence)rootCause='ACL_PROVIDER_EVIDENCE_UNAVAILABLE';
 else if(n.authenticatedUsersModify && !a.anyInspectedPathUnsafe)rootCause='ACL_ACE_PARSER_MISMATCH';
 else if(n.ancestors.some(x=>x.available&&x.unsafe))rootCause='REAL_WRITABLE_ANCESTOR';
 return {rootCause,absent,requestedImports:a.requestedImportsCount,
  inspectedFiles:a.inspectedFilesCount,reportedPathCount:a.inspectedEntries.length,
  reportEntries:a.inspectedEntries,reportedRejected:a.rejectedOutOfRootPaths,
  nativeUnsafeAncestors:n.ancestors.filter(x=>x.available&&x.unsafe)};
}
function failClosed(x:Report){
 assert.equal(x.productionReady,false);
 assert.equal(x.elevatedCoreDispatchEnabled,false);
 assert.equal(x.importListIndependentlyEnumerated,false);
 assert.equal(x.signedImportManifestVerified,false);
 assert.equal(x.protectedCompleteImageTreeAttested,false);
}
test('QA19 real TEMP inherited Modify ACE versus #700 import/updater enumeration', {
 skip:!windows,timeout:40000,
},async()=>{
 const f=await fixture();
 try{
  run('icacls.exe',[f.imports,'/grant','*S-1-5-11:(OI)(CI)M'],'test-only TEMP Modify');
  const witness=osWitness(f);
  assert.deepEqual(witness.present,{exe:true,imported:true,updater:true});
  assert.ok(witness.aceCount>0,'independent native ACL must enumerate real ACEs');
  assert.equal(witness.authenticatedUsersModify,true,
   'real TEMP import parent Modify not witnessed by native NTFS');
  const actual=original(f);failClosed(actual);
  const result=summary(f,actual,witness);
  console.log('QA19_TREE_FORENSIC='+JSON.stringify(result));
  assert.notEqual(result.rootCause,'MISSING_PHYSICAL_FIXTURE');
  // Original #700 tests stay RED until #03 fixes enumeration.
  // Passing this diagnostic means root cause classified, NOT trust accepted.
 }finally{await cleanup(f);}
});
test('QA19 -File binding versus PowerShell hashtable-splatted parser', {
 skip:!windows,timeout:30000,
},async()=>{
 const f=await fixture();
 try{
  const witness=osWitness(f);assert.equal(witness.present.imported,true);
  const file=original(f),splat=splatted(f);
  failClosed(file);failClosed(splat);
  console.log('QA19_IMPORT_PARAMETER_DIFFERENTIAL='+JSON.stringify({
   file:summary(f,file,witness),splat:summary(f,splat,witness),
   sameFileCount:file.inspectedFilesCount===splat.inspectedFilesCount,
   sameImportCount:file.requestedImportsCount===splat.requestedImportsCount,
  }));
 }finally{await cleanup(f);}
});
test('QA19 native signer provider absent is UNAVAILABLE, never forged Valid', {
 skip:!windows,timeout:30000,
},async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-qa19-signer-'));
 try {
  const signed=path.join(process.env.SystemRoot??'C:\\Windows',
    'System32','WindowsPowerShell','v1.0','powershell.exe');
  const image=path.join(root,'windows-job-owner.exe');
  const bytes=await fs.readFile(signed);
  await fs.writeFile(image,bytes);
  const digest=createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(path.join(root,'windows-job-owner.sha256'),digest+'\n');
  const args=['-NoProfile','-NonInteractive','-File',signerPath,
   '-HelperPath',image,'-ExpectedReleaseSha256',digest];
  const original=JSON.parse(run('pwsh.exe',args,'real OS signed surrogate audit')) as {
   securityModuleAvailable:boolean;authenticodeStatus:string;publisherValid:boolean;
   productionReady:boolean};
  assert.equal(original.securityModuleAvailable,true);
  assert.equal(original.authenticodeStatus,'Valid');
  assert.equal(original.publisherValid,true);
  assert.equal(original.productionReady,false);
  // Test-only COPY of audit logic with a deliberately absent built-in module
  // manifest path. No OS module is removed and no provider is mocked green.
  const source=await fs.readFile(signerPath,'utf8');
  const marker='Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1';
  assert.equal(source.split(marker).length,2);
  const copy=path.join(root,'qa19-provider-absent.ps1');
  await fs.writeFile(copy,source.replace(marker,'Modules/QA19_NONEXISTENT_SECURITY_MODULE.psd1'));
  const absent=JSON.parse(run('pwsh.exe',[
   '-NoProfile','-NonInteractive','-File',copy,
   '-HelperPath',image,'-ExpectedReleaseSha256',digest],
   'test-only missing-provider source copy')) as {
    securityModuleAvailable:boolean;authenticodeStatus:string;
    authenticodeEvidenceAvailable:boolean;publisherValid:boolean;
    externallyPinnedReleaseSha256Matches:boolean;productionReady:boolean;
    provisionalFileTrustChecksPassed:boolean};
  assert.equal(absent.securityModuleAvailable,false);
  assert.equal(absent.authenticodeStatus,'UNAVAILABLE');
  assert.equal(absent.authenticodeEvidenceAvailable,false);
  assert.equal(absent.publisherValid,false);
  assert.equal(absent.externallyPinnedReleaseSha256Matches,true);
  assert.equal(absent.provisionalFileTrustChecksPassed,false);
  assert.equal(absent.productionReady,false);
  console.log('QA19_SIGNER_PROVENANCE='+JSON.stringify({
   real:original.authenticodeStatus,faultInjected:absent.authenticodeStatus,
   moduleOSUnchanged:true,productionReady:absent.productionReady,
  }));
 }finally{await fs.rm(root,{force:true,recursive:true});}
});
