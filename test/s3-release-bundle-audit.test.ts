import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  canonicalAgentManifest, type SignedAgentManifest,
} from '../src/update/agent-lifecycle-manager.js';
import {
  auditOfflineReleaseBundles,
  type BinaryInspector,
} from '../scripts/s3-release-bundle-audit.js';

const keys=generateKeyPairSync('ed25519');
const SHA=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
const publisher='Nexowire Fixture Publisher';
const certificateSha='c'.repeat(64);

type Fixture={
  root:string; policyFile:string; policySha:string;
  bundleRoot:string;
  policy:Record<string,unknown>;
  signedArtifact:(name:'target'|'rollback', version:string, content:Buffer)=>Promise<void>;
  request:()=>{trustedPolicyPath:string;trustedPolicySha256:string;bundleRoot:string};
  goodInspector:BinaryInspector;
};

async function isolated<T>(run:(fx:Fixture)=>Promise<T>):Promise<T>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'s3-offline-signature-proof-'));
  const bundleRoot=path.join(root,'bundle');
  const policyFile=path.join(root,'independently-owned-policy.json');
  const payload=(label:string)=>Buffer.from('TEST-ONLY-UNSIGNED_BINARY_'+label);
  const rollbackSha=SHA(payload('rollback'));
  const targetSha=SHA(payload('target'));
  const policy:Record<string,unknown>={
    schemaVersion:1,
    trustedManifestPublicKeyPem:keys.publicKey.export({type:'spki',format:'pem'}).toString(),
    trustedPublisher:publisher,
    trustedCertificateSha256:certificateSha,
    expectedOwnerAccountId:'owner-fixture',expectedDeviceId:'vm-fixture',
    installedAgentVersion:'1.0.5',hubVersion:'1.0.5',
    targetVersion:'1.0.6',
    rollbackArtifactSha256:rollbackSha,targetArtifactSha256:targetSha,
  };
  let policySha='';
  const signedArtifact=async(name:'target'|'rollback',version:string,artifact:Buffer)=>{
    const dir=path.join(bundleRoot,name);
    await fs.mkdir(dir,{recursive:true});
    const manifest:SignedAgentManifest={
      schemaVersion:1,version,sourceSha:'a'.repeat(40),
      artifactSha256:SHA(artifact),publisher,
      minAgentVersion:'1.0.5',maxAgentVersion:'1.0.6',
      minHubVersion:'1.0.5',maxHubVersion:'1.0.6',
    };
    await fs.writeFile(path.join(dir,'installer.exe'),artifact);
    await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest));
    await fs.writeFile(path.join(dir,'manifest.sig'),
      sign(null,canonicalAgentManifest(manifest),keys.privateKey).toString('base64'));
  };
  const goodInspector:BinaryInspector=(pins)=>({
    status:'signature_verified',
    fileSha256:pins.expectedSha256,
    certificateSha256:pins.expectedCertificateSha256,
    publisherSubject:pins.expectedPublisherSubject,
  });
  const fx:Fixture={root,policyFile,policySha,bundleRoot,policy,
    signedArtifact,request:()=>({
      trustedPolicyPath:policyFile,trustedPolicySha256:policySha,bundleRoot,
    }),goodInspector};
  try{
    await signedArtifact('target','1.0.6',payload('target'));
    await signedArtifact('rollback','1.0.5',payload('rollback'));
    const saved=Buffer.from(JSON.stringify(policy));
    await fs.writeFile(policyFile,saved);
    policySha=SHA(saved);
    fx.policySha=policySha;
    return await run(fx);
  }finally{
    await fs.rm(root,{recursive:true,force:true});
  }
}

test('bounded offline signature audit validates two pinned releases but NEVER claims safe execution',async()=>{
  await isolated(async fx=>{
    const result=await auditOfflineReleaseBundles(fx.request(),fx.goodInspector);
    assert.equal(result.status,'offline_artifacts_verified');
    assert.equal(result.signedManifestAndAuthenticodeVerified,true);
    assert.equal(result.canaryApproved,false);
    assert.equal(result.productionApproved,false);
    assert.equal(result.executionSafe,false);
    assert.equal(result.rollbackArtifactSha256,fx.policy.rollbackArtifactSha256);
  });
});

