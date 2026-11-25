import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {
  coreRuntimeManifestBytes,coreRuntimeManifestSigningBytes,
  type CoreRuntimeManifest,type CoreRuntimeReleaseAnchor,
} from '../../src/security/core-runtime-package-manifest.js';
import {
  reviewSignedSqliteRollbackRuntime,reviewOfflineSignedSqliteRollback,
  type ReviewedSqliteRollbackRuntime,
} from '../../scripts/ai02-signed-sqlite-rollback-review.js';

import {collectOfflineRecoveryEvidence} from '../../scripts/ai02-offline-recovery-evidence.js';
import {captureLegacyHubStateSnapshotProof} from '../../scripts/ai04-state-snapshot-proof.js';

const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t:TestContext){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nx-ai02-signed-review-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const payload=path.join(root,'payload');await fs.mkdir(payload);
  const cli=Buffer.from('inert fixture, not executable Nexowire');
  await fs.writeFile(path.join(payload,'cli.js'),cli);
  const keys=generateKeyPairSync('ed25519');
  const der=keys.publicKey.export({format:'der',type:'spki'});
  const manifest:CoreRuntimeManifest={version:1,kind:'nexowire_core_runtime_manifest_v1',
    sourceRepository:'Naveax/Nexowire',sourceCommit:'a'.repeat(40),
    releaseVersion:'1.0.9-exp.0',releaseSequence:2,previousManifestSha256:'b'.repeat(64),
    entrypoint:'cli.js',files:[{path:'cli.js',sha256:sha(cli),bytes:cli.length}]};
  const raw=coreRuntimeManifestBytes(manifest);
  const pin:ReviewedSqliteRollbackRuntime={manifestSha256:sha(raw),sourceCommit:manifest.sourceCommit,
    releaseSequence:manifest.releaseSequence,reader:'sqlite-only',schemaVersion:1};
  const anchor:CoreRuntimeReleaseAnchor={authorityId:randomUUID(),publisherSpkiSha256:sha(der),
    acceptedSequence:pin.releaseSequence,acceptedManifestSha256:pin.manifestSha256};
  const candidate={payloadRoot:payload,manifestUtf8:raw,
    signatureBase64:sign(null,coreRuntimeManifestSigningBytes(manifest),keys.privateKey).toString('base64'),
    publisherSpkiBase64:der.toString('base64'),expectedSourceCommit:manifest.sourceCommit,
    expectedEntrypoint:manifest.entrypoint,authorityId:anchor.authorityId,
    readReleaseAnchor:async()=>({...anchor})};
  return {root,payload,pin,anchor,candidate};
}
test('reviewed signed SQLite runtime is an inspection, never rollback authorization',async t=>{
  const f=await fixture(t);
  const result=await reviewSignedSqliteRollbackRuntime(f.candidate,f.pin);
  assert.equal(result.reviewedSqliteOnlyPinMatches,true);
  assert.equal(result.rollbackAuthorized,false);
  assert.equal(result.releaseAnchorAdvanced,false);
  assert.equal(result.productionCore,'NO_GO');
  assert.equal(result.runtimeInstalled,false);
});
test('signature without independently matching SQLite-only pin is insufficient',async t=>{
  const f=await fixture(t);
  for(const pin of [
    {...f.pin,reader:'json-only'}, {...f.pin,schemaVersion:2},
    {...f.pin,sourceCommit:'c'.repeat(40)}, {...f.pin,manifestSha256:'d'.repeat(64)},
  ]){
    await assert.rejects(reviewSignedSqliteRollbackRuntime(f.candidate,pin as ReviewedSqliteRollbackRuntime),
      /AI02_SIGNED_SQLITE_ROLLBACK_(RUNTIME_REVIEW_REQUIRED|RUNTIME_PIN_MISMATCH)/);
  }
  await assert.rejects(reviewSignedSqliteRollbackRuntime({...f.candidate,
    signatureBase64:Buffer.alloc(64).toString('base64')},f.pin),
    /CORE_RELEASE_NEXOWIRE_MANIFEST_SIGNATURE_REQUIRED/);
});
test('rollback inspection rejects a next, previous or unavailable anchor',async t=>{
  const f=await fixture(t);
  for(const anchor of [
    {...f.anchor,acceptedSequence:1,acceptedManifestSha256:'b'.repeat(64)},
    {...f.anchor,acceptedSequence:3,acceptedManifestSha256:'c'.repeat(64)},
    {...f.anchor,acceptedManifestSha256:'d'.repeat(64)},
  ]){
    await assert.rejects(reviewSignedSqliteRollbackRuntime({...f.candidate,
      readReleaseAnchor:async()=>anchor},f.pin),/CORE_RELEASE_ANCHOR_UNAVAILABLE/);
  }
});
test('candidate file mutation and a changing anchor cannot pass inspection',async t=>{
  const f=await fixture(t);
  let reads=0;
  await assert.rejects(reviewSignedSqliteRollbackRuntime({...f.candidate,
    readReleaseAnchor:async()=>++reads===1?f.anchor:{...f.anchor,acceptedSequence:3}},
    f.pin),/CORE_RELEASE_ANCHOR_UNAVAILABLE/);
  await fs.writeFile(path.join(f.payload,'cli.js'),'changed');
  await assert.rejects(reviewSignedSqliteRollbackRuntime(f.candidate,f.pin),
    /CORE_RELEASE_PAYLOAD_DIGEST_MISMATCH/);
});
test('offline Windows review retains current SQLite records and refuses a stale snapshot',
  {skip:process.platform!=='win32'},async t=>{
    const f=await fixture(t);
    const current=path.join(f.root,'current'),preserved=path.join(f.root,'preserved');
    await fs.mkdir(current);
    for(const name of ['audit.jsonl','credentials.json','devices.json','idempotency-records.json'])
      await fs.writeFile(path.join(current,name),'{}');
    const ledger=path.join(current,'idempotency-records.sqlite');
    const db=new DatabaseSync(ledger);
    try{
      db.exec("CREATE TABLE idempotency_records(key TEXT PRIMARY KEY); INSERT INTO idempotency_records VALUES('known'); CREATE TABLE idempotency_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO idempotency_meta VALUES('schema_version','1')");
    }finally{db.close()}
    await fs.cp(current,preserved,{recursive:true});
    const options={candidate:f.candidate,reviewedRuntime:f.pin,currentOfflineRoot:current,preservedOfflineRoot:preserved};
    const before=sha(await fs.readFile(ledger));
    const result=await reviewOfflineSignedSqliteRollback(options);
    assert.equal(result.offlineDurableStateMatches,true);
    assert.equal(result.sqliteRecords,1);
    assert.equal(result.productionRollbackAuthorized,false);
    assert.equal(result.releaseGate,'MISSING');
    assert.equal(sha(await fs.readFile(ledger)),before);
    const writer=new DatabaseSync(ledger);
    try{writer.exec("INSERT INTO idempotency_records VALUES('unknown')")}finally{writer.close()}
    const after=sha(await fs.readFile(ledger));
    await assert.rejects(reviewOfflineSignedSqliteRollback(options),
      /AI02_SIGNED_SQLITE_ROLLBACK_CURRENT_LEDGER_NOT_PRESERVED/);
    assert.equal(sha(await fs.readFile(ledger)),after);
    assert.equal(sha(await fs.readFile(path.join(preserved,'idempotency-records.sqlite'))),before);
  });

