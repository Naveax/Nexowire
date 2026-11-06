import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,readFile,rm,link,symlink,realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {CoreRuntimeManifestSchema,coreRuntimeManifestBytes,coreRuntimeManifestSigningBytes,
  verifyCoreRuntimePackageCandidate,type CoreRuntimeManifest,type CoreRuntimeReleaseAnchor}
  from '../src/security/core-runtime-package-manifest.js';

// Test-only software signer and fake anchor readback: no production publisher
// certificate, signing credential, independent monotonic custody or authority.
async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'nw-core-manifest-'));
  const initial=path.join(root,'payload');await mkdir(path.join(initial,'app','dist'),{recursive:true});
  const payload=await realpath(initial);
  await mkdir(path.join(payload,'runtime'));
  const content=new Map([['app/dist/cli.js','fixture source entrypoint'],
    ['app/package.json','{"name":"nexowire-fixture"}'],['runtime/node.exe','fixture runtime, not signed Node']]);
  for(const [p,value] of content)await writeFile(path.join(payload,p),value);
  const keys=generateKeyPairSync('ed25519'),der=keys.publicKey.export({format:'der',type:'spki'});
  const authorityId=randomUUID(),previous='a'.repeat(64),sourceCommit='b'.repeat(40);
  let anchor:CoreRuntimeReleaseAnchor={authorityId,publisherSpkiSha256:createHash('sha256').update(der).digest('hex'),
    acceptedSequence:8,acceptedManifestSha256:previous};
  const manifest:CoreRuntimeManifest={version:1,kind:'nexowire_core_runtime_manifest_v1',
    sourceRepository:'Naveax/Nexowire',sourceCommit,releaseVersion:'1.0.8',releaseSequence:9,
    previousManifestSha256:previous,entrypoint:'app/dist/cli.js',files:[...content].map(([p,value])=>
      ({path:p,sha256:createHash('sha256').update(value).digest('hex'),bytes:Buffer.byteLength(value)}))};
  const options=(m=manifest)=>({payloadRoot:payload,manifestUtf8:coreRuntimeManifestBytes(m),
    signatureBase64:sign(null,coreRuntimeManifestSigningBytes(m),keys.privateKey).toString('base64'),
    publisherSpkiBase64:der.toString('base64'),expectedSourceCommit:sourceCommit,
    expectedEntrypoint:manifest.entrypoint,authorityId,readReleaseAnchor:async()=>({...anchor})});
  return {root,payload,keys,manifest,options,anchor:()=>anchor,setAnchor:(a:CoreRuntimeReleaseAnchor)=>{anchor=a},
    close:()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100})};
}

test('signed complete payload candidate verifies all files and still cannot authorize/install CORE',async()=>{
  const f=await fixture();try{
    const result=await verifyCoreRuntimePackageCandidate(f.options());
    assert.equal(result.verifiedFiles,3);assert.equal(result.candidateFilesMatch,true);
    assert.equal(result.releaseAnchorAdvanced,false);assert.equal(result.authenticodePublisherVerified,false);
    assert.equal(result.protectedAclVerified,false);assert.equal(result.runtimeInstalled,false);
    assert.equal(result.canAuthorizeCore,false);assert.equal(result.productionCore,'NO_GO');
    assert.equal(result.physicalAcceptance,'NOT_PROVEN');assert.equal(f.anchor().acceptedSequence,8);
  }finally{await f.close();}
});

test('runtime-only Node signature/hash cannot replace the Nexowire manifest and source entrypoint',async()=>{
  const f=await fixture();try{
    const nodeOnly={...f.manifest,entrypoint:'runtime/node.exe',files:f.manifest.files.filter(x=>x.path==='runtime/node.exe')};
    await assert.rejects(verifyCoreRuntimePackageCandidate(f.options(nodeOnly)),/CORE_RELEASE_SOURCE_OR_ENTRYPOINT_MISMATCH/);
    const options=f.options();options.signatureBase64=Buffer.alloc(64).toString('base64');
    await assert.rejects(verifyCoreRuntimePackageCandidate(options),/CORE_RELEASE_NEXOWIRE_MANIFEST_SIGNATURE_REQUIRED/);
  }finally{await f.close();}
});