test('release-owned policy cannot silently replace independently pinned trust hash',async()=>{
  await isolated(async fx=>{
    const wrong= {...fx.request(),trustedPolicySha256:'f'.repeat(64)};
    await assert.rejects(auditOfflineReleaseBundles(wrong,fx.goodInspector),
      /S3_OFFLINE_POLICY_HASH_MISMATCH/);
    await fs.writeFile(fx.policyFile,JSON.stringify({...fx.policy,
      trustedPublisher:'Untrusted Remote Publisher'}));
    await assert.rejects(auditOfflineReleaseBundles(fx.request(),fx.goodInspector),
      /S3_OFFLINE_POLICY_HASH_MISMATCH/);
  });
});

test('missing first-party Authenticode proof is NO-GO even when hashes match',async()=>{
  await isolated(async fx=>{
    for(const inspector of [
      (()=>{throw new Error('CERT_PROVIDER_UNAVAILABLE');}) as BinaryInspector,
      ((pins:Parameters<BinaryInspector>[0])=>({...fx.goodInspector(pins),status:'not_signed'})),
      ((pins:Parameters<BinaryInspector>[0])=>({...fx.goodInspector(pins),publisherSubject:'Other Corp'})),
      ((pins:Parameters<BinaryInspector>[0])=>({...fx.goodInspector(pins),certificateSha256:'0'.repeat(64)})),
    ]){
      await assert.rejects(auditOfflineReleaseBundles(fx.request(),inspector));
    }
  });
});

test('target, rollback and signature modifications fail closed',async()=>{
  for (const changed of ['target','rollback','signature'] as const){
    await isolated(async fx=>{
      const filename=changed==='signature'?
        path.join(fx.bundleRoot,'target','manifest.sig'):
        path.join(fx.bundleRoot,changed,'installer.exe');
      await fs.appendFile(filename,'CORRUPTION');
      await assert.rejects(auditOfflineReleaseBundles(fx.request(),fx.goodInspector));
    });
  }
});

test('wrong Hub and unsafe version matrix block both signed releases',async()=>{
  await isolated(async fx=>{
    const replaced={...fx.policy,hubVersion:'1.0.3'};
    const bytes=Buffer.from(JSON.stringify(replaced));
    await fs.writeFile(fx.policyFile,bytes);
    await assert.rejects(auditOfflineReleaseBundles({
      ...fx.request(),trustedPolicySha256:SHA(bytes),
    },fx.goodInspector),/S3_OFFLINE_HUB_CONTRACT_MISMATCH/);
  });
});

test('rollback package must match independently pinned old SHA, not merely its version',async()=>{
  await isolated(async fx=>{
    const file=path.join(fx.bundleRoot,'rollback','installer.exe');
    await fs.writeFile(file,Buffer.from('FOREIGN_ROLLBACK_PAYLOAD'));
    await assert.rejects(auditOfflineReleaseBundles(fx.request(),fx.goodInspector),
      /S3_ARTIFACT_HASH_MISMATCH|S3_OFFLINE_ARTIFACT_CHANGED/);
  });
});

test('manifest signer mismatch is rejected independently of a matching file SHA',async()=>{
  await isolated(async fx=>{
    const file=path.join(fx.bundleRoot,'target','manifest.sig');
    await fs.writeFile(file,Buffer.alloc(64,1).toString('base64'));
    await assert.rejects(auditOfflineReleaseBundles(fx.request(),fx.goodInspector),
      /S3_MANIFEST_SIGNATURE_INVALID/);
  });
});

test('symlinked installer is rejected when supported by isolated OS fixture',async(t)=>{
  await isolated(async fx=>{
    const original=path.join(fx.bundleRoot,'target','installer.exe');
    const symlink=path.join(fx.bundleRoot,'target','stage-link.exe');
    try{await fs.symlink(original,symlink,'file');}
    catch{t.diagnostic('OS denied creating symlink; no security control bypass');return;}
    await fs.unlink(original);
    await fs.rename(symlink,original);
    await assert.rejects(auditOfflineReleaseBundles(fx.request(),fx.goodInspector));
  });
});
