import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {promises as fs, realpathSync, statSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';

// QA19 independent source/physical acceptance of #709. DO NOT edit #03
// protected-tree parser, original red regression tests, or any live service.
// Only uniquely named TEST-OWNED TEMP ACLs and synthetic (never-run) files.
const windows = process.platform === 'win32';
const audit = path.resolve('scripts/audit-core-broker-protected-tree.ps1');
const signer = path.resolve('scripts/audit-windows-job-helper-trust.ps1');
type Row = {
  path: string; isDirectory: boolean; evidenceAvailable: boolean;
  providerError: string; broadLowTrustWriteFound: boolean|null;
  reparsePointDetected: boolean|null;
};
type Tree = {
  kind: string; requestEnvelopeVersion: number;
  acceptedInputPaths: string[]; inputsInsideRoot: boolean;
  rejectedOutOfRootPaths: string[]; requestedImportsCount: number;
  inspectedFilesCount: number; inspectedEntries: Row[];
  allInspectedPathsHaveAclEvidence: boolean; anyInspectedPathUnsafe: boolean;
  importListIndependentlyEnumerated: boolean; signedImportManifestVerified: boolean;
  protectedCompleteImageTreeAttested: boolean;
  elevatedCoreDispatchEnabled: boolean; productionReady: boolean;
};
type F = {
  temp: string; root: string; exe: string; imported: string;
  importsDir: string; updater: string; updaterDir: string;
};
const psQuote = (s: string) => "'" + s.replace(/'/g, "''") + "'";
function raw(exe: string, args: string[], timeout = 18_000) {
  return spawnSync(exe, args, {encoding:'utf8', windowsHide:true, timeout, maxBuffer:1024*1024});
}
function success(exe:string,args:string[],tag:string) {
  const x=raw(exe,args);
  assert.equal(x.error,undefined,tag+': '+String(x.error));
  assert.equal(x.status,0,tag+': '+(x.stderr??'').slice(0,2400));
  return (x.stdout??'').trim();
}
function powershell(script: string) {
  return success('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive',
    '-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],'independent native witness');
}
function envelope(root:string,exe:string,updater:string,imports:string[]) {
  return Buffer.from(JSON.stringify({
    version:1,protectedInstallRoot:root,launcherPath:exe,
    updaterPath:updater,importedModulePaths:imports,
  }),'utf8').toString('base64');
}
function inspect(root:string,exe:string,updater:string,imports:string[]):Tree {
  const data=success('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive',
    '-File',audit,'-EvidenceRequestBase64',envelope(root,exe,updater,imports)],'real v2 protected-tree read-only audit');
  const x=JSON.parse(data) as Tree;
  assert.equal(x.kind,'windows_core_broker_protected_tree_readonly_v2');
  assert.equal(x.requestEnvelopeVersion,1);
  return x;
}
function denyRelease(x:Tree) {
  assert.equal(x.productionReady,false);
  assert.equal(x.elevatedCoreDispatchEnabled,false);
  assert.equal(x.importListIndependentlyEnumerated,false);
  assert.equal(x.signedImportManifestVerified,false);
  assert.equal(x.protectedCompleteImageTreeAttested,false);
}
async function fixture():Promise<F> {
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'nx-qa19-709-'));
  const root=path.join(temp,'protected');
  const importsDir=path.join(root,'imports'),updaterDir=path.join(root,'updater');
  await fs.mkdir(importsDir,{recursive:true});await fs.mkdir(updaterDir,{recursive:true});
  const exe=path.join(root,'broker.exe'),imported=path.join(importsDir,'native.dll'),
    updater=path.join(updaterDir,'updater.exe');
  for(const p of [exe,imported,updater])await fs.writeFile(p,'QA19 UNSIGNED FIXTURE NEVER EXECUTE');
  return {temp,root,importsDir,updaterDir,exe,imported,updater};
}
async function cleanup(f:F) {
  await fs.rm(f.temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
const canonical=(s:string)=>realpathSync.native(s).toLowerCase();
function isSameRealFile(first:string,second:string):boolean{
  const a=statSync(first,{bigint:true}),b=statSync(second,{bigint:true});
  return canonical(first)===canonical(second) &&
    a.dev===b.dev && a.ino===b.ino;
}
function osNativeParentAcl(dir:string) {
  const script=[
    "$ErrorActionPreference='Stop'",
    '$d='+psQuote(dir),
    '$acl=[IO.FileSystemAclExtensions]::GetAccessControl([IO.DirectoryInfo]::new($d))',
    '$aces=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))',
    '$unsafe=$false',
    '$mask=[int64](0x2 -bor 0x4 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000)',
    'foreach($ace in $aces){if($ace.AccessControlType -eq "Allow" -and ',
    '  $ace.IdentityReference.Value -eq "S-1-5-11" -and',
    '  (([int64]$ace.FileSystemRights -band $mask) -ne 0)){$unsafe=$true}}',
    '[ordered]@{aceCount=$aces.Count;unsafeAuModify=$unsafe;',
    ' providerAvailable=$true;path=[IO.DirectoryInfo]::new($d).FullName} | ConvertTo-Json -Compress',
  ].join('\n');
  return JSON.parse(powershell(script)) as {
    aceCount:number;unsafeAuModify:boolean;providerAvailable:boolean;path:string;
  };
}

test('QA19 #709 unchanged protected tree source enumerates real native file IDs, not RUNNER~1 spellings', {
 skip:!windows,timeout:35_000,
}, async()=>{
  const f=await fixture();
  try{
    const observed=inspect(f.root,f.exe,f.updater,[f.imported]);
    denyRelease(observed);
    assert.equal(observed.inputsInsideRoot,true);
    assert.equal(observed.acceptedInputPaths.length,4);
    assert.equal(observed.inspectedFilesCount,3);
    assert.equal(observed.requestedImportsCount,1);
    const wanted=[f.exe,f.imported,f.updater,f.root,f.importsDir,f.updaterDir];
    for(const p of wanted){
      const matches=observed.inspectedEntries.filter(row=>
        row.evidenceAvailable && isSameRealFile(row.path,p));
      assert.equal(matches.length,1,
        'required file/ancestor missing native identity '+p+
        '; observed='+JSON.stringify(observed.inspectedEntries));
    }
    const aliasInput=process.env.TEMP??os.tmpdir();
    const aliasOutput=realpathSync.native(aliasInput);
    console.log('QA19_709_PATH_IDENTITY='+JSON.stringify({
      inputTemporary:aliasInput,actualTemporary:aliasOutput,
      stringEquals:aliasInput.toLowerCase()===aliasOutput.toLowerCase(),
      realIdentityEqual:isSameRealFile(aliasInput,aliasOutput),
      counted:observed.inspectedFilesCount,accepted:observed.acceptedInputPaths.length,
      entries:observed.inspectedEntries.length,
    }));
  }finally{await cleanup(f);}
});

test('QA19 #709 real TEMP AU Modify evidence remains dangerous and full ancestor tree not approved', {
 skip:!windows,timeout:30_000,
},async()=>{
  const f=await fixture();
  try{
    success('icacls.exe',[f.importsDir,'/grant','*S-1-5-11:(OI)(CI)M'],'TEMP-only inherited Modify');
    const witness=osNativeParentAcl(f.importsDir);
    assert.equal(witness.providerAvailable,true);
    assert.ok(witness.aceCount>0,'physical native ACL provider returned no rules');
    assert.equal(witness.unsafeAuModify,true,'test-created dangerous parent ACL not present');
    const observed=inspect(f.root,f.exe,f.updater,[f.imported]);
    denyRelease(observed);
    const parent=observed.inspectedEntries.find(row=>isSameRealFile(row.path,f.importsDir));
    assert.ok(parent?.evidenceAvailable,'native ACL evidence unavailable for imported parent');
    assert.equal(parent!.broadLowTrustWriteFound,true,
      'unsafe inherited/write parent must not appear secure');
    assert.equal(observed.anyInspectedPathUnsafe,true);
    assert.equal(observed.allInspectedPathsHaveAclEvidence,true);
  }finally{await cleanup(f);}
});

test('QA19 #709 out-of-root and missing import remain fail-closed with real Windows identities', {
 skip:!windows,timeout:35_000,
},async()=>{
  const f=await fixture();
  try{
    const outside=path.join(f.temp,'outside-updater.exe');
    await fs.writeFile(outside,'TEST OWNED BAD UPDATER NEVER EXECUTE');
    const bad=inspect(f.root,f.exe,outside,[f.imported]);
    denyRelease(bad);
    assert.equal(bad.inputsInsideRoot,false);
    assert.ok(bad.rejectedOutOfRootPaths.some(p=>isSameRealFile(p,outside)),
      'out-of-root updater must be in rejected native file identity list');
    const missing=path.join(f.importsDir,'missing.dll');
    const absent=inspect(f.root,f.exe,f.updater,[missing]);
    denyRelease(absent);
    assert.equal(absent.allInspectedPathsHaveAclEvidence,false);
    const row=absent.inspectedEntries.find(x=>path.win32.basename(x.path).toLowerCase()==='missing.dll');
    assert.ok(row,'missing imported image must have explicit missing evidence');
    assert.equal(row!.evidenceAvailable,false);
    assert.equal(row!.broadLowTrustWriteFound,null,
      'unavailable ACL must be unknown, never no broad write');
  }finally{await cleanup(f);}
});

test('QA19 #709 strict request envelope cannot silently accept empty, malformed or injected imports', {
 skip:!windows,timeout:20_000,
},async()=>{
  const f=await fixture();
  try{
    const bads=[
      {version:1,protectedInstallRoot:f.root,launcherPath:f.exe,updaterPath:f.updater,importedModulePaths:[]},
      {version:1,protectedInstallRoot:f.root,launcherPath:f.exe,updaterPath:f.updater,importedModulePaths:['../relative.dll']},
      {version:1,protectedInstallRoot:f.root,launcherPath:f.exe,updaterPath:f.updater,importedModulePaths:[f.imported],productionReady:true},
    ];
    for(const payload of bads){
      const enc=Buffer.from(JSON.stringify(payload),'utf8').toString('base64');
      const x=raw('pwsh.exe',['-NoProfile','-NonInteractive','-File',audit,
        '-EvidenceRequestBase64',enc]);
      assert.notEqual(x.status,0,'malformed or injected import request must be rejected');
      assert.match((x.stdout??'')+(x.stderr??''),
        /BROKER_TREE_REQUEST_(SCHEMA|PATH)_INVALID/);
    }
  }finally{await cleanup(f);}
});

test('QA19 #709 absent native signature module returns UNAVAILABLE and never accepts loose hash', {
 skip:!windows,timeout:32_000,
},async()=>{
  const f=await fixture();
  try{
    const image=path.join(f.temp,'windows-job-owner.exe');
    const original=await fs.readFile(path.join(process.env.SystemRoot??'C:\\Windows',
      'System32','WindowsPowerShell','v1.0','powershell.exe'));
    await fs.writeFile(image,original);
    const digest=createHash('sha256').update(original).digest('hex');
    await fs.writeFile(path.join(f.temp,'windows-job-owner.sha256'),digest+'\n');
    const invoke=(script:string)=>{
      const body=success('pwsh.exe',['-NoProfile','-NonInteractive','-File',
        script,'-HelperPath',image,'-ExpectedReleaseSha256',digest],'signed surrogate audit');
      return JSON.parse(body) as {
        authenticodeStatus:string;securityModuleAvailable:boolean;
        publisherValid:boolean;productionReady:boolean;companionManifestMatches:boolean;
        provisionalFileTrustChecksPassed:boolean;
      };
    };
    const good=invoke(signer);
    assert.equal(good.securityModuleAvailable,true);
    assert.equal(good.authenticodeStatus,'Valid');
    assert.equal(good.publisherValid,true);
    assert.equal(good.productionReady,false);
    const content=await fs.readFile(signer,'utf8');
    const needle='Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1';
    assert.equal(content.split(needle).length,2,'native provider code unexpectedly changed');
    const copy=path.join(f.temp,'qa19-unavailable-provider-test-copy.ps1');
    await fs.writeFile(copy,content.replace(needle,'Modules/QA19_DELIBERATELY_MISSING_SECURITY_MODULE.psd1'));
    const absent=invoke(copy);
    assert.equal(absent.securityModuleAvailable,false);
    assert.equal(absent.authenticodeStatus,'UNAVAILABLE');
    assert.equal(absent.publisherValid,false);
    assert.equal(absent.companionManifestMatches,true);
    assert.equal(absent.provisionalFileTrustChecksPassed,false);
    assert.equal(absent.productionReady,false);
    // A *copy* of the read-only audit is fault-injected; native OS provider
    // remains installed. Never claim this is a physical module failure.
  }finally{await cleanup(f);}
});