test('unknown publisher and changed signed manifest are rejected before any anchor or payload read',async()=>{
  const f=await fixture();try{
    let calls=0;const options={...f.options(),readReleaseAnchor:async()=>{calls++;return f.anchor()}};
    options.publisherSpkiBase64=generateKeyPairSync('ed25519').publicKey.export({format:'der',type:'spki'}).toString('base64');
    await assert.rejects(verifyCoreRuntimePackageCandidate(options),/CORE_RELEASE_NEXOWIRE_MANIFEST_SIGNATURE_REQUIRED/);
    assert.equal(calls,0);
    const tampered=f.options();tampered.manifestUtf8=coreRuntimeManifestBytes({...f.manifest,releaseVersion:'9.9.9'});
    await assert.rejects(verifyCoreRuntimePackageCandidate(tampered),/CORE_RELEASE_NEXOWIRE_MANIFEST_SIGNATURE_REQUIRED/);
  }finally{await f.close();}
});

test('source commit, entrypoint, downgrade, sequence gap and parent hash all bind independently',async()=>{
  const f=await fixture();try{
    for(const patch of [{sourceCommit:'c'.repeat(40)},{entrypoint:'runtime/node.exe'}]){
      await assert.rejects(verifyCoreRuntimePackageCandidate(f.options({...f.manifest,...patch})),
        /CORE_RELEASE_SOURCE_OR_ENTRYPOINT_MISMATCH/);
    }
    for(const patch of [{releaseSequence:7},{releaseSequence:8},{releaseSequence:10},
      {previousManifestSha256:'f'.repeat(64)}]){
      await assert.rejects(verifyCoreRuntimePackageCandidate(f.options({...f.manifest,...patch})),
        /CORE_RELEASE_ROLLBACK_OR_CHAIN_MISMATCH/);
    }
  }finally{await f.close();}
});

test('an already accepted identical manifest is read-only/idempotent; same sequence with other bytes is denied',async()=>{
  const f=await fixture();try{
    const digest=createHash('sha256').update(coreRuntimeManifestBytes(f.manifest)).digest('hex');
    f.setAnchor({...f.anchor(),acceptedSequence:9,acceptedManifestSha256:digest});
    assert.equal((await verifyCoreRuntimePackageCandidate(f.options())).candidateFilesMatch,true);
    await assert.rejects(verifyCoreRuntimePackageCandidate(f.options({...f.manifest,releaseVersion:'1.0.9'})),
      /CORE_RELEASE_ROLLBACK_OR_CHAIN_MISMATCH/);
  }finally{await f.close();}
});

test('unavailable, mismatched or changing external release anchor fails closed',async()=>{
  const f=await fixture();try{
    await assert.rejects(verifyCoreRuntimePackageCandidate({...f.options(),readReleaseAnchor:async()=>{throw Error('TEST_OUTAGE')}}),
      /CORE_RELEASE_ANCHOR_UNAVAILABLE/);
    await assert.rejects(verifyCoreRuntimePackageCandidate({...f.options(),readReleaseAnchor:async()=>undefined}),
      /CORE_RELEASE_ANCHOR_UNVERIFIED/);
    await assert.rejects(verifyCoreRuntimePackageCandidate({...f.options(),readReleaseAnchor:async()=>({...f.anchor(),authorityId:randomUUID()})}),
      /CORE_RELEASE_ANCHOR_UNVERIFIED/);
    let count=0;
    await assert.rejects(verifyCoreRuntimePackageCandidate({...f.options(),readReleaseAnchor:async()=>
      (++count===1?f.anchor():{...f.anchor(),acceptedSequence:9,acceptedManifestSha256:'f'.repeat(64)})}),
      /CORE_RELEASE_ANCHOR_CHANGED_DURING_VERIFICATION/);
  }finally{await f.close();}
});

