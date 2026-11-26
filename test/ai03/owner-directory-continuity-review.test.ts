import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign,type KeyObject} from 'node:crypto';
import {CoreApprovalBindingSchema} from '../../src/security/postgres-core-approval-ledger.js';
import {createOwnerDirectoryContinuityReview} from '../../src/security/owner-directory-continuity-review.js';

type Config=Parameters<typeof createOwnerDirectoryContinuityReview>[0];
type Query=Parameters<Config['readDirectory']>[0];
const key=()=>generateKeyPairSync('ed25519');
const pem=(k:KeyObject)=>k.export({type:'spki',format:'pem'}).toString();
function signed(value:object,domain:string,k:KeyObject){
  const payload=Buffer.from(JSON.stringify(value));
  return {payload:payload.toString('base64url'),signature:sign(null,
    Buffer.concat([Buffer.from(domain+'\0'),payload]),k).toString('base64url')};
}
// Deterministic JSON for the validated registration state (ASCII field names).
function canonical(value:unknown):string{
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  const object=value as Record<string,unknown>;
  return '{'+Object.keys(object).sort().map(k=>JSON.stringify(k)+':'+canonical(object[k])).join(',')+'}';
}
// Synthetic signatures exercise only the read-only audit. They do not install
// or authorize either source and cannot manufacture a consent proof.
function fixture(){
  const directory=key(),witness=key(),authorityId=randomUUID(),directoryId=randomUUID();
  const scope={ownerAccountId:'owner-fixture-0001',deviceId:'device-fixture-0001',installationId:randomUUID()};
  const original={version:1,kind:'core_owner_directory_registration_v1',authorityId,directoryId,
    generation:5,restoreEpoch:randomUUID(),state:'REGISTERED',
    binding:CoreApprovalBindingSchema.parse({version:1,...scope,enrollmentId:randomUUID(),
      ownerEpoch:1,grantGeneration:1,revokeEpoch:0,windowsSessionId:1,
      windowsUserSid:'S-1-5-21-101-202-303-1001',windowsLogonLuid:'0000000000000001',
      windowsLogonSessionEpoch:randomUUID()}),
    issuerSpkiSha256:'a'.repeat(64),rpId:'core.fixture.invalid',credentialId:'AA'};
  let record=structuredClone(original),latest=structuredClone(original),last:unknown;
  let directoryCalls=0,witnessCalls=0;
  const config:Config={authorityId,directoryId,scope,directoryPublicKeyPem:pem(directory.publicKey),
    continuityPublicKeyPem:pem(witness.publicKey),
    async readDirectory(q){
      directoryCalls++;
      assert.deepEqual(Object.keys(q).sort(),['authorityId','directoryId','nonce','scope']);
      assert.ok(Object.isFrozen(q)&&Object.isFrozen(q.scope));
      last=signed({...record,nonce:q.nonce,observedAtMs:Date.now()},
        'nexowire.owner-directory.registration.v1',directory.privateKey);
      return last;
    },
    async readContinuity(q){
      witnessCalls++;
      return signed({version:1,kind:'core_owner_directory_continuity_v1',authorityId,directoryId,
        nonce:q.nonce,scope,generation:latest.generation,restoreEpoch:latest.restoreEpoch,
        registrationSha256:createHash('sha256').update(canonical(latest),'utf8').digest('hex'),
        observedAtMs:Date.now()},'nexowire.owner-directory.continuity.v1',witness.privateKey);
    }};
  return {config,directory,witness,original,setRecord:(v:typeof original)=>{record=structuredClone(v);},
    setLatest:(v:typeof original)=>{latest=structuredClone(v);},last:()=>last,
    counts:()=>[directoryCalls,witnessCalls]};
}
const signal=()=>new AbortController().signal;
const denial=/CORE_OWNER_DIRECTORY_REVIEW_UNVERIFIED/;
test('independent directory review matches only registered current state and grants no authority',async()=>{
  const f=fixture(),review=createOwnerDirectoryContinuityReview(f.config);
  const first=await review(signal());
  assert.equal(first.generation,5);assert.equal(first.status,'REVIEW_MATCH');
  assert.equal(first.coreAuthority,false);assert.equal(first.physicalAcceptance,'NOT_PROVEN');
  assert.deepEqual(Object.keys(first).sort(),['coreAuthority','generation','physicalAcceptance','registrationSha256','restoreEpoch','status']);
  const updated={...f.original,generation:6,issuerSpkiSha256:'b'.repeat(64)};
  f.setRecord(updated);f.setLatest(updated);
  assert.equal((await review(signal())).generation,6);
  assert.deepEqual(f.counts(),[2,2]);
});
test('a new reviewer rejects restored directory even when the old snapshot is freshly signed',async()=>{
  const f=fixture();
  f.setLatest({...f.original,generation:6,restoreEpoch:randomUUID()});
  await assert.rejects(createOwnerDirectoryContinuityReview(f.config)(signal()),denial);
  f.setLatest({...f.original,binding:{...f.original.binding,enrollmentId:randomUUID()}});
  await assert.rejects(createOwnerDirectoryContinuityReview(f.config)(signal()),denial);
  f.setLatest({...f.original,issuerSpkiSha256:'b'.repeat(64)});
  await assert.rejects(createOwnerDirectoryContinuityReview(f.config)(signal()),denial);
});
test('process-local generation fence rejects rewind and same-generation equivocation even if both sources agree',async()=>{
  const f=fixture(),review=createOwnerDirectoryContinuityReview(f.config);
  await review(signal());
  for(const bad of [{...f.original,generation:4},{...f.original,restoreEpoch:randomUUID()},
    {...f.original,issuerSpkiSha256:'b'.repeat(64)}]){
    f.setRecord(bad);f.setLatest(bad);
    await assert.rejects(review(signal()),denial);
  }
});
test('directory review denies replay, same signing identity, bad signature, wrong scope and noncanonical credential',async()=>{
  const f=fixture(),review=createOwnerDirectoryContinuityReview(f.config);
  await review(signal());const old=f.last();
  await assert.rejects(createOwnerDirectoryContinuityReview({...f.config,readDirectory:async()=>old})(signal()),denial);
  assert.throws(()=>createOwnerDirectoryContinuityReview({...f.config,
    continuityPublicKeyPem:f.config.directoryPublicKeyPem}),denial);
  assert.throws(()=>createOwnerDirectoryContinuityReview({...f.config,
    directoryPublicKeyPem:f.directory.privateKey.export({type:'pkcs8',format:'pem'}).toString()}),denial);
  await assert.rejects(createOwnerDirectoryContinuityReview({...f.config,
    readDirectory:async(q:Query)=>{
      const reply=await f.config.readDirectory(q,signal()) as {payload:string;signature:string};
      return {...reply,signature:Buffer.alloc(64).toString('base64url')};
    }})(signal()),denial);
  for(const bad of [{...f.original,binding:{...f.original.binding,ownerAccountId:'owner-fixture-0002'}},
    {...f.original,credentialId:'AB'}]){
    f.setRecord(bad);f.setLatest(bad);
    await assert.rejects(createOwnerDirectoryContinuityReview(f.config)(signal()),denial);
  }
});
test('missing or cancelled continuity cannot produce a review match',async()=>{
  const f=fixture(),controller=new AbortController();
  await assert.rejects(createOwnerDirectoryContinuityReview({...f.config,
    readContinuity:async()=>{throw Error('unavailable');}})(signal()),denial);
  await assert.rejects(createOwnerDirectoryContinuityReview({...f.config,
    readContinuity:async()=>{controller.abort();return null;}})(controller.signal),denial);
});
