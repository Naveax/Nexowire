import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  captureLegacyHubStateSnapshotProof,
  compareLegacyHubStateSnapshotProofs,
} from '../scripts/ai04-state-snapshot-proof.js';

const windows=process.platform==='win32';
async function fixture(root:string):Promise<void>{
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'audit.jsonl'),'{"operation":"fixture"}\n');
  await fs.writeFile(path.join(root,'credentials.json'),'{"synthetic_secret":"fixture-not-real"}');
  await fs.writeFile(path.join(root,'devices.json'),'{"devices":[]}');
  await fs.writeFile(path.join(root,'idempotency-records.json'),'{}');
  await fs.writeFile(path.join(root,'workspace-'+('a'.repeat(64))+'.json'),'{"test":true}');
  await fs.mkdir(path.join(root,'ai04-recovery-backups'));
  await fs.writeFile(path.join(root,'ai04-recovery-backups','backup-1.json'),'{"legacy":true}');
  const db=new DatabaseSync(path.join(root,'idempotency-records.sqlite'));
  try{
    db.exec('CREATE TABLE idempotency_records(key TEXT PRIMARY KEY)');
    db.prepare('INSERT INTO idempotency_records(key) VALUES(?)').run('one');
    db.prepare('INSERT INTO idempotency_records(key) VALUES(?)').run('two');
  }finally{db.close();}
}

test('snapshot proof hashes all legacy state and nested recovery backups without claiming release GO',{
  skip:!windows,
},async(t)=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-ai04-snapshot-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const root=path.join(parent,'source');
  await fixture(root);
  const proof=await captureLegacyHubStateSnapshotProof(root);
  assert.equal(proof.fileCount,7);
  assert.equal(proof.workspaceFileCount,1);
  assert.equal(proof.sqliteRecords,2);
  assert.equal(proof.sqliteQuickCheck,'ok');
  assert.match(proof.treeSha256,/^[a-f0-9]{64}$/);
  assert.equal(proof.readyForSystemCutover,false);
  assert.equal(proof.writerQuiescenceVerified,false);
  assert.equal(proof.dpapiScopeTransferVerified,false);
  assert.equal(proof.aclProtectedDestinationVerified,false);
  assert.ok(proof.files.some(x=>x.relativePath==='ai04-recovery-backups/backup-1.json'));
  assert.doesNotMatch(JSON.stringify({
    treeSha256:proof.treeSha256,files:proof.files.map(({relativePath,bytes})=>({relativePath,bytes})),
  }),/fixture-not-real/);
});

test('snapshot proof equality detects changed, removed or additional state files',{
  skip:!windows,
},async(t)=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-ai04-compare-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const source=path.join(parent,'source'),destination=path.join(parent,'destination');
  await fixture(source);
  await fs.cp(source,destination,{recursive:true});
  const a=await captureLegacyHubStateSnapshotProof(source);
  const b=await captureLegacyHubStateSnapshotProof(destination);
  assert.deepEqual(compareLegacyHubStateSnapshotProofs(a,b),{
    matches:true,differingPaths:[],readyForSystemCutover:false,
  });
  await fs.writeFile(path.join(destination,'audit.jsonl'),'{"tampered":true}');
  const changed=await captureLegacyHubStateSnapshotProof(destination);
  const mismatch=compareLegacyHubStateSnapshotProofs(a,changed);
  assert.equal(mismatch.matches,false);
  assert.deepEqual(mismatch.differingPaths,['audit.jsonl']);
  assert.equal(mismatch.readyForSystemCutover,false);
  await fs.rm(path.join(destination,'ai04-recovery-backups','backup-1.json'));
  const missing=await captureLegacyHubStateSnapshotProof(destination);
  assert.deepEqual(compareLegacyHubStateSnapshotProofs(a,missing).differingPaths,
    ['ai04-recovery-backups/backup-1.json','audit.jsonl']);
});

test('snapshot proof rejects linked or unrecognized entries before hashing',{
  skip:!windows,
},async(t)=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-ai04-linked-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  await fixture(parent);
  await fs.link(path.join(parent,'credentials.json'),path.join(parent,'unknown-hardlink.dat'));
  await assert.rejects(()=>captureLegacyHubStateSnapshotProof(parent),
    /AI04_STATE_INVENTORY_UNTRUSTED/);
});

test('snapshot proof rejects a nested backup directory instead of silently omitting it',{
  skip:!windows,
},async(t)=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-ai04-nested-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  await fixture(parent);
  await fs.mkdir(path.join(parent,'ai04-recovery-backups','nested'));
  await assert.rejects(()=>captureLegacyHubStateSnapshotProof(parent),
    /AI04_RECOVERY_ENTRY_NOT_REGULAR_FILE/);
});
