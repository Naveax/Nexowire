import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  assessS3CrashRecovery,digestUntrustedRecoveryJournal,CRASH_PHASES,
  type S3CrashRecord,type S3RecoveryPins,
} from '../scripts/s3-crash-recovery-assessment.js';

const pinned:S3RecoveryPins={
  transactionId:'isolated-txn-000001',
  ownerAccountId:'fixture-owner',
  deviceId:'fixture-vm-1',
  oldAgentVersion:'1.0.5',
  targetAgentVersion:'1.0.6',
  hubVersion:'1.0.5',
  oldArtifactSha256:'a'.repeat(64),
  targetArtifactSha256:'b'.repeat(64),
  installerHelperSha256:'c'.repeat(64),
  minimumIndependentSequence:4,
};
const rec=(phase:S3CrashRecord['phase'],sequence=4):S3CrashRecord=>({
  schemaVersion:1,phase,sequence,
  transactionId:pinned.transactionId,ownerAccountId:pinned.ownerAccountId,
  deviceId:pinned.deviceId,oldAgentVersion:pinned.oldAgentVersion,
  targetAgentVersion:pinned.targetAgentVersion,hubVersion:pinned.hubVersion,
  oldArtifactSha256:pinned.oldArtifactSha256,
  targetArtifactSha256:pinned.targetArtifactSha256,
  installerHelperSha256:pinned.installerHelperSha256,
});
test('crashes at every installation/rollback boundary never permit automatic service restart',()=>{
  for(const phase of CRASH_PHASES){
    const outcome=assessS3CrashRecovery(rec(phase),pinned);
    assert.equal(outcome.disposition,'NO_AUTOMATIC_RESTART_OR_ROLLBACK');
    assert.equal(outcome.resumeAllowed,false);
    assert.equal(outcome.rollbackAllowed,false);
    assert.equal(outcome.productionAccepted,false);
    assert.equal(outcome.status,
      phase==='signed_stage_ready'?'unverified_local_checkpoint':'interrupted_after_stop');
  }
});

test('old version migration, owner scope, device and helper pin substitution fail closed',()=>{
  for(const changed of [
    {oldAgentVersion:'1.0.4'},
    {oldAgentVersion:'1.0.6'},
    {targetAgentVersion:'1.0.5'},
    {deviceId:'other-device'},
    {ownerAccountId:'other-owner'},
    {hubVersion:'1.0.2'},
    {oldArtifactSha256:'f'.repeat(64)},
    {installerHelperSha256:'e'.repeat(64)},
    {transactionId:'duplicate-operation'},
  ]){
    const result=assessS3CrashRecovery({...rec('target_start_started'),...changed},pinned);
    assert.equal(result.status,'invalid');
    assert.equal(result.resumeAllowed,false);
  }
});

test('power-loss journal missing/truncated/untrusted fields fail closed',()=>{
  for(const journal of [
    null,{},[],0,'',false,{...rec('health_pending'),extra:'untrusted'},
    {...rec('health_pending'),phase:'completed_verified'},
    {...rec('health_pending'),sequence:-1},
    {...rec('health_pending'),sequence:Infinity},
    {...rec('health_pending'),oldArtifactSha256:'NOT_SHA'},
  ]){
    const result=assessS3CrashRecovery(journal,pinned);
    assert.equal(result.status,'invalid');
  }
});

test('replaying BOTH local journal and installer files cannot bypass independent sequence',()=>{
  const journal=rec('target_cutover_started',3);
  const outcome=assessS3CrashRecovery(journal,pinned);
  assert.equal(outcome.status,'stale_or_rollback');
  assert.equal(outcome.rollbackAllowed,false);
  // Even a local hash of a replayed journal is NOT anti-rollback proof.
  assert.equal(digestUntrustedRecoveryJournal(journal).length,64);
});

test('OS temporary files simulate reboot journal persistence and truncated-file failure',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-s3-crash-journal-'));
  const file=path.join(root,'journal.json');
  try{
    for(const phase of CRASH_PHASES){
      await fs.writeFile(file,JSON.stringify(rec(phase)),'utf8');
      const restored=JSON.parse(await fs.readFile(file,'utf8'));
      const outcome=assessS3CrashRecovery(restored,pinned);
      assert.equal(outcome.resumeAllowed,false);
      assert.equal(outcome.rollbackAllowed,false);
    }
    await fs.writeFile(file,'{"schemaVersion":1,"phase":');
    let result:unknown;
    try{result=JSON.parse(await fs.readFile(file,'utf8'));}
    catch{result=undefined;}
    assert.equal(assessS3CrashRecovery(result,pinned).status,'invalid');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('missing external monotonic anchor or weak pins never certify restored old Agent',()=>{
  for(const changed of [
    {minimumIndependentSequence:-1},
    {minimumIndependentSequence:1.5},
    {oldArtifactSha256:'z'.repeat(64)},
    {oldArtifactSha256:'b'.repeat(64)},
    {hubVersion:'999999999999999999999999.0.0'},
  ]){
    assert.equal(assessS3CrashRecovery(rec('rollback_start_started'),{
      ...pinned,...changed,
    }).status,'invalid');
  }
});