test('offline coordinated uninstall requires a terminal transaction receipt before state access',async t=>{
  const f=await fixture(t);
  const input={candidate:f.candidate,reviewedRuntime:f.pin,
    currentOfflineRoot:path.join(f.root,'never-open-current'),
    preservedOfflineRoot:path.join(f.root,'never-open-preserved'),
    approved:{treeSha256:'a'.repeat(64),sqliteRecords:0,runtimeManifestSha256:f.pin.manifestSha256},
    purpose:'coordinated-uninstall-review' as const};
  await assert.rejects(collectOfflineRecoveryEvidence(input),/TERMINAL_RECEIPT_REQUIRED/);
  const expected={version:1 as const,host:'fixture-host',marker:'fixture-marker',
    sourceRoot:'fixture-source',launcherPath:'fixture-launcher',launcherSha256:'b'.repeat(64),
    port:43110,originalUserPrincipal:'fixture-user',createdAt:'2026-11-25T00:00:00.000Z'};
  await assert.rejects(collectOfflineRecoveryEvidence({...input,terminalReceipt:{
    expected,bytes:Buffer.from(JSON.stringify({...expected,phase:'SYSTEM_STARTED'})),
  }}),/AI04_ROLLBACK_DURABLE_CONFIRMATION_MISSING/);
  await assert.rejects(collectOfflineRecoveryEvidence({...input,terminalReceipt:{
    expected,bytes:Buffer.from(JSON.stringify({...expected,marker:'other',phase:'ROLLED_BACK'})),
  }}),/AI04_ROLLBACK_DURABLE_CONFIRMATION_MISSING/);
});

