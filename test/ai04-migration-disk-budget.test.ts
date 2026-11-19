import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,promises as fs} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import {
  calculateProtectedMigrationDiskBudget,
  inspectProtectedMigrationDiskBudgetReadOnly,
  recoveryBackupBytesReadOnly,
} from '../scripts/ai04-offline-migration-integrity.js';

const gib=1024n*1024n*1024n;
const windows=process.platform==='win32';

test('disk budget protects 4 GiB system/SQLite reserve plus two whole state copies',()=>{
  const source=700n*1024n*1024n;
  const exact=4n*gib+source*2n;
  const ok=calculateProtectedMigrationDiskBudget(exact,source);
  assert.equal(ok.sufficient,true);
  assert.equal(ok.requiredBytes,exact.toString());
  assert.equal(ok.availableBytes,exact.toString());
  assert.equal(ok.readyForSystemCutover,false);
  const low=calculateProtectedMigrationDiskBudget(exact-1n,source);
  assert.equal(low.sufficient,false);
  assert.equal(low.readyForSystemCutover,false);
  assert.equal(calculateProtectedMigrationDiskBudget(0n,0n).sufficient,false);
  assert.throws(()=>calculateProtectedMigrationDiskBudget(-1n,1n),
    /AI04_DISK_BUDGET_INPUT_INVALID/);
  assert.throws(()=>calculateProtectedMigrationDiskBudget(1n,-1n),
    /AI04_DISK_BUDGET_INPUT_INVALID/);
});

test('disk preflight includes every nested recovery backup byte and rejects hardlinks',{
  skip:!windows,
},async(t)=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-ai04-recovery-budget-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const source=path.join(parent,'source');
  await fs.mkdir(source);
  for(const [name,content] of Object.entries({
    'audit.jsonl':'{"fixture":true}\n',
    'credentials.json':'{"records":[]}',
    'devices.json':'{"devices":[]}',
    'idempotency-records.json':'{}',
  }))await fs.writeFile(path.join(source,name),content);
  const db=new DatabaseSync(path.join(source,'idempotency-records.sqlite'));
  try{db.exec('CREATE TABLE idempotency_records(key TEXT PRIMARY KEY)')}
  finally{db.close()}
  const before=await inspectProtectedMigrationDiskBudgetReadOnly(source);
  const dir=path.join(source,'ai04-recovery-backups');
  await fs.mkdir(dir);
  const backup=path.join(dir,'large-recovery.json');
  const backupBytes=1024*1024;
  await fs.writeFile(backup,Buffer.alloc(backupBytes,7));
  assert.equal(await recoveryBackupBytesReadOnly(source),BigInt(backupBytes));
  const after=await inspectProtectedMigrationDiskBudgetReadOnly(source);
  assert.equal(
    BigInt(after.requiredBytes)-BigInt(before.requiredBytes),
    2n*BigInt(backupBytes),
  );
  await fs.link(backup,path.join(dir,'alias-hardlink.json'));
  await assert.rejects(()=>recoveryBackupBytesReadOnly(source),
    /AI04_RECOVERY_BACKUP_FILE_UNTRUSTED/);
});

test('physical protected audit refuses insufficient disk before reading destination snapshots',()=>{
  const text=readFileSync(
    new URL('../scripts/ai04-offline-migration-integrity.ts',import.meta.url),'utf8');
  const from=text.indexOf('export async function auditProtectedSystemHubCopyReadOnly(');
  const body=text.slice(from);
  assert.ok(from>=0);
  const parentAcl=body.indexOf('verifyWindowsPrivateAcl(path.win32.dirname(target))');
  const early=body.indexOf('const budget=await inspectProtectedMigrationDiskBudgetReadOnly(source)');
  const denial=body.indexOf('AI04_PROTECTED_TARGET_DISK_SPACE_INSUFFICIENT',early);
  const snapshot=body.indexOf('const baselineSource=await captureLegacyHubStateSnapshotProof(source)');
  const finalSource=body.indexOf('const finalSource=await captureLegacyHubStateSnapshotProof(source)');
  const late=body.indexOf('const finalBudget=await inspectProtectedMigrationDiskBudgetReadOnly(source)');
  const writer=body.indexOf('const writerAfter=await scanLegacyHubStateReadOnly(source)');
  assert.ok(parentAcl>=0&&parentAcl<early&&early<denial&&denial<snapshot);
  assert.ok(finalSource>snapshot&&late>finalSource&&writer>late);
});

test('Windows budget reads actual ProgramData volume without exposing state secrets',{
  skip:!windows,
},async(t)=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-ai04-disk-budget-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const src=path.join(parent,'source');
  await fs.mkdir(src);
  await fs.writeFile(path.join(src,'audit.jsonl'),'{"fixture":true}\n');
  await fs.writeFile(path.join(src,'devices.json'),'{"devices":[]}');
  await fs.writeFile(path.join(src,'credentials.json'),'{"tokens":[]}');
  await fs.writeFile(path.join(src,'idempotency-records.json'),'{}');
  const db=new DatabaseSync(path.join(src,'idempotency-records.sqlite'));
  try{db.exec('CREATE TABLE idempotency_records(key TEXT PRIMARY KEY)')}finally{db.close()}
  const budget=await inspectProtectedMigrationDiskBudgetReadOnly(src);
  assert.match(budget.availableBytes,/^\d+$/);
  assert.ok(BigInt(budget.availableBytes)>0n);
  assert.ok(BigInt(budget.requiredBytes)>=4n*gib);
  assert.equal(budget.readyForSystemCutover,false);
});