test('altered, missing and unlisted payload code cannot hide behind a valid manifest signature',async()=>{
  const f=await fixture();try{
    const file=path.join(f.payload,'app','dist','cli.js');
    const before=await readFile(file);await writeFile(file,'malicious substituted JS');
    await assert.rejects(verifyCoreRuntimePackageCandidate(f.options()),/CORE_RELEASE_PAYLOAD_DIGEST_MISMATCH/);
    await writeFile(file,before);
    const extra=path.join(f.payload,'app','dist','unlisted.js');await writeFile(extra,'unlisted executable code');
    await assert.rejects(verifyCoreRuntimePackageCandidate(f.options()),/CORE_RELEASE_PAYLOAD_COVERAGE_MISMATCH/);
    await rm(extra);await rm(file);
    await assert.rejects(verifyCoreRuntimePackageCandidate(f.options()),/CORE_RELEASE_PAYLOAD_COVERAGE_MISMATCH/);
  }finally{await f.close();}
});

test('file modification while final anchor readback awaits cannot return a matching candidate',async()=>{
  const f=await fixture();try{
    let calls=0;
    await assert.rejects(verifyCoreRuntimePackageCandidate({...f.options(),readReleaseAnchor:async()=>{
      if(++calls===2)await writeFile(path.join(f.payload,'app','dist','cli.js'),'changed after initial file hash');
      return f.anchor();
    }}),/CORE_RELEASE_PAYLOAD_IDENTITY_CHANGED/);
  }finally{await f.close();}
});

test('symlink payloads are never accepted as immutable code identities',async t=>{
  const f=await fixture();try{
    const original=path.join(f.payload,'app','dist','cli.js'),saved=path.join(f.root,'saved.js');
    await writeFile(saved,await readFile(original));await rm(original);
    try{await symlink(saved,original,'file')}catch(e){
      if(process.platform==='win32'&&['EPERM','EACCES'].includes((e as NodeJS.ErrnoException).code??'')){
        t.skip('OS symlink creation unavailable; not publisher/ACL acceptance');return;
      }throw e;
    }
    await assert.rejects(verifyCoreRuntimePackageCandidate(f.options()),/CORE_RELEASE_PAYLOAD_LINK_DENIED/);
  }finally{await f.close();}
});

test('hardlinked payloads are never accepted as immutable code identities',async()=>{
  const f=await fixture();try{
    const original=path.join(f.payload,'app','dist','cli.js'),saved=path.join(f.root,'saved.js');
    await writeFile(saved,await readFile(original));await rm(original);await link(saved,original);
    await assert.rejects(verifyCoreRuntimePackageCandidate(f.options()),/CORE_RELEASE_PAYLOAD_LINK_OR_TYPE_DENIED/);
  }finally{await f.close();}
});

test('Windows path aliases, ADS, traversal, duplicate case and ambiguous JSON are rejected',async()=>{
  const f=await fixture();try{
    for(const entrypoint of ['../cli.js','/cli.js','app//cli.js','app/CON.js','app/cli.js:stream','app/cli.js.','app/../cli.js']){
      assert.equal(CoreRuntimeManifestSchema.safeParse({...f.manifest,entrypoint}).success,false,entrypoint);
    }
    assert.throws(()=>coreRuntimeManifestBytes({...f.manifest,
      files:[...f.manifest.files,{...f.manifest.files[0]!,path:'APP/DIST/CLI.JS'}]}),/CORE_RELEASE_PATH_ALIAS_OR_ORDER/);
    const options=f.options();options.manifestUtf8=Buffer.from(' '+Buffer.from(options.manifestUtf8).toString('utf8'));
    await assert.rejects(verifyCoreRuntimePackageCandidate(options),/CORE_RELEASE_MANIFEST_NONCANONICAL/);
  }finally{await f.close();}
});

test('caller mutation during anchor await cannot replace the captured publisher or source pin',async()=>{
  const f=await fixture();try{
    const options=f.options();const original=options.readReleaseAnchor;
    options.readReleaseAnchor=async()=>{
      options.publisherSpkiBase64='untrusted replacement';options.expectedSourceCommit='f'.repeat(40);
      return original();
    };
    assert.equal((await verifyCoreRuntimePackageCandidate(options)).candidateFilesMatch,true);
  }finally{await f.close();}
});
