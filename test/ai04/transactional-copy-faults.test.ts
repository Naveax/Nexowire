/** AI-02: only disposable filesystem/SQLite fixtures, never the user profile. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {copyVerifiedDurableStateToEmptyStage}
  from '../../scripts/ai04-prepare-system-hub-state-copy.js';
import {captureLegacyHubStateSnapshotProof}
  from '../../scripts/ai04-state-snapshot-proof.js';

const windows=process.platform==='win32';
async function disposableSource(root:string):Promise<void>{
  await fs.mkdir(root);
  for(const [name,data] of Object.entries({
    'audit.jsonl':'{"event":"fixture"}\\n',
    'credentials.json':'{"token":"synthetic-fixture"}',
    'devices.json':'{"devices":[]}',
    'idempotency-records.json':'{}',
  }))await fs.writeFile(path.join(root,name),data);
  await fs.mkdir(path.join(root,'ai04-recovery-backups'));
  await fs.writeFile(path.join(root,'ai04-recovery-backups','synthetic.json'),'{}');
  const db=new DatabaseSync(path.join(root,'idempotency-records.sqlite'));
  try{
    db.exec('CREATE TABLE idempotency_records (key TEXT PRIMARY KEY)');
    db.prepare('INSERT INTO idempotency_records(key) VALUES (?)').run('first');
  }finally{db.close()}
}

for(const fault of [
  {code:'ENOSPC',message:'FI_DISK_FULL'},
  {code:'EACCES',message:'FI_TARGET_READONLY'},
] as const){
  test('injected '+fault.code+' during stage keeps original and partial evidence',
    {skip:!windows},async(t)=>{
      const home=await fs.mkdtemp(path.join(os.tmpdir(),'nx-ai02-io-'));
      t.after(()=>fs.rm(home,{recursive:true,force:true}));
      const source=path.join(home,'source'),stage=path.join(home,'stage');
      await disposableSource(source);await fs.mkdir(stage);
      const original=await captureLegacyHubStateSnapshotProof(source);
      await assert.rejects(()=>copyVerifiedDurableStateToEmptyStage(source,stage,{
        afterRootFilesCopied:async()=>{
          throw Object.assign(new Error(fault.message),{code:fault.code});
        },
      }),new RegExp(fault.message));
      const after=await captureLegacyHubStateSnapshotProof(source);
      assert.equal(after.treeSha256,original.treeSha256);
      assert.ok((await fs.readdir(stage)).includes('idempotency-records.sqlite'));
      // No implicit promotion or cleanup after I/O failure.
      assert.equal((await fs.readdir(home)).includes('hub-state'),false);
    });
}

test('checkpoint race between initial WAL copy and verification refuses stale stage',
  {skip:!windows},async(t)=>{
    const home=await fs.mkdtemp(path.join(os.tmpdir(),'nx-ai02-wal-race-'));
    t.after(()=>fs.rm(home,{recursive:true,force:true}));
    const source=path.join(home,'source'),stage=path.join(home,'stage');
    await disposableSource(source);await fs.mkdir(stage);
    const writer=new DatabaseSync(path.join(source,'idempotency-records.sqlite'));
    try{
      const mode=writer.prepare('PRAGMA journal_mode=WAL').get() as
        {journal_mode?:unknown};
      assert.equal(String(mode.journal_mode).toLowerCase(),'wal');
      writer.prepare('INSERT INTO idempotency_records(key) VALUES (?)').run('committed-in-wal');
      assert.ok((await fs.readdir(source)).includes('idempotency-records.sqlite-wal'));
      let injected=false;
      await assert.rejects(()=>copyVerifiedDurableStateToEmptyStage(source,stage,{
        afterRootFilesCopied:async()=>{
          // Only a synthetic writer against disposable database files.
          writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          injected=true;
        },
      }),/AI04_COPY_DURABLE_TREE_CHANGED_OR_MISMATCHED/);
      assert.equal(injected,true);
      assert.ok((await fs.readdir(stage)).includes('idempotency-records.sqlite'));
      assert.equal((await fs.readdir(home)).includes('hub-state'),false);
    }finally{writer.close()}
});

test('interrupted copy after backups leaves source and recovery artifacts untouched',
  {skip:!windows},async(t)=>{
    const home=await fs.mkdtemp(path.join(os.tmpdir(),'nx-ai02-crash-fi-'));
    t.after(()=>fs.rm(home,{recursive:true,force:true}));
    const source=path.join(home,'source'),stage=path.join(home,'stage');
    await disposableSource(source);await fs.mkdir(stage);
    const proof=await captureLegacyHubStateSnapshotProof(source);
    await assert.rejects(()=>copyVerifiedDurableStateToEmptyStage(source,stage,{
      afterRecoveryFilesCopied:async()=>{throw new Error('FI_CRASH_AFTER_COPY');},
    }),/FI_CRASH_AFTER_COPY/);
    assert.equal((await captureLegacyHubStateSnapshotProof(source)).treeSha256,
      proof.treeSha256);
    assert.equal(await fs.readFile(path.join(stage,'ai04-recovery-backups','synthetic.json'),'utf8'),'{}');
  });
