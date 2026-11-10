import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {promises as fs,readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  auditProtectedSystemHubCopyReadOnly,
  assertStableOfflineCopyAcrossAudit,
  compareOfflineHubStateCopyReadOnly,
  protectedStateAclTargets,
} from '../scripts/ai04-offline-migration-integrity.js';
import {captureLegacyHubStateSnapshotProof} from '../scripts/ai04-state-snapshot-proof.js';

const windows=process.platform==='win32';
async function fixture(root:string):Promise<void>{
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'audit.jsonl'),'{"event":"synthetic"}\n');
  await fs.writeFile(path.join(root,'credentials.json'),'{"not_a_secret":"fixture"}');
  await fs.writeFile(path.join(root,'devices.json'),'{"devices":[]}');
  await fs.writeFile(path.join(root,'idempotency-records.json'),'{}');
  await fs.writeFile(path.join(root,'workspace-'+('b'.repeat(64))+'.json'),'{"test":true}');
  await fs.mkdir(path.join(root,'ai04-recovery-backups'));
  await fs.writeFile(path.join(root,'ai04-recovery-backups','backup.json'),'{"synthetic":true}');
  const db=new DatabaseSync(path.join(root,'idempotency-records.sqlite'));
  try{
    db.exec('CREATE TABLE idempotency_records(key TEXT PRIMARY KEY)');
    db.prepare('INSERT INTO idempotency_records(key) VALUES(?)').run('fixture');
  }finally{db.close()}
}

test('protected destination audit checks outer ancestors before and after file ACL and byte verification',()=>{
  const src=readFileSync(new URL('../scripts/ai04-offline-migration-integrity.ts',import.meta.url),'utf8');
  const begin=src.indexOf('export async function auditProtectedSystemHubCopyReadOnly(');
  assert.ok(begin>=0);
  const audit=src.slice(begin);
  const gates=[
    "verifyWindowsStackOuterAncestorAcl('C:\\\\');",
    "verifyWindowsStackOuterAncestorAcl('C:\\\\ProgramData');",
    'verifyWindowsPrivateAcl(path.win32.dirname(target));',
    'verifyWindowsPrivateAcl(target);',
    'for(const file of aclTargets)verifyWindowsPrivateAcl(file);',
    "verifyWindowsStackOuterAncestorAcl('C:\\\\');",
    "verifyWindowsStackOuterAncestorAcl('C:\\\\ProgramData');",
    'verifyWindowsPrivateAcl(path.win32.dirname(target));',
    'verifyWindowsPrivateAcl(target);',
    'const after=await compareOfflineHubStateCopyReadOnly(source,target);',
  ];
  let previous=-1;
  for(const gate of gates){
    const at=audit.indexOf(gate,previous+1);
    assert.ok(at>previous,'Missing or reordered ACL/bytes boundary: '+gate);
    previous=at;
  }
});

test('two matching source/destination passes still reject a common change between scans',{
  skip:!windows,
},async(t)=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-ai04-cross-pass-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const source=path.join(parent,'source'),target=path.join(parent,'target');
  await fixture(source);
  await fs.cp(source,target,{recursive:true});
  const originalSource=await captureLegacyHubStateSnapshotProof(source);
  const originalTarget=await captureLegacyHubStateSnapshotProof(target);
  assert.doesNotThrow(()=>assertStableOfflineCopyAcrossAudit(
    originalSource,originalTarget,originalSource,originalTarget,
  ));
  const updatedAudit='{"event":"changed-between-pass-pairs"}\\n';
  await fs.writeFile(path.join(source,'audit.jsonl'),updatedAudit);
  await fs.writeFile(path.join(target,'audit.jsonl'),updatedAudit);
  const finalSource=await captureLegacyHubStateSnapshotProof(source);
  const finalTarget=await captureLegacyHubStateSnapshotProof(target);
  assert.equal(finalSource.treeSha256,finalTarget.treeSha256);
  assert.notEqual(finalSource.treeSha256,originalSource.treeSha256);
  assert.throws(()=>assertStableOfflineCopyAcrossAudit(
    originalSource,originalTarget,finalSource,finalTarget,
  ),/AI04_MIGRATED_CONTENT_CHANGED_ACROSS_AUDIT_PASSES/);
  assert.throws(()=>assertStableOfflineCopyAcrossAudit(
    originalSource,originalTarget,finalSource,originalTarget,
  ),/AI04_MIGRATED_CONTENT_CHANGED_ACROSS_AUDIT_PASSES/);
});

test('physical protected audit checks cross-pass SHA trees before claiming even read-only completion',()=>{
  const sourceText=readFileSync(new URL('../scripts/ai04-offline-migration-integrity.ts',import.meta.url),'utf8');
  const start=sourceText.indexOf('export async function auditProtectedSystemHubCopyReadOnly(');
  const audit=sourceText.slice(start);
  const baseline=audit.indexOf('const baselineSource=await captureLegacyHubStateSnapshotProof(source)');
  const initial=audit.indexOf('const before=await compareOfflineHubStateCopyReadOnly(source,target)');
  const final=audit.indexOf('const finalSource=await captureLegacyHubStateSnapshotProof(source)');
  const guard=audit.indexOf('assertStableOfflineCopyAcrossAudit(');
  const owner=audit.indexOf('const writerAfter=await scanLegacyHubStateReadOnly(source)');
  assert.ok(baseline>=0&&baseline<initial&&initial<final&&final<guard&&guard<owner);
});

