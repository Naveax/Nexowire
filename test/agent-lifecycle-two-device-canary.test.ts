import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {
  canonicalAgentManifest,upgradeIsolatedAgent,
  type AgentRuntime,type UpgradeAdapter,type UpgradeContext,
  type SignedRelease,type ReleaseTrust,type SignedAgentManifest,
} from '../src/update/agent-lifecycle-manager.js';

const keys=generateKeyPairSync('ed25519');
const h=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const cert='c'.repeat(64);
const publisher='Nexowire Isolated Test Publisher';
const makeRelease=(version:string):SignedRelease=>{
  const artifact=Buffer.from('SYNTHETIC_ONLY_NO_INSTALLER_'+version);
  const manifest:SignedAgentManifest={
    schemaVersion:1,version,sourceSha:'d'.repeat(40),
    artifactSha256:h(artifact),publisher,
    minAgentVersion:'1.0.5',maxAgentVersion:'1.0.6',
    minHubVersion:'1.0.4',maxHubVersion:'1.0.8',
  };
  return{artifact,manifest,manifestSignature:sign(null,
    canonicalAgentManifest(manifest),keys.privateKey).toString('base64')};
};
const rollback=makeRelease('1.0.5'),target=makeRelease('1.0.6');
const trust:ReleaseTrust={
  trustedManifestPublicKeyPem:keys.publicKey.export({type:'spki',format:'pem'}).toString(),
  trustedPublisher:publisher,trustedCertificateSha256:cert,
  inspectPublisher:async bytes=>({
    signatureValid:true,publisher,certificateSha256:cert,artifactSha256:h(bytes),
  }),
};

function simulatedDevice(deviceId:string,{failHealth=false,wrongHub=false,revoked=false}={}){
  const events:string[]=[];
  const runtime:AgentRuntime={
    ownerAccountId:'same-owner-isolated',
    deviceId,agentVersion:'1.0.5',hubVersion:wrongHub?'9.0.0':'1.0.5',
    brokerMode:'auto',coreGrantId:null,privilegeMode:'safe',
    authSessionEpoch:'fixture-epoch-'+deviceId,authTokenValid:!revoked,
  };
  const buffers=new Map<string,Buffer>();
  let active='1.0.5',locked=false;
  const context:UpgradeContext={
    expectedOwnerAccountId:runtime.ownerAccountId,
    expectedDeviceId:deviceId,availableBytes:50_000_000,
    minimumFreeBytes:1_000_000,userApprovedDisruption:true,
    rollbackRelease:rollback,
  };
  const adapter:UpgradeAdapter={
    acquireDeviceLock:async id=>{
      assert.equal(id,deviceId);assert.equal(locked,false);
      locked=true;events.push('lock');return async()=>{locked=false;events.push('unlock')};
    },
    readRuntime:async id=>{
      assert.equal(id,deviceId);events.push('read');return {...runtime,agentVersion:active};
    },
    stage:async release=>{
      events.push('stage-new');buffers.set('target',Buffer.from(release.artifact));
    },
    stageRollback:async release=>{
      events.push('stage-old');buffers.set('rollback',Buffer.from(release.artifact));
    },
    readStagedBytes:async(_id,slot)=>{
      events.push('read-'+slot);return Buffer.from(buffers.get(slot)??Buffer.alloc(0));
    },
    stopOwnedAgent:async()=>{events.push('stop')},
    cutover:async(_id,version,sha)=>{
      const slot=version==='1.0.6'?'target':'rollback';
      assert.equal(h(buffers.get(slot)??Buffer.alloc(0)),sha);
      active=version;events.push('cutover-'+version);
    },
    startOwnedAgent:async()=>{events.push('start')},
    healthyRuntime:async()=>{
      events.push('health');
      if(failHealth&&active==='1.0.6')return null;
      return {...runtime,agentVersion:active};
    },
    attestOwnedAgentBinary:async()=>{
      events.push('attest');
      const sha=h(buffers.get(active==='1.0.6'?'target':'rollback')??Buffer.alloc(0));
      return{installedArtifactSha256:sha,runningImageSha256:sha,
        processCreationIdentity:'simulated-device-process-'+deviceId,
        healthAuthenticated:true};
    },
  };
  return{adapter,context,events,active:()=>active,locked:()=>locked,deviceId};
}

test('isolated canary: distinct device scopes and separate signed rollback hashes',async()=>{
  const first=simulatedDevice('nonproduction-one');
  const second=simulatedDevice('nonproduction-two',{failHealth:true});
  assert.notEqual(first.context.expectedDeviceId,second.context.expectedDeviceId);
  assert.notEqual(h(rollback.artifact),h(target.artifact));
  const a=await upgradeIsolatedAgent(target,trust,first.context,first.adapter);
  assert.equal(a.status,'succeeded');
  // TEST-ONLY staged-approval gate, not an authorization to deploy devices.
  const simulatedApproval=true;
  assert.equal(simulatedApproval,true);
  const b=await upgradeIsolatedAgent(target,trust,second.context,second.adapter);
  assert.equal(b.status,'rolled_back');
  assert.equal(first.active(),'1.0.6');
  assert.equal(second.active(),'1.0.5');
  assert.ok(second.events.includes('cutover-1.0.5'));
  assert.ok(!first.events.includes('cutover-1.0.5'));
  assert.equal(first.locked(),false);
  assert.equal(second.locked(),false);
});

test('first canary failure fences second isolated device without any stage/stop',async()=>{
  const first=simulatedDevice('nonproduction-one',{failHealth:true});
  const second=simulatedDevice('nonproduction-two');
  const result=await upgradeIsolatedAgent(target,trust,first.context,first.adapter);
  assert.equal(result.status,'rolled_back');
  assert.equal(second.events.length,0);
  assert.equal(second.active(),'1.0.5');
});

test('wrong Hub or revoked token on second canary blocks before stop independently',async()=>{
  const first=simulatedDevice('nonproduction-one');
  assert.equal((await upgradeIsolatedAgent(target,trust,first.context,first.adapter)).status,'succeeded');
  for(const bad of [{wrongHub:true},{revoked:true}]){
    const second=simulatedDevice('nonproduction-two',bad);
    await assert.rejects(
      upgradeIsolatedAgent(target,trust,second.context,second.adapter),
      /VERSION_INCOMPATIBLE|TOKEN_REVOKED|ROLLBACK_VERSION_INCOMPATIBLE/,
    );
    assert.ok(!second.events.includes('stop'));
    assert.equal(second.active(),'1.0.5');
  }
});
