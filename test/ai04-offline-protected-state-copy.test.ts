import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {promises as fs,readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  copyVerifiedDurableStateToEmptyStage,
  prepareProtectedOfflineSystemHubStateCopy,
} from '../scripts/ai04-prepare-system-hub-state-copy.js';
import {captureLegacyHubStateSnapshotProof} from '../scripts/ai04-state-snapshot-proof.js';
import {captureHubStateDigestReadOnly} from '../src/hub/system-hub-state-cutover.js';

const windows=process.platform==='win32';
async function state(root:string,backup=true):Promise<void>{
  await fs.mkdir(root,{recursive:true});
  const values:Record<string,string>={
    'audit.jsonl':'{"event":"synthetic"}\n',
    'credentials.json':'{"records":[{"tokenHash":"synthetic-not-a-secret"}]}',
    'devices.json':'{"devices":[]}',
    'idempotency-records.json':'{}',
    ['workspace-'+('f'.repeat(64))+'.json']:'{"workspace":"fixture"}',
  };
  for(const [name,value] of Object.entries(values))
    await fs.writeFile(path.join(root,name),value);
  await fs.mkdir(path.join(root,'ai04-recovery-backups'));
  if(backup)await fs.writeFile(
    path.join(root,'ai04-recovery-backups','sample.json'),
    '{"snapshot":true}\n',
  );
  const db=new DatabaseSync(path.join(root,'idempotency-records.sqlite'));
  try{
    db.exec('CREATE TABLE idempotency_records(key TEXT PRIMARY KEY)');
    db.prepare('INSERT INTO idempotency_records(key) VALUES(?)').run('synthetic-id');
  }finally{db.close()}
}

test('offline copy preserves all durable files and backups without modifying original or issuing receipt',{
  skip:!windows,
},async(t)=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-ai04-stage-copy-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const source=path.join(parent,'source'),dest=path.join(parent,'staging');
  await state(source);
  await fs.mkdir(dest);
  const oldCredentials=await fs.readFile(path.join(source,'credentials.json'),'utf8');
  const order:string[]=[];
  const report=await copyVerifiedDurableStateToEmptyStage(source,dest,{
    afterRootFilesCopied:async()=>{order.push('top');},
    afterRecoveryDirectoryCreated:async()=>{order.push('backup-dir');},
    afterRecoveryFilesCopied:async()=>{order.push('backup-files');},
  });
  assert.deepEqual(order,['top','backup-dir','backup-files']);
  assert.equal(report.receiptIssued,false);
  assert.equal(report.readyForSystemCutover,false);
  assert.equal(report.recoveryDirectoryPresent,true);
  assert.equal(report.sqliteRecords,1);
  assert.equal(report.sourceRoot,source);
  assert.equal(report.stagingRoot,dest);
  assert.equal(await fs.readFile(path.join(source,'credentials.json'),'utf8'),oldCredentials);
  assert.equal(await fs.readFile(path.join(dest,'credentials.json'),'utf8'),oldCredentials);
  assert.equal(await fs.readFile(path.join(dest,'ai04-recovery-backups','sample.json'),'utf8'),
    '{"snapshot":true}\n');
  const src=await captureHubStateDigestReadOnly(source);
  const copied=await captureHubStateDigestReadOnly(dest);
  assert.equal(src.treeSha256,copied.treeSha256);
  assert.equal(src.fileCount,copied.fileCount);
  assert.equal(src.sqliteRecords,copied.sqliteRecords);
  assert.equal(report.durableTreeSha256,copied.treeSha256);
});

test('offline copy keeps a genuinely empty recovery directory in the staged tree',{
  skip:!windows,
},async(t)=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-ai04-empty-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const src=path.join(parent,'source'),out=path.join(parent,'out');
  await state(src,false);
  await fs.mkdir(out);
  const result=await copyVerifiedDurableStateToEmptyStage(src,out);
  assert.equal(result.recoveryDirectoryPresent,true);
  assert.deepEqual(await fs.readdir(path.join(out,'ai04-recovery-backups')),[]);
  assert.equal((await captureLegacyHubStateSnapshotProof(src)).treeSha256,
    (await captureLegacyHubStateSnapshotProof(out)).treeSha256);
});

test('nonempty destination never gets overwritten, including old recovery evidence',{
  skip:!windows,
},async(t)=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-ai04-existing-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const source=path.join(parent,'source'),out=path.join(parent,'out');
  await state(source);
  await fs.mkdir(out);
  await fs.writeFile(path.join(out,'existing-evidence.json'),'do-not-delete');
  await assert.rejects(()=>copyVerifiedDurableStateToEmptyStage(source,out),
    /AI04_COPY_TARGET_NOT_EMPTY/);
  assert.equal(await fs.readFile(path.join(out,'existing-evidence.json'),'utf8'),'do-not-delete');
});

