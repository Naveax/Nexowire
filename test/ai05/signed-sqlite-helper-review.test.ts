import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {coreRuntimeManifestBytes,coreRuntimeManifestSigningBytes,type CoreRuntimeManifest} from '../../src/security/core-runtime-package-manifest.js';
import {readSqliteHelperRollbackReview} from '../../scripts/ai05-signed-sqlite-helper-review.js';
import {captureLegacyHubStateSnapshotProof} from '../../scripts/ai04-state-snapshot-proof.js';
import {bindHelperRollbackGuard} from '../../src/security/protected-helper-rollback-guard.js';
import type {HelperAuthorityEvidenceRequest} from '../../src/security/postgres-helper-selection-authority.js';
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
test('Windows actual signed SQLite candidate review is bound to helper rollback proof, not authorization',{
  skip:process.platform!=='win32',timeout:30000,
},async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'nx-ai05-sqlite-review-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const payload=path.join(root,'payload'),current=path.join(root,'current'),preserved=path.join(root,'preserved');
  await fs.mkdir(payload);await fs.mkdir(current);
  const cli=Buffer.from('inert reviewed fixture, never executed'),helper=Buffer.from('inert helper payload fixture');
  await fs.writeFile(path.join(payload,'cli.js'),cli);await fs.writeFile(path.join(payload,'helper.exe'),helper);
  const keys=generateKeyPairSync('ed25519'),observer=generateKeyPairSync('ed25519'),native=generateKeyPairSync('ed25519');
  const der=keys.publicKey.export({format:'der',type:'spki'});
  const manifest:CoreRuntimeManifest={version:1,kind:'nexowire_core_runtime_manifest_v1',sourceRepository:'Naveax/Nexowire',
    sourceCommit:'a'.repeat(40),releaseVersion:'1.0.9-exp.0',releaseSequence:2,previousManifestSha256:'b'.repeat(64),entrypoint:'cli.js',
    files:[{path:'cli.js',sha256:sha(cli),bytes:cli.length},{path:'helper.exe',sha256:sha(helper),bytes:helper.length}]};
  const raw=coreRuntimeManifestBytes(manifest);
  const runtime={manifestSha256:sha(raw),sourceCommit:manifest.sourceCommit,releaseSequence:2,reader:'sqlite-only' as const,schemaVersion:1 as const};
  const anchor={authorityId:randomUUID(),publisherSpkiSha256:sha(der),acceptedSequence:2,acceptedManifestSha256:runtime.manifestSha256};
  const candidate={payloadRoot:payload,manifestUtf8:raw,signatureBase64:sign(null,coreRuntimeManifestSigningBytes(manifest),keys.privateKey).toString('base64'),
    publisherSpkiBase64:der.toString('base64'),expectedSourceCommit:manifest.sourceCommit,expectedEntrypoint:manifest.entrypoint,
    authorityId:anchor.authorityId,readReleaseAnchor:async()=>({...anchor})};
  const helperPin={sha256:sha(helper),signerSha256:'c'.repeat(64)}; // synthetic Authenticode pin; real Authenticode separately tested
  for(const name of ['audit.jsonl','credentials.json','devices.json','idempotency-records.json'])await fs.writeFile(path.join(current,name),'{}');
  const ledger=path.join(current,'idempotency-records.sqlite');
  const db=new DatabaseSync(ledger);
  try{db.exec("CREATE TABLE idempotency_records(key TEXT PRIMARY KEY,status TEXT); INSERT INTO idempotency_records VALUES('known','succeeded'); CREATE TABLE idempotency_meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO idempotency_meta VALUES('schema_version','1')");}finally{db.close();}
  await fs.cp(current,preserved,{recursive:true});
  const baseline=await captureLegacyHubStateSnapshotProof(current);
  const input={candidate,reviewedRuntime:runtime,currentOfflineRoot:current,preservedOfflineRoot:preserved,
    approved:{treeSha256:baseline.treeSha256,sqliteRecords:baseline.sqliteRecords,runtimeManifestSha256:runtime.manifestSha256},
    reviewedHelper:{path:'helper.exe',pin:helperPin}};
  const approvedReadback=await readSqliteHelperRollbackReview(input);
  assert.equal(approvedReadback.productionRollbackAuthorized,false);
  assert.equal(approvedReadback.sqliteRecords,1);
  assert.equal(approvedReadback.succeeded,1);
  assert.equal(approvedReadback.unknown,0);
  assert.equal(approvedReadback.inProgress,0);
  await assert.rejects(readSqliteHelperRollbackReview({...input,reviewedHelper:{...input.reviewedHelper,pin:{...helperPin,sha256:'d'.repeat(64)}}}),/REVIEW_NOT_BOUND/);
  const approved={runtime,helperPin,approvedStateSha256:approvedReadback.treeSha256,sqliteTreeSha256:approvedReadback.treeSha256,sqliteRecords:1};
  const scope={authorityId:anchor.authorityId,deviceId:randomUUID(),ownerId:randomUUID(),deviceEpoch:randomUUID(),sessionEpoch:randomUUID(),ownerEpoch:1,generation:1,brokerId:randomUUID()};
  const selection={revision:randomUUID(),pin:{sha256:'e'.repeat(64),signerSha256:'f'.repeat(64)}};
  const request={requestId:randomUUID(),operation:'rollback' as const,expected:selection,desired:helperPin};
  const observation:HelperAuthorityEvidenceRequest={phase:'COMMIT',scope,lease:{id:randomUUID(),requestId:request.requestId,kind:'DEPLOYMENT',expectedRevision:selection.revision},selection,request};
  const guarded=bindHelperRollbackGuard({observerPublicKeyPem:native.publicKey.export({format:'pem',type:'spki'}).toString(),async requestProof(){return 'fixture-only native reply';},timeoutMs:3500},
    {observerPublicKeyPem:observer.publicKey.export({format:'pem',type:'spki'}).toString(),approved,async requestProof(c){
      const sqliteReview=await readSqliteHelperRollbackReview(input);
      const observedAt=Date.now();
      const payload=JSON.stringify({domain:'nexowire.helper-rollback-guard.v2',nonce:c.nonce,requestSha256:c.requestSha256,phase:c.phase,
        approvedStateSha256:approved.approvedStateSha256,currentStateSha256:sqliteReview.treeSha256,writerFenced:true,unknownOperations:false,recoveryPending:false,priorHelperCompatible:true,sqliteReview,observedAt,expiresAt:observedAt+1000});
      return {payload,proof:sign(null,Buffer.from(payload),observer.privateKey).toString('base64url')};
    }});
  const challenge={domain:'nexowire.helper-selection-native-evidence.v1' as const,nonce:'1'.repeat(64),requestSha256:'2'.repeat(64),phase:'COMMIT' as const};
  const before=sha(await fs.readFile(ledger));
  assert.equal(await guarded.requestProof(challenge,observation),'fixture-only native reply');
  assert.equal(sha(await fs.readFile(ledger)),before);
  const writer=new DatabaseSync(ledger);
  try{writer.exec("INSERT INTO idempotency_records VALUES('divergent','unknown')");}finally{writer.close();}
  const after=sha(await fs.readFile(ledger));
  await assert.rejects(guarded.requestProof({...challenge,nonce:'3'.repeat(64)},observation),/CURRENT_LEDGER_NOT_PRESERVED/);
  assert.equal(sha(await fs.readFile(ledger)),after);
  assert.equal(sha(await fs.readFile(path.join(preserved,'idempotency-records.sqlite'))),before);
  // Even matching copies and a newly supplied baseline cannot authorize a
  // ledger with UNKNOWN. Keep the original guard baseline unchanged.
  const other=new DatabaseSync(path.join(preserved,'idempotency-records.sqlite'));
  try{other.exec("INSERT INTO idempotency_records VALUES('divergent','unknown')");}finally{other.close();}
  const changed=await captureLegacyHubStateSnapshotProof(current);
  const currentHash=sha(await fs.readFile(ledger));
  const preservedHash=sha(await fs.readFile(path.join(preserved,'idempotency-records.sqlite')));
  await assert.rejects(readSqliteHelperRollbackReview({...input,approved:{...input.approved,
    treeSha256:changed.treeSha256,sqliteRecords:changed.sqliteRecords}}),/UNRESOLVED_OPERATIONS/);
  assert.equal(sha(await fs.readFile(ledger)),currentHash);
  assert.equal(sha(await fs.readFile(path.join(preserved,'idempotency-records.sqlite'))),preservedHash);
});