test('offline source and destination fingerprints match but never certify SYSTEM cutover',{
  skip:!windows,
},async(t)=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-ai04-acceptance-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const source=path.join(parent,'source'),destination=path.join(parent,'destination');
  await fixture(source);
  await fs.cp(source,destination,{recursive:true});
  const report=await compareOfflineHubStateCopyReadOnly(source,destination);
  assert.equal(report.contentIdentical,true);
  assert.equal(report.sourceFileCount,7);
  assert.equal(report.destinationFileCount,7);
  assert.equal(report.sourceSqliteRecords,1);
  assert.equal(report.destinationSqliteRecords,1);
  assert.deepEqual(report.differingPaths,[]);
  assert.equal(report.writerQuiescenceVerified,false);
  assert.equal(report.localMachineDpapiTransferVerified,false);
  assert.equal(report.protectedAclVerified,false);
  assert.equal(report.rebootRecoveryVerified,false);
  assert.equal(report.readyForSystemCutover,false);
  const proof=await captureLegacyHubStateSnapshotProof(destination);
  const targets=protectedStateAclTargets(proof);
  assert.ok(targets.includes(destination));
  assert.ok(targets.includes(path.dirname(destination)));
  assert.ok(targets.includes(path.join(destination,'idempotency-records.sqlite')));
  assert.ok(targets.includes(path.join(destination,'ai04-recovery-backups','backup.json')));
  assert.ok(targets.includes(path.join(destination,'ai04-recovery-backups')));
  assert.equal(new Set(targets).size,targets.length);
});

test('offline comparison identifies changed credential and removed recovery backup without claiming GO',{
  skip:!windows,
},async(t)=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-ai04-mismatch-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const source=path.join(parent,'source'),destination=path.join(parent,'destination');
  await fixture(source);
  await fs.cp(source,destination,{recursive:true});
  await fs.writeFile(path.join(destination,'credentials.json'),'{"not_a_secret":"changed"}');
  await fs.rm(path.join(destination,'ai04-recovery-backups','backup.json'));
  const result=await compareOfflineHubStateCopyReadOnly(source,destination);
  assert.equal(result.contentIdentical,false);
  assert.deepEqual(result.differingPaths,
    ['ai04-recovery-backups/backup.json','credentials.json']);
  assert.equal(result.readyForSystemCutover,false);
});

test('empty recovery directory is part of the offline migration shape',{
  skip:!windows,
},async(t)=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-ai04-empty-recovery-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const source=path.join(parent,'source'),destination=path.join(parent,'destination');
  await fixture(source);
  await fs.rm(path.join(source,'ai04-recovery-backups','backup.json'));
  await fs.cp(source,destination,{recursive:true});
  await fs.rm(path.join(destination,'ai04-recovery-backups'),{recursive:true});
  const result=await compareOfflineHubStateCopyReadOnly(source,destination);
  assert.equal(result.contentIdentical,false);
  assert.deepEqual(result.differingPaths,['ai04-recovery-backups/']);
  assert.equal(result.readyForSystemCutover,false);
});

test('read-only comparison refuses aliases, nested paths and symlinked state',{
  skip:!windows,
},async(t)=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-ai04-overlap-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const source=path.join(parent,'source');
  await fixture(source);
  await assert.rejects(()=>compareOfflineHubStateCopyReadOnly(source,source),
    /AI04_MIGRATION_SOURCE_DESTINATION_OVERLAP/);
  await assert.rejects(()=>compareOfflineHubStateCopyReadOnly(source,path.join(source,'inside')),
    /AI04_MIGRATION_SOURCE_DESTINATION_OVERLAP/);
  await assert.rejects(()=>compareOfflineHubStateCopyReadOnly('relative-state',path.join(parent,'dest')),
    /AI04_MIGRATION_ROOT_NONCANONICAL/);
});

test('ACL target list rejects traversal disguised as a migration file',{
  skip:!windows,
},async(t)=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-ai04-traversal-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  await fixture(parent);
  const proof=await captureLegacyHubStateSnapshotProof(parent);
  const injected={...proof,files:[...proof.files,{relativePath:'ai04-recovery-backups/../outside',bytes:5,sha256:'a'.repeat(64)}]};
  assert.throws(()=>protectedStateAclTargets(injected),/AI04_MIGRATION_RELATIVE_PATH_UNTRUSTED/);
});

test('live or missing migration cannot silently be presented as protected copy PASS',{
  skip:!windows,
},async()=>{
  await assert.rejects(()=>auditProtectedSystemHubCopyReadOnly(
    'C:\\NotARealUser\\missing\\.nexowire\\hub'),/ENOENT|HUB_STATE_/);
});
