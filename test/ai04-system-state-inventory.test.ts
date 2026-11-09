import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {scanLegacyHubStateReadOnly} from '../scripts/ai04-system-state-inventory.js';

test('SYSTEM Hub source inventory rejects noncanonical, relative or remote state paths',async()=>{
  for(const input of ['', 'relative/state', 'C:\\Users\\Owner\\..\\Owner\\hub',
    '\\\\evil\\share\\hub']){
    await assert.rejects(()=>scanLegacyHubStateReadOnly(input),/HUB_STATE_SOURCE_NONCANONICAL/);
  }
});

test('AI-04 reads all fixture state without writes, retains honest P0 blockers',{
  skip:process.platform!=='win32',
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-ai04-inventory-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const data=new Map<string,Buffer>();
  for(const name of ['audit.jsonl','credentials.json','devices.json','idempotency-records.json']){
    const bytes=Buffer.from('{"synthetic":true}\n');
    await fs.writeFile(path.join(root,name),bytes);
    data.set(name,bytes);
  }
  const db=new DatabaseSync(path.join(root,'idempotency-records.sqlite'));
  try{
    db.exec('CREATE TABLE idempotency_records(key TEXT PRIMARY KEY);');
    db.prepare('INSERT INTO idempotency_records(key) VALUES(?)').run('fixture-record');
  }finally{db.close();}
  await fs.writeFile(path.join(root,'workspace-'+('a'.repeat(64))+'.json'),'{}');
  await fs.mkdir(path.join(root,'ai04-recovery-backups'));
  const before=new Map<string,string>();
  for(const name of data.keys()){
    before.set(name,createHash('sha256').update(await fs.readFile(path.join(root,name))).digest('hex'));
  }
  const report=await scanLegacyHubStateReadOnly(root);
  assert.equal(report.mode,'READ_ONLY');
  assert.equal(report.sqliteRecords,1);
  assert.equal(report.sqliteQuickCheck,'ok');
  assert.equal(report.rootFileCount,6);
  assert.equal(report.workspaceFileCount,1);
  assert.equal(report.requiredFilesMissing.length,0);
  assert.deepEqual(report.unexpectedEntries,[]);
  assert.deepEqual(report.rejectedLinkOrSpecialEntries,[]);
  assert.equal(report.nestedRecoveryBackupsPresent,true);
  assert.equal(report.readyForSystemCutover,false);
  assert.ok(report.blockers.includes('FULL_STATE_AND_DPAPI_MIGRATION_NOT_PERFORMED'));
  assert.ok(report.blockers.includes('REBOOT_AND_ROLLBACK_NOT_VERIFIED'));
  for(const [name,digest] of before){
    assert.equal(createHash('sha256').update(await fs.readFile(path.join(root,name))).digest('hex'),digest);
  }
});

test('AI-04 inventory refuses unknown content and hardlinks, never reports readiness',{
  skip:process.platform!=='win32',
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-ai04-inventory-negative-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const file of ['audit.jsonl','credentials.json','devices.json','idempotency-records.json']){
    await fs.writeFile(path.join(root,file),'{}');
  }
  const db=new DatabaseSync(path.join(root,'idempotency-records.sqlite'));
  try{db.exec('CREATE TABLE idempotency_records(key TEXT PRIMARY KEY)')}finally{db.close()}
  await fs.writeFile(path.join(root,'unexpected.txt'),'not migration-approved');
  await fs.link(path.join(root,'audit.jsonl'),path.join(root,'audit-hardlink.txt'));
  const report=await scanLegacyHubStateReadOnly(root);
  assert.equal(report.readyForSystemCutover,false);
  assert.ok(report.blockers.includes('UNRECOGNIZED_STATE_CONTENT'));
  assert.ok(report.blockers.includes('STATE_LINK_OR_HARDLINK_UNTRUSTED'));
  assert.ok(report.unexpectedEntries.includes('unexpected.txt'));
  assert.ok(report.rejectedLinkOrSpecialEntries.includes('audit-hardlink.txt'));
});