test('source changed after staging starts is denied, staging preserved for reconciliation',{
  skip:!windows,
},async(t)=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-ai04-copy-race-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const source=path.join(parent,'source'),stage=path.join(parent,'stage');
  await state(source);
  await fs.mkdir(stage);
  await assert.rejects(()=>copyVerifiedDurableStateToEmptyStage(source,stage,{
    afterRootFilesCopied:async()=>{
      await fs.writeFile(path.join(source,'audit.jsonl'),'{"event":"mutated-between-pass"}\n');
    },
  }),/AI04_COPY_DURABLE_TREE_CHANGED_OR_MISMATCHED/);
  assert.equal(await fs.readFile(path.join(stage,'audit.jsonl'),'utf8'),
    '{"event":"synthetic"}\n');
  assert.equal((await fs.readdir(stage)).includes('credentials.json'),true);
});

test('linked source state is denied before any destination copy',{
  skip:!windows,
},async(t)=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-ai04-copy-link-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const source=path.join(parent,'source'),out=path.join(parent,'out');
  await state(source);
  await fs.mkdir(out);
  await fs.link(path.join(source,'audit.jsonl'),path.join(parent,'hardlink'));
  await assert.rejects(()=>copyVerifiedDurableStateToEmptyStage(source,out),
    /AI04_SOURCE_FILE_NOT_PLAIN|AI04_STATE_INVENTORY_UNTRUSTED/);
  assert.deepEqual(await fs.readdir(out),[]);
});

test('untrusted, nested or identical source-target paths fail without touching files',{
  skip:!windows,
},async(t)=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-ai04-copy-overlap-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const source=path.join(parent,'source');
  await state(source);
  await assert.rejects(()=>copyVerifiedDurableStateToEmptyStage(source,source),
    /AI04_COPY_SOURCE_TARGET_OVERLAP/);
  await assert.rejects(()=>copyVerifiedDurableStateToEmptyStage(
    source,path.join(source,'nested')),
    /AI04_COPY_SOURCE_TARGET_OVERLAP/);
  await assert.rejects(()=>copyVerifiedDurableStateToEmptyStage(
    'relative-source',path.join(parent,'dest')),
    /AI04_COPY_DIRECTORY_NONCANONICAL/);
});

test('disappearing empty recovery folder during copy is rejected even if file SHA tree is unchanged',{
  skip:!windows,
},async(t)=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-ai04-recovery-race-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const source=path.join(parent,'source'),stage=path.join(parent,'stage');
  await state(source,false);
  await fs.mkdir(stage);
  await assert.rejects(()=>copyVerifiedDurableStateToEmptyStage(source,stage,{
    afterRootFilesCopied:async()=>{
      await fs.rm(path.join(source,'ai04-recovery-backups'),{recursive:true});
    },
  }),/AI04_COPY_RECOVERY_DIRECTORY_CHANGED/);
});

test('production quiescence checks disabled interactive Hub task before and after writer and listener checks',()=>{
  const code=readFileSync(
    new URL('../scripts/ai04-prepare-system-hub-state-copy.ts',import.meta.url),
    'utf8',
  );
  const start=code.indexOf('async function ownerQuiescenceProof(');
  const part=code.slice(start,code.indexOf('async function readCanonicalLegacySource(',start));
  const preTask=part.indexOf('assertInteractiveHubTaskDisabledReadOnly()');
  const writer=part.indexOf('await assertNoSourceWriterReadOnly(source)');
  const listener=part.indexOf('assertLegacyHubPortNotListening(port)');
  const finalTask=part.lastIndexOf('assertInteractiveHubTaskDisabledReadOnly()');
  assert.ok(preTask>=0&&preTask<writer&&writer<listener&&listener<finalTask);
  assert.match(code,/Get-ScheduledTask -TaskName 'Nexowire Hub' -TaskPath/);
  assert.doesNotMatch(part,/Stop-ScheduledTask|Disable-ScheduledTask|Unregister-ScheduledTask/);
});

test('physical protected copy requires explicit approval before reading launcher or writing ProgramData',async()=>{
  await assert.rejects(()=>prepareProtectedOfflineSystemHubStateCopy(
    'C:\\missing\\not-a-launcher.ps1',false),
    /AI04_OWNER_APPROVAL_REQUIRED|AI04_WINDOWS_ONLY/);
});

test('production helper does not install tasks, decrypt secrets, change original Hub or issue receipt',()=>{
  const source=readFileSync(
    new URL('../scripts/ai04-prepare-system-hub-state-copy.ts',import.meta.url),
    'utf8',
  );
  const section=source.slice(source.indexOf('export async function prepareProtectedOfflineSystemHubStateCopy('));
  assert.match(section,/await assertTargetAndReceiptAbsent\(\)/);
  assert.match(section,/await ownerQuiescenceProof\(source,port\)/);
  assert.match(section,/fs\.rename\(stage,SYSTEM_STATE_ROOT\)/);
  assert.match(section,/receiptIssued:false,readyForSystemCutover:false/);
  assert.doesNotMatch(section,/Stop-ScheduledTask|Unregister-ScheduledTask|Start-ScheduledTask|readProtectedSecretFile|fs\.rm\(source/);
});
