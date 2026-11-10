import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {promises as fs,readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertCanonicalHubStateSourcePath,
  assertHubStateReceiptBoundToLegacyLauncher,
  captureHubStateDigestReadOnly,
  SYSTEM_STATE_ROOT,
  SYSTEM_CUTOVER_RECEIPT,
  verifyProtectedSystemHubCutoverReadOnly,
} from '../src/hub/system-hub-state-cutover.js';
import {captureLegacyHubStateSnapshotProof} from '../scripts/ai04-state-snapshot-proof.js';
import {assertNoSourceWriterReadOnly} from '../src/hub/system-hub-state-cutover.js';
import {
  createSystemCutoverReceiptFromProof,
  issueOfflineSystemStateCutoverReceipt,
} from '../scripts/ai04-issue-system-state-receipt.js';

const windows=process.platform==='win32';
async function createState(root:string):Promise<void>{
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'audit.jsonl'),'{"t":"synthetic"}\n');
  await fs.writeFile(path.join(root,'credentials.json'),'{"tokens":[]}');
  await fs.writeFile(path.join(root,'devices.json'),'{"devices":[]}');
  await fs.writeFile(path.join(root,'idempotency-records.json'),'{}');
  await fs.writeFile(path.join(root,'workspace-'+('a'.repeat(64))+'.json'),'{"id":"a"}');
  await fs.mkdir(path.join(root,'ai04-recovery-backups'));
  await fs.writeFile(path.join(root,'ai04-recovery-backups','safe.json'),'{"backup":"yes"}');
  const db=new DatabaseSync(path.join(root,'idempotency-records.sqlite'));
  try{
    db.exec('CREATE TABLE idempotency_records(key TEXT PRIMARY KEY)');
    db.prepare('INSERT INTO idempotency_records(key) VALUES(?)').run('record');
  }finally{db.close()}
}

test('offline receipt issuer needs explicit owner approval even before inspecting a user launcher',async()=>{
  await assert.rejects(()=>issueOfflineSystemStateCutoverReceipt('C:\\\\non-existent',false),
    /AI04_OWNER_APPROVAL_REQUIRED|AI04_WINDOWS_ONLY/);
});

