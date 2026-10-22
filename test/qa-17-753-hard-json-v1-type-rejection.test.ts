import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * QA17 strict gate for the real #753 wrong-type witness on #756.
 * This test MUST FAIL on the unpatched source when v1 "1" or true is accepted.
 * Source owner #03 must fix the shared JSON validator; no mock/skip/relaxation.
 * All fixture paths live under this job's disposable TEMP directory.
 */
const audit = path.resolve('scripts/audit-core-broker-protected-tree.ps1');
type Audit={
  requestInputKind:string;requestEnvelopeVersion:number;
  inspectedFilesCount:number;allInspectedPathsHaveAclEvidence:boolean;
  importListIndependentlyEnumerated:boolean;
  transitiveImportsIndependentlyEnumerated:boolean;
  signedImportManifestVerified:boolean;
  protectedCompleteImageTreeAttested:boolean;
  elevatedCoreDispatchEnabled:boolean;productionReady:boolean;
};
function envelope(root:string,launcher:string,updater:string,imported:string,version:unknown){
  return Buffer.from(JSON.stringify({
    version,protectedInstallRoot:root,launcherPath:launcher,
    updaterPath:updater,importedModulePaths:[imported],
  }),'utf8').toString('base64');
}
function run(args:string[]){
  const x=spawnSync('pwsh.exe',[
    '-NoLogo','-NoProfile','-NonInteractive','-File',audit,...args,
  ],{windowsHide:true,encoding:'utf8',timeout:20000,maxBuffer:128*1024});
  assert.equal(x.error,undefined,'read-only native PowerShell failed to launch');
  return {status:x.status,stdout:(x.stdout??'').trim(),stderr:x.stderr??''};
}
function denyProduction(report:Audit){
  assert.equal(report.productionReady,false,'fixture cannot be production Broker');
  assert.equal(report.elevatedCoreDispatchEnabled,false,'no elevated dispatch allowed');
  assert.equal(report.protectedCompleteImageTreeAttested,false);
  assert.equal(report.importListIndependentlyEnumerated,false);
  assert.equal(report.signedImportManifestVerified,false);
}
test('QA17 #753 strict JSON v1: typed number accepted; string and boolean REJECTED; legacy read-only stays compatible',{
  skip:process.platform!=='win32',timeout:120000,
},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-qa17-json-v1-hard-reject-'));
  t.after(async()=>fs.rm(root,{recursive:true,force:true}));
  const protectedRoot=path.join(root,'protected');
  const moduleDir=path.join(protectedRoot,'imports');
  const updaterDir=path.join(protectedRoot,'updater');
  await Promise.all([fs.mkdir(moduleDir,{recursive:true}),fs.mkdir(updaterDir,{recursive:true})]);
  const launcher=path.join(protectedRoot,'broker.exe');
  const updater=path.join(updaterDir,'updater.exe');
  const imported=path.join(moduleDir,'import.dll');
  for(const file of [launcher,updater,imported])
    await fs.writeFile(file,'DISPOSABLE UNSIGNED TEST BYTES NEVER EXECUTE');

  await t.test('actual JSON number 1 is accepted as read-only evidence only',()=>{
    const p=run(['-EvidenceRequestBase64',envelope(protectedRoot,launcher,updater,imported,1)]);
    assert.equal(p.status,0,p.stderr);
    const report=JSON.parse(p.stdout) as Audit;
    assert.equal(report.requestEnvelopeVersion,1);
    assert.equal(report.requestInputKind,'envelope-v1-readonly');
    assert.equal(report.inspectedFilesCount,3);
    assert.equal(report.allInspectedPathsHaveAclEvidence,true);
    denyProduction(report);
  });

  for(const [label,version] of [['string version "1"','1'],['boolean version true',true]] as const){
    await t.test(label+' must be rejected as BROKER_TREE_REQUEST_SCHEMA_INVALID',()=>{
      const p=run(['-EvidenceRequestBase64',
        envelope(protectedRoot,launcher,updater,imported,version)]);
      // Mandatory RED while #03 source still accepts wrong JSON type.
      // Never flip this to "expected success"; that would launder the bug.
      assert.notEqual(p.status,0,
        'SECURITY GAP: untyped JSON '+label+' was accepted; stdout='+p.stdout);
      assert.match(p.stderr+p.stdout,/BROKER_TREE_REQUEST_SCHEMA_INVALID/,
        'wrong JSON version type must fail exact strict v1 schema gate');
    });
  }

  await t.test('legacy named PowerShell flags remain read-only and fail closed',()=>{
    const p=run(['-ProtectedInstallRoot',protectedRoot,
      '-LauncherPath',launcher,'-UpdaterPath',updater,
      '-ImportedModulePaths',imported]);
    assert.equal(p.status,0,p.stderr);
    const r=JSON.parse(p.stdout) as Audit;
    assert.equal(r.requestInputKind,'legacy-named-readonly');
    assert.equal(r.requestEnvelopeVersion,1);
    assert.equal(r.inspectedFilesCount,3);
    denyProduction(r);
  });
});
