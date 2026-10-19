import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  canonicalAgentManifest, upgradeIsolatedAgent, type AgentRuntime,
  type ReleaseTrust, type SignedRelease, type SignedAgentManifest,
  type UpgradeAdapter, type UpgradeContext,
} from '../src/update/agent-lifecycle-manager.js';

const pair = generateKeyPairSync('ed25519');
const certificateSha = 'b'.repeat(64);
const runtime:AgentRuntime={
  ownerAccountId:'test-owner',deviceId:'isolated-vm-fixture',
  agentVersion:'1.0.5',hubVersion:'1.0.5',brokerMode:'off',
  coreGrantId:null,privilegeMode:'safe',authSessionEpoch:'login-epoch-1',
  authTokenValid:true,
};
const trust:ReleaseTrust={
  trustedManifestPublicKeyPem:pair.publicKey.export({type:'spki',format:'pem'}).toString(),
  trustedPublisher:'Nexowire Acceptance Fixture',
  trustedCertificateSha256:certificateSha,
  inspectPublisher:async bytes=>({
    signatureValid:true,
    artifactSha256:createHash('sha256').update(bytes).digest('hex'),
    publisher:'Nexowire Acceptance Fixture',
    certificateSha256:certificateSha,
  }),
};
function signed(version:string):SignedRelease{
  const artifact=Buffer.from('TEST_ONLY_SIGNED_FIXTURE_'+version);
  const manifest:SignedAgentManifest={
    schemaVersion:1,version,sourceSha:'a'.repeat(40),
    artifactSha256:createHash('sha256').update(artifact).digest('hex'),
    publisher:trust.trustedPublisher,
    minAgentVersion:'1.0.5',maxAgentVersion:'1.0.7',
    minHubVersion:'1.0.5',maxHubVersion:'1.0.6',
  };
  return {manifest,artifact,
    manifestSignature:sign(null,canonicalAgentManifest(manifest),
      pair.privateKey).toString('base64')};
}
async function withDiskFixture(scenario:'clean'|'tamper-target'|'tamper-rollback',
  run:(a:{api:UpgradeAdapter;context:UpgradeContext;
    events:string[];root:string;isLocked:()=>boolean})=>Promise<void>){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-s3-disk-acceptance-'));
  const events:string[]=[];
  const old=signed('1.0.5');
  const next=signed('1.0.6');
  let locked=false;
  let stopped=false;
  let selected='1.0.5';
  const artifactPath=(slot:'target'|'rollback')=>path.join(root,slot+'.bin');
  const context:UpgradeContext={
    expectedOwnerAccountId:runtime.ownerAccountId,
    expectedDeviceId:runtime.deviceId,availableBytes:5_000_000,
    minimumFreeBytes:1_000_000,userApprovedDisruption:true,
    rollbackRelease:old,
  };
  const api:UpgradeAdapter={
    acquireDeviceLock:async id=>{
      assert.equal(id,runtime.deviceId);
      if(locked)throw Error('LOCK_HELD');
      locked=true;events.push('lock');
      return async()=>{locked=false;events.push('unlock');};
    },
    readRuntime:async id=>{
      assert.equal(id,runtime.deviceId);
      events.push('read');
      if(scenario==='tamper-target'&&events.filter(e=>e==='read').length===2){
        await fs.appendFile(artifactPath('target'),'ATTACKER_ADDED_BYTES');
      }
      return {...runtime};
    },
    stage:async(bundle,id)=>{
      assert.equal(id,runtime.deviceId);
      events.push('stage');
      await fs.writeFile(artifactPath('target'),bundle.artifact,{flag:'wx'});
    },
    stageRollback:async(bundle,id)=>{
      assert.equal(id,runtime.deviceId);
      events.push('stage-rollback');
      await fs.writeFile(artifactPath('rollback'),bundle.artifact,{flag:'wx'});
    },
    readStagedBytes:async(id,slot)=>{
      assert.equal(id,runtime.deviceId);
      events.push('file-read-'+slot);
      return fs.readFile(artifactPath(slot));
    },
    stopOwnedAgent:async id=>{
      assert.equal(id,runtime.deviceId);
      stopped=true;events.push('stop');
    },
    cutover:async(id,version,sha)=>{
      assert.equal(id,runtime.deviceId);
      events.push('cutover-'+version);
      const slot=version==='1.0.6'?'target':'rollback';
      const content=await fs.readFile(artifactPath(slot));
      assert.equal(createHash('sha256').update(content).digest('hex'),sha);
      selected=version;
      if(scenario==='tamper-rollback'&&version==='1.0.6'){
        await fs.appendFile(artifactPath('rollback'),'MALICIOUS_ROLLBACK_REPLACEMENT');
      }
    },
    startOwnedAgent:async id=>{
      assert.equal(id,runtime.deviceId);
      assert.equal(stopped,true);
      events.push('start');
    },
    healthyRuntime:async id=>{
      assert.equal(id,runtime.deviceId);
      events.push('health');
      if(scenario==='tamper-rollback'&&selected==='1.0.6')return null;
      return {...runtime,agentVersion:selected};
    },
  };
  try{await run({api,context,events,root,isLocked:()=>locked});}
  finally{await fs.rm(root,{recursive:true,force:true});}
}

test('real temporary disk staging reads back two signed fixture payload hashes',async()=>{
  await withDiskFixture('clean',async({api,context,events,isLocked})=>{
    const result=await upgradeIsolatedAgent(signed('1.0.6'),trust,context,api);
    assert.equal(result.status,'succeeded');
    assert.ok(events.includes('file-read-rollback'));
    assert.ok(events.includes('file-read-target'));
    assert.ok(events.includes('cutover-1.0.6'));
    assert.equal(isLocked(),false);
  });
});

test('target payload replaced on physical temporary disk after staging blocks stop',async()=>{
  await withDiskFixture('tamper-target',async({api,context,events,isLocked})=>{
    await assert.rejects(
      upgradeIsolatedAgent(signed('1.0.6'),trust,context,api),
      /STAGED_TARGET_HASH_MISMATCH/,
    );
    assert.ok(!events.includes('stop'));
    assert.ok(!events.some(e=>e.startsWith('cutover-')));
    assert.equal(isLocked(),false);
  });
});

test('rollback payload altered after failure never starts corrupt old binary',async()=>{
  await withDiskFixture('tamper-rollback',async({api,context,events,isLocked})=>{
    const result=await upgradeIsolatedAgent(signed('1.0.6'),trust,context,api);
    assert.equal(result.status,'rollback_unconfirmed');
    assert.ok(events.includes('cutover-1.0.6'));
    assert.ok(!events.includes('cutover-1.0.5'));
    assert.equal(isLocked(),false);
  });
});