test('source writer witness rejects the same process and malformed owner',{
  skip:!windows,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-receipt-writer-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await createState(root);
  const db=new DatabaseSync(path.join(root,'idempotency-records.sqlite'));
  try{
    db.exec('CREATE TABLE idempotency_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
    db.prepare('INSERT INTO idempotency_meta(key,value) VALUES(?,?)')
      .run('hub_writer',JSON.stringify({host:os.hostname(),pid:process.pid,incarnation:'test'}));
  }finally{db.close()}
  await assert.rejects(()=>assertNoSourceWriterReadOnly(root),
    /HUB_BOOT_SOURCE_WRITER_STILL_RUNNING/);
});

test('offline issuer builds a strict source-and-target-bound receipt with no secret material',{
  skip:!windows,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-receipt-builder-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await createState(root);
  const proof=await captureHubStateDigestReadOnly(root);
  const receipt=createSystemCutoverReceiptFromProof(proof,{...proof,root:SYSTEM_STATE_ROOT});
  assert.equal(receipt.version,1);
  assert.equal(receipt.host,os.hostname());
  assert.equal(receipt.sourceRoot,root);
  assert.equal(receipt.destinationRoot,SYSTEM_STATE_ROOT);
  assert.equal(receipt.treeSha256,proof.treeSha256);
  assert.equal(JSON.stringify(receipt).includes('control-plane-service-token'),false);
  assert.throws(()=>createSystemCutoverReceiptFromProof(
    proof,{...proof,root:'C:\\\\Users\\\\Owner\\\\hub'}),
    /AI04_RECEIPT_DESTINATION_NOT_CANONICAL/);
  assert.throws(()=>createSystemCutoverReceiptFromProof(
    proof,{...proof,root:SYSTEM_STATE_ROOT,sqliteRecords:2}),
    /HUB_BOOT_MIGRATION_RECEIPT_CONTENT_MISMATCH/);
});

test('canonical source state path cannot be a protected SYSTEM target or Windows network alias',()=>{
  for(const bad of [undefined,'','relative','\\\\server\\share',
    'C:\\ProgramData\\Nexowire\\hub-state',
    'C:\\ProgramData\\Nexowire\\hub-state\\nested',
    'C:\\ProgramData\\Nexowire',
    'C:\\Users\\Owner\\.nexowire\\hub\\',
    'C:\\Users\\Owner\\.nexowire\\..\\hub']){
    assert.throws(()=>assertCanonicalHubStateSourcePath(bad),
      /HUB_BOOT_SOURCE_STATE_UNTRUSTED/);
  }
  assert.equal(
    assertCanonicalHubStateSourcePath('C:\\Users\\Owner\\.nexowire\\hub'),
    'C:\\Users\\Owner\\.nexowire\\hub');
});

test('source and target full-state digest matches independent AI-04 snapshot and strict receipt',{
  skip:!windows,
},async(t)=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-system-receipt-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const source=path.join(parent,'source'),target=path.join(parent,'target');
  await createState(source);
  await fs.cp(source,target,{recursive:true});
  const a=await captureHubStateDigestReadOnly(source);
  const b=await captureHubStateDigestReadOnly(target);
  const independent=await captureLegacyHubStateSnapshotProof(source);
  assert.equal(a.treeSha256,b.treeSha256);
  assert.equal(a.treeSha256,independent.treeSha256);
  assert.equal(a.fileCount,independent.fileCount);
  assert.equal(a.totalBytes,independent.totalBytes);
  assert.equal(a.sqliteRecords,1);
  assert.equal(a.recoveryDirectoryPresent,true);
  const receipt={
    version:1,host:os.hostname(),sourceRoot:source,destinationRoot:SYSTEM_STATE_ROOT,
    treeSha256:a.treeSha256,fileCount:a.fileCount,
    totalBytes:a.totalBytes,sqliteRecords:a.sqliteRecords,
    recoveryDirectoryPresent:a.recoveryDirectoryPresent,
  };
  const bound=assertHubStateReceiptBoundToLegacyLauncher(
    receipt,source,a,{...b,root:SYSTEM_STATE_ROOT});
  assert.equal(bound.sourceRoot,source);
  assert.equal(bound.destinationRoot,SYSTEM_STATE_ROOT);
  assert.throws(()=>assertHubStateReceiptBoundToLegacyLauncher(
    {...receipt,host:'forged-foreign-machine'},
    source,a,{...b,root:SYSTEM_STATE_ROOT}),
    /HUB_BOOT_MIGRATION_RECEIPT_HOST_MISMATCH/);
  assert.throws(()=>assertHubStateReceiptBoundToLegacyLauncher(
    {...receipt,sourceRoot:path.join(parent,'wrong')},
    source,a,{...b,root:SYSTEM_STATE_ROOT}),
    /HUB_BOOT_MIGRATION_RECEIPT_PATH_MISMATCH/);
  assert.throws(()=>assertHubStateReceiptBoundToLegacyLauncher(
    {...receipt,treeSha256:'f'.repeat(64)},
    source,a,{...b,root:SYSTEM_STATE_ROOT}),
    /HUB_BOOT_MIGRATION_RECEIPT_CONTENT_MISMATCH/);
  assert.throws(()=>assertHubStateReceiptBoundToLegacyLauncher(
    {...receipt,approved:true},
    source,a,{...b,root:SYSTEM_STATE_ROOT}),/unrecognized_keys|Unrecognized key|Unrecognized/);
  assert.throws(()=>assertHubStateReceiptBoundToLegacyLauncher(
    {...receipt,destinationRoot:'C:\\Users\\Owner\\.nexowire\\hub'},
    source,a,{...b,root:SYSTEM_STATE_ROOT}));
  await fs.writeFile(path.join(target,'audit.jsonl'),'{"t":"changed"}\n');
  const changed=await captureHubStateDigestReadOnly(target);
  assert.throws(()=>assertHubStateReceiptBoundToLegacyLauncher(
    receipt,source,a,{...changed,root:SYSTEM_STATE_ROOT}),
    /HUB_BOOT_MIGRATION_RECEIPT_CONTENT_MISMATCH/);
});