test('Windows offline recovery evidence requires fixed approved state and never grants uninstall or rollback',
  {skip:process.platform!=='win32'},async t=>{
    const f=await fixture(t);
    const current=path.join(f.root,'current'),preserved=path.join(f.root,'preserved');
    await fs.mkdir(current);
    for(const name of ['audit.jsonl','credentials.json','devices.json','idempotency-records.json'])
      await fs.writeFile(path.join(current,name),'{}');
    const ledger=path.join(current,'idempotency-records.sqlite');
    const db=new DatabaseSync(ledger);
    try{
      db.exec("CREATE TABLE idempotency_records(key TEXT PRIMARY KEY,status TEXT); INSERT INTO idempotency_records VALUES('known','succeeded'); CREATE TABLE idempotency_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO idempotency_meta VALUES('schema_version','1')");
    }finally{db.close()}
    await fs.cp(current,preserved,{recursive:true});
    const original=await captureLegacyHubStateSnapshotProof(current);
    const expected={version:1 as const,host:'fixture-host',marker:'fixture-marker',
      sourceRoot:'fixture-source',launcherPath:'fixture-launcher',launcherSha256:'b'.repeat(64),
      port:43110,originalUserPrincipal:'fixture-user',createdAt:'2026-11-25T00:00:00.000Z'};
    const input={candidate:f.candidate,reviewedRuntime:f.pin,currentOfflineRoot:current,
      preservedOfflineRoot:preserved,approved:{treeSha256:original.treeSha256,
        sqliteRecords:original.sqliteRecords,runtimeManifestSha256:f.pin.manifestSha256},
      purpose:'coordinated-uninstall-review' as const,
      terminalReceipt:{expected,bytes:Buffer.from(JSON.stringify({...expected,phase:'ROLLED_BACK'}))}};
    const before=sha(await fs.readFile(ledger));
    const evidence=await collectOfflineRecoveryEvidence(input);
    assert.equal(evidence.terminalReceiptMatches,true);
    assert.equal(evidence.sqliteStatus.succeeded,1);
    assert.equal(evidence.writerFenced,false);
    assert.equal(evidence.recoveryPending,'UNVERIFIED');
    assert.equal(evidence.priorHelperCompatible,false);
    assert.equal(evidence.productionRollbackAuthorized,false);
    assert.equal(evidence.productionUninstallAuthorized,false);
    assert.equal(evidence.releaseGate,'MISSING');
    assert.equal(sha(await fs.readFile(ledger)),before);
    await assert.rejects(collectOfflineRecoveryEvidence({...input,
      approved:{...input.approved,treeSha256:'0'.repeat(64)}}),/APPROVED_BASELINE_MISMATCH/);
    // Both copies now agree, but contain a newly committed UNKNOWN record.
    // A fresh equal snapshot cannot stand in for the original approval.
    for(const root of [current,preserved]){
      const writer=new DatabaseSync(path.join(root,'idempotency-records.sqlite'));
      try{writer.exec("INSERT INTO idempotency_records VALUES('new','unknown')")}finally{writer.close()}
    }
    await assert.rejects(collectOfflineRecoveryEvidence(input),/APPROVED_BASELINE_MISMATCH/);
    const changed=await captureLegacyHubStateSnapshotProof(current);
    const latest=sha(await fs.readFile(ledger));
    await assert.rejects(collectOfflineRecoveryEvidence({...input,approved:{
      ...input.approved,treeSha256:changed.treeSha256,sqliteRecords:changed.sqliteRecords,
    }}),/UNRESOLVED_OPERATIONS/);
    assert.equal(sha(await fs.readFile(ledger)),latest);
  });
