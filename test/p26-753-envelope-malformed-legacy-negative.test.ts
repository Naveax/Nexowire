import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Independent #26 only: parser SHAPE and legacy named-param preservation.
// No source change, ACL mutation, UAC, native importer or installed user files.
const windows = process.platform === 'win32';
const auditPath=path.resolve('scripts/audit-core-broker-protected-tree.ps1');
type Report={
  requestInputKind:string;
  requestEnvelopeVersion:number;
  inspectedFilesCount:number;
  importedModulePaths?:string[];
  signedImportManifestVerified:boolean;
  transitiveImportsIndependentlyEnumerated:boolean;
  nativeEffectiveLowPrivilegeAccessCheckCompleted:boolean;
  protectedCompleteImageTreeAttested:boolean;
  productionReady:boolean;
  elevatedCoreDispatchEnabled:boolean;
  [key:string]:unknown;
};
type Response={status:number|null;report:Report|null;stderr:string};
function run(extraArgs:string[]):Response {
  const p=spawnSync('pwsh.exe',[
    '-NoLogo','-NoProfile','-NonInteractive','-File',auditPath,...extraArgs,
  ],{encoding:'utf8',windowsHide:true,timeout:20000,maxBuffer:512*1024});
  assert.equal(p.error,undefined,'PowerShell launch must work');
  const status=p.status;
  return {status,report:status===0?JSON.parse((p.stdout??'').trim()) as Report:null,
    stderr:(p.stderr??'').slice(0,1000)};
}
const envelope=(json:string)=>run(['-EvidenceRequestBase64',
  Buffer.from(json,'utf8').toString('base64')]);
function assertReadOnly(result:Response,label:string,kind:string){
  assert.equal(result.status,0,label+': '+result.stderr);
  const r=result.report!;
  assert.equal(r.requestInputKind,kind,label);
  assert.equal(r.requestEnvelopeVersion,1,label);
  assert.equal(r.inspectedFilesCount,3,label);
  for(const name of [
    'signedImportManifestVerified','transitiveImportsIndependentlyEnumerated',
    'nativeEffectiveLowPrivilegeAccessCheckCompleted',
    'protectedCompleteImageTreeAttested','productionReady',
    'elevatedCoreDispatchEnabled',
  ] as const)assert.equal(r[name],false,label+' '+name);
}

test('W26/#743 malformed envelope ROOT and schema SHAPES deny; legacy -ProtectedInstallRoot still works', {
  skip:!windows,timeout:180000,
},async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'nw26-743-legacy-shapes-'));
  t.after(async()=>fs.rm(temp,{force:true,recursive:true}));
  const root=path.join(temp,'protected');
  const update=path.join(root,'updater'),imports=path.join(root,'imports');
  await fs.mkdir(update,{recursive:true});await fs.mkdir(imports,{recursive:true});
  const launcher=path.join(root,'broker.exe');
  const updater=path.join(update,'updater.exe');
  const imported=path.join(imports,'nested.dll');
  for(const f of [launcher,updater,imported])
    await fs.writeFile(f,'TEMP SYNTHETIC UNSIGNED: NOT EXECUTABLE');
  const valid={version:1,protectedInstallRoot:root,
    launcherPath:launcher,updaterPath:updater,importedModulePaths:[imported]};

  assertReadOnly(envelope(JSON.stringify(valid)),
    'canonical JSON numeric v1','envelope-v1-readonly');
  const legacy=run(['-ProtectedInstallRoot',root,
    '-LauncherPath',launcher,'-UpdaterPath',updater,
    '-ImportedModulePaths',imported]);
  assertReadOnly(legacy,'unchanged historical named switch','legacy-named-readonly');
  assert.deepEqual(legacy.report!.acceptedInputPaths,
    envelope(JSON.stringify(valid)).report!.acceptedInputPaths,
    'legacy and strict envelope must enumerate the same paths');

  // Distinct invalid document roots. In particular no null or list can be
  // interpreted as an authority-bearing object by ConvertFrom-Json.
  for(const [name,raw] of [
    ['null','null'],['boolean root','true'],['array root','[]'],
    ['integer root','42'],['quoted root','"literal"'],
    ['empty object','{}'],['truncated JSON','{"version":'],
  ] as const){
    const output=envelope(raw);
    assert.notEqual(output.status,0,
      'malformed envelope root wrongly accepted: '+name);
  }

  // Exact v1 document shape: unexpected/missing keys and non-array imported
  // modules must not silently become a trusted inspected import inventory.
  const invalid:ReadonlyArray<[string,object]>=[
    ['missing version',{protectedInstallRoot:root,launcherPath:launcher,
      updaterPath:updater,importedModulePaths:[imported]}],
    ['unknown key',{...valid,unexpectedAuthority:true}],
    ['extra case-confusable key',{...valid,Version:1}],
    ['extra nested metadata',{...valid,metadata:{trusted:true}}],
    ['missing imports',{version:1,protectedInstallRoot:root,
      launcherPath:launcher,updaterPath:updater}],
    ['scalar import',{...valid,importedModulePaths:imported}],
    ['null imports',{...valid,importedModulePaths:null}],
    ['object imports',{...valid,importedModulePaths:{0:imported}}],
    ['empty imports',{...valid,importedModulePaths:[]}],
    ['mixed-type imports',{...valid,importedModulePaths:[imported,42]}],
    ['null path',{...valid,launcherPath:null}],
  ];
  for(const [name,value] of invalid){
    const output=envelope(JSON.stringify(value));
    assert.notEqual(output.status,0,
      'invalid JSON field shape wrongly accepted: '+name);
  }

  // The legacy PowerShell interface is still mandatory, but missing one of
  // the required names must NOT fall into the envelope parameter set.
  const missingLegacy=run(['-ProtectedInstallRoot',root,
    '-LauncherPath',launcher,'-UpdaterPath',updater]);
  assert.notEqual(missingLegacy.status,0,
    'incomplete -ProtectedInstallRoot legacy call must fail closed');
});