test('snapshot fails closed on added unknown file and hardlinked state',{
  skip:!windows,
},async(t)=>{
  const parent=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-system-alias-'));
  t.after(()=>fs.rm(parent,{recursive:true,force:true}));
  const root=path.join(parent,'source');
  await createState(root);
  await fs.writeFile(path.join(root,'unknown-secret.txt'),'extra');
  await assert.rejects(()=>captureHubStateDigestReadOnly(root),
    /HUB_BOOT_UNKNOWN_STATE_ENTRY/);
  await fs.rm(path.join(root,'unknown-secret.txt'));
  await fs.link(path.join(root,'audit.jsonl'),path.join(parent,'other-audit-link'));
  await assert.rejects(()=>captureHubStateDigestReadOnly(root),
    /HUB_BOOT_STATE_FILE_UNTRUSTED/);
});

test('production boot-install binds interactive source to protected target before unsealing service token',()=>{
  const code=readFileSync(new URL('../src/hub/hub-boot-lifecycle.ts',import.meta.url),'utf8');
  const start=code.indexOf('export async function installHubBootLifecycle(');
  const chunk=code.slice(start,code.indexOf('export async function uninstallHubBootLifecycle(',start));
  assert.ok(start>=0);
  const readOld=chunk.indexOf('parsePersistedHubLauncherEnvironment(');
  const verified=chunk.indexOf('await verifyProtectedSystemHubCutoverReadOnly(sourceEnv.NEXOWIRE_STATE_DIR');
  const stateGate=chunk.indexOf('assertProtectedSystemHubStateRoot(',readOld);
  const userToken=chunk.indexOf('readProtectedSecretFile(',verified);
  const taskMutation=chunk.indexOf('Register-ScheduledTask',verified);
  const override=chunk.indexOf('NEXOWIRE_STATE_DIR:protectedStateRoot',verified);
  const launcher=chunk.indexOf('buildHubBootLauncher({',verified);
  assert.ok(readOld>=0&&readOld<stateGate&&stateGate<verified);
  assert.ok(verified<userToken&&userToken<taskMutation);
  assert.ok(override>userToken&&override<launcher);
  assert.equal(code.includes('writeFile(currentLauncher'),false);
  assert.equal(SYSTEM_CUTOVER_RECEIPT,
    'C:\\ProgramData\\Nexowire\\hub-state-cutover.receipt.json');
});

test('SYSTEM receipt verifier checks actual ProgramData free space twice before successful return',()=>{
  const code=readFileSync(new URL('../src/hub/system-hub-state-cutover.ts',import.meta.url),'utf8');
  const begin=code.indexOf('export async function verifyProtectedSystemHubCutoverReadOnly(');
  const section=code.slice(begin);
  const receipt=section.indexOf('const raw=ReceiptSchema.parse(');
  const budgetA=section.indexOf('await assertProtectedTargetDiskBudget(raw.totalBytes)');
  const writer=section.indexOf('await assertNoSourceWriterReadOnly(source)');
  const digest=section.indexOf('const firstSource=await captureHubStateDigestReadOnly(source)');
  const budgetB=section.lastIndexOf('await assertProtectedTargetDiskBudget(raw.totalBytes)');
  const done=section.indexOf('return SYSTEM_STATE_ROOT');
  assert.ok(begin>=0&&receipt>=0&&receipt<budgetA&&budgetA<writer&&writer<digest);
  assert.ok(budgetB>digest&&budgetB<done);
  assert.match(code,/HUB_BOOT_SYSTEM_STATE_DISK_SPACE_INSUFFICIENT/);
});

test('current Work-PC has no implicitly accepted cutover receipt; verifier is read-only',{
  skip:!windows,
},async()=>{
  await assert.rejects(
    ()=>verifyProtectedSystemHubCutoverReadOnly(
      'C:\\Users\\Owner\\.nexowire\\hub'),
    /HUB_BOOT_|ENOENT|WINDOWS_|ACL|ENOENT|Windows/,
  );
});
