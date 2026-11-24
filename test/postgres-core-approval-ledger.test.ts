import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign,type KeyObject} from 'node:crypto';
import {readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Pool} from 'pg';
import {PostgresCoreApprovalLedger,CoreApprovalBindingSchema,CoreApprovalCredentialBindingSchema,type CoreApprovalBinding}
  from '../src/security/postgres-core-approval-ledger.js';
import {coreWebAuthnIntentHash as coreHash,type CoreWebAuthnIntent,type CoreWebAuthnAssertion}
  from '../src/security/core-webauthn-approval.js';
import type {DispatchStorePool} from '../src/agent/postgres-broker-dispatch-authority.js';
import type {CoreNativeProof} from '../src/protocol/core-native-consent-transport.js';

// Real disposable PostgreSQL storage. Software authenticator keys, provisioning,
// native readback and independent provenance are EXPLICIT TEST FIXTURES.
// No Windows Hello ceremony, protected service or physical approval is tested.
const enabled=process.env.NEXOWIRE_PG_DISPATCH_INTEGRATION==='1';
const phase=process.env.NEXOWIRE_PG_DISPATCH_RESTART_PHASE;
const integration={skip:!enabled?'DISPOSABLE_POSTGRES_NOT_REQUESTED; physical NOT_PROVEN':false,timeout:30000};
const port=Number(process.env.NEXOWIRE_PG_DISPATCH_TEST_PORT??'5432');
function pool(user:string){return new Pool({host:'127.0.0.1',port,database:'nexowire_dispatch_ci',user,
  password:'ci-only-not-a-production-credential',max:8,connectionTimeoutMillis:3000,idleTimeoutMillis:1000})}
function scope():CoreApprovalBinding{
  return {version:1,ownerAccountId:'owner-fixture-'+randomUUID(),deviceId:'device-fixture-'+randomUUID(),
    installationId:randomUUID(),enrollmentId:randomUUID(),ownerEpoch:1,grantGeneration:2,revokeEpoch:0,
    windowsSessionId:2,windowsUserSid:'S-1-5-21-101-202-303-1001',windowsLogonLuid:'000000000000a101',
    windowsLogonSessionEpoch:randomUUID()};
}
function assertion(intent:CoreWebAuthnIntent,key:KeyObject,counter=1):CoreWebAuthnAssertion{
  const challenge=coreHash(intent),client=JSON.stringify({type:'webauthn.get',
    challenge:Buffer.from(challenge,'hex').toString('base64url'),origin:'https://'+intent.rpId,crossOrigin:false});
  const auth=Buffer.alloc(37);createHash('sha256').update(intent.rpId).digest().copy(auth);
  auth[32]=0x05;auth.writeUInt32BE(counter,33);
  const bytes=Buffer.concat([auth,createHash('sha256').update(client).digest()]);
  return {version:1,kind:'core_webauthn_assertion_v1',credentialId:intent.credentialId,
    clientDataJSON:Buffer.from(client).toString('base64url'),authenticatorData:auth.toString('base64url'),
    signature:sign('sha256',bytes,key).toString('base64url'),userHandle:null,coreAuthority:false};
}
async function fixture(){
  const admin=pool('nexowire_dispatch_ci');
  try{
    await admin.query(await readFile(new URL('../sql/core-native-approval-ledger.sql',import.meta.url),'utf8'));
    await admin.query("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='nexowire_approval_runtime') THEN "+
      "CREATE ROLE nexowire_approval_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION "+
      "NOBYPASSRLS PASSWORD 'ci-only-not-a-production-credential'; END IF; END $$;");
    await admin.query('GRANT USAGE ON SCHEMA core_approval TO nexowire_approval_runtime; '+
      'GRANT SELECT ON ALL TABLES IN SCHEMA core_approval TO nexowire_approval_runtime; '+
      'GRANT UPDATE(max_seen_ms) ON core_approval.authorities TO nexowire_approval_runtime; '+
      'GRANT UPDATE(read_lock_guard) ON core_approval.bindings TO nexowire_approval_runtime; '+
      'GRANT UPDATE(signature_counter) ON core_approval.credentials TO nexowire_approval_runtime; '+
      'GRANT INSERT(challenge_id,nonce,authority_id,device_id,credential_id,intent,intent_sha256,issued_ms,expires_ms) '+
      'ON core_approval.challenges TO nexowire_approval_runtime; '+
      'GRANT UPDATE(state,receipt_id,assertion_sha256,assertion,previous_counter,next_counter,consumed_ms) '+
      'ON core_approval.challenges TO nexowire_approval_runtime; '+
      'GRANT INSERT(receipt_id,authority_id,device_id,proof_sha256,issuer_spki_sha256,consumed_ms) '+
      'ON core_approval.enrollment_consumptions TO nexowire_approval_runtime;');
  }catch(error){await admin.end();throw error;}
  const authorityId=randomUUID(),binding=scope(),keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const credentialId=randomBytes(32).toString('base64url'),rpId='core.fixture.invalid';
  await admin.query('INSERT INTO core_approval.authorities VALUES($1,$2)',[authorityId,Date.now()-1000]);
  await admin.query("INSERT INTO core_approval.bindings(authority_id,device_id,binding,state) VALUES($1,$2,$3::jsonb,'ACTIVE')",
    [authorityId,binding.deviceId,JSON.stringify(binding)]);
  await admin.query('INSERT INTO core_approval.credentials '+
    '(credential_id,authority_id,device_id,rp_id,public_key_pem,user_handle,signature_counter,active,credential_binding) '+
    'VALUES($1,$2,$3,$4,$5,NULL,0,true,$6::jsonb)',[credentialId,authorityId,binding.deviceId,rpId,
      keys.publicKey.export({format:'pem',type:'spki'}).toString(),JSON.stringify(Object.fromEntries(
        Object.keys(CoreApprovalCredentialBindingSchema.shape).map(k=>[k,(binding as Record<string,unknown>)[k]])))]);
  const runtime=pool('nexowire_approval_runtime');let native:CoreApprovalBinding|null={...binding},trusted=true;
  let protectedIssuer:string|null='a'.repeat(64);
  const config:ConstructorParameters<typeof PostgresCoreApprovalLedger>[0]={authorityId,pool:runtime as DispatchStorePool,
    verifyProvenance:async()=>({verified:trusted,authorityId,validUntil:Date.now()+10000}),
    readProtectedNativeBinding:async()=>native?{binding:{...native},observedAtMs:Date.now(),
      protectedNativeWitness:true,issuerSpkiSha256:protectedIssuer??undefined}:null};
  const create=(overrides:Partial<typeof config>={})=>new PostgresCoreApprovalLedger({...config,...overrides});
  const issue=()=>create().issueChallenge({...binding,credentialId,rpId,challengeId:randomUUID()});
  return {authorityId,binding,keys,credentialId,rpId,admin,runtime,config,create,issue,
    setNative:(v:CoreApprovalBinding|null)=>{native=v},setTrusted:(v:boolean)=>{trusted=v},
    setIssuer:(v:string|null)=>{protectedIssuer=v},
    close:async()=>{await runtime.end();await admin.end()}};
}

test('approval ledger requires independent native/restore witnesses before opening any database',async()=>{
  let connections=0;const b=scope();
  const ledger=new PostgresCoreApprovalLedger({authorityId:randomUUID(),
    pool:{async connect(){connections++;throw Error('must not connect')}},
    verifyProvenance:async()=>{throw Error('independent witness absent')},readProtectedNativeBinding:async()=>null});
  await assert.rejects(ledger.issueChallenge({...b,credentialId:'Y3JlZGVudGlhbA',rpId:'fixture.invalid',challengeId:randomUUID()}),
    /CORE_APPROVAL_WITNESS_UNAVAILABLE/);assert.equal(connections,0);
});

test('real PostgreSQL approval: consume verifies the provisioned key, updates counter and preserves scoped readback',integration,async()=>{
  const f=await fixture();try{
    const {intent}=await f.issue(),raw=assertion(intent,f.keys.privateKey);
    const receipt=await f.create().consumeAssertion(raw,intent);
    assert.equal(receipt.consumed,true);assert.equal(receipt.coreAuthority,false);
    assert.equal(receipt.physicalAcceptance,'NOT_PROVEN');assert.equal(receipt.nextSignatureCounter,1);
    assert.deepEqual(await f.create().readConsumed(receipt.receiptId,f.binding),receipt);
    assert.equal((await f.admin.query('SELECT signature_counter FROM core_approval.credentials WHERE credential_id=$1',
      [f.credentialId])).rows[0].signature_counter,'1');
    await assert.rejects(f.create().consumeAssertion(raw,intent),/CORE_APPROVAL_CHALLENGE_REPLAY_OR_SCOPE/);
    await assert.rejects(f.create().issueChallenge({...f.binding,credentialId:f.credentialId,
      rpId:f.rpId,challengeId:intent.challengeId}),/CORE_APPROVAL_CHALLENGE_REPLAY/);
  }finally{await f.close()}
});

test('real PostgreSQL approval: two service instances racing a counterless assertion consume exactly once',integration,async()=>{
  const f=await fixture();try{
    const {intent}=await f.issue(),raw=assertion(intent,f.keys.privateKey,0);
    const results=await Promise.allSettled(Array.from({length:12},()=>f.create().consumeAssertion(raw,intent)));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(results.filter(r=>r.status==='rejected').length,11);
    assert.equal((await f.admin.query('SELECT COUNT(*) AS n FROM core_approval.challenges '+
      "WHERE challenge_id=$1 AND state='CONSUMED'",[intent.challengeId])).rows[0].n,'1');
  }finally{await f.close()}
});

test('real PostgreSQL approval: lost COMMIT ACK is terminal across a new authority instance',integration,async()=>{
  const f=await fixture();try{
    const {intent}=await f.issue();let lost=false,destroyed=false;
    const wrapped:DispatchStorePool={async connect(){const c=await f.runtime.connect();return {
      query:async(sql,values=[])=>{const r=await c.query(sql,values);
        if(sql==='COMMIT'&&!lost){lost=true;throw Error('TEST_ACK_LOST_AFTER_REAL_COMMIT')}
        return {rows:r.rows as Record<string,unknown>[]}},release:(destroy=false)=>{destroyed||=destroy;c.release(destroy)}}}};
    const raw=assertion(intent,f.keys.privateKey);
    await assert.rejects(f.create({pool:wrapped}).consumeAssertion(raw,intent),/CORE_APPROVAL_TRANSACTION_UNKNOWN/);
    assert.equal(lost,true);assert.equal(destroyed,true);
    await assert.rejects(f.create().consumeAssertion(raw,intent),/CORE_APPROVAL_CHALLENGE_REPLAY_OR_SCOPE/);
    assert.equal((await f.admin.query('SELECT state FROM core_approval.challenges WHERE challenge_id=$1',
      [intent.challengeId])).rows[0].state,'CONSUMED');
  }finally{await f.close()}
});

test('real PostgreSQL approval: caller flags, forged key and substituted owner/session are never enrollment evidence',integration,async()=>{
  const f=await fixture();try{
    const {intent}=await f.issue(),raw=assertion(intent,f.keys.privateKey);
    await assert.rejects(f.create().consumeAssertion({...raw,humanApproval:true},intent));
    await assert.rejects(f.create().consumeAssertion(assertion(intent,generateKeyPairSync('ec',
      {namedCurve:'prime256v1'}).privateKey),intent),/CORE_WEBAUTHN_SIGNATURE_INVALID/);
    for(const change of [{ownerAccountId:'owner-substitution'},{windowsLogonSessionEpoch:randomUUID()},
      {grantGeneration:3},{revokeEpoch:1},{installationId:randomUUID()},{enrollmentId:randomUUID()}]){
      await assert.rejects(f.create().consumeAssertion(raw,{...intent,...change}),/CORE_APPROVAL_(?:NATIVE_BINDING_UNVERIFIED|BINDING_REVOKED_OR_STALE)/);
    }
    assert.equal((await f.admin.query('SELECT state FROM core_approval.challenges WHERE challenge_id=$1',
      [intent.challengeId])).rows[0].state,'ISSUED');
  }finally{await f.close()}
});

test('real PostgreSQL approval: stale native witness, revoke and re-pair invalidate consume and prior readback',integration,async()=>{
  const f=await fixture();try{
    const a=await f.issue(),r=await f.create().consumeAssertion(assertion(a.intent,f.keys.privateKey),a.intent);
    const b=await f.issue();
    f.setNative(null);
    await assert.rejects(f.create().consumeAssertion(assertion(b.intent,f.keys.privateKey,2),b.intent),
      /CORE_APPROVAL_NATIVE_BINDING_UNVERIFIED/);
    f.setNative({...f.binding});
    await assert.rejects(f.create({readProtectedNativeBinding:async()=>({binding:f.binding,
      observedAtMs:Date.now()-30000,protectedNativeWitness:true})}).readConsumed(r.receiptId,f.binding),
      /CORE_APPROVAL_NATIVE_BINDING_UNVERIFIED/);
    await f.admin.query("UPDATE core_approval.bindings SET state='REVOKED' WHERE authority_id=$1",[f.authorityId]);
    await assert.rejects(f.create().consumeAssertion(assertion(b.intent,f.keys.privateKey,2),b.intent),
      /CORE_APPROVAL_BINDING_REVOKED_OR_STALE/);
    await assert.rejects(f.create().readConsumed(r.receiptId,f.binding),/CORE_APPROVAL_BINDING_REVOKED_OR_STALE/);
    const other={...f.binding,ownerAccountId:'another-owner-account',ownerEpoch:2,grantGeneration:3};
    await f.admin.query("UPDATE core_approval.bindings SET state='ACTIVE',binding=$2::jsonb WHERE authority_id=$1",
      [f.authorityId,JSON.stringify(other)]);f.setNative(other);
    await assert.rejects(f.create().readConsumed(r.receiptId,other),/CORE_APPROVAL_RECEIPT_SCOPE_INVALID/);
    await assert.rejects(f.create().issueChallenge({...other,credentialId:f.credentialId,rpId:f.rpId,
      challengeId:randomUUID()}),/CORE_APPROVAL_CREDENTIAL_NOT_PROVISIONED/);
  }finally{await f.close()}
});

test('real PostgreSQL approval: provenance and native binding are re-read after cryptographic verification',integration,async()=>{
  const f=await fixture();try{
    const {intent}=await f.issue(),raw=assertion(intent,f.keys.privateKey);let reads=0;
    const l=f.create({readProtectedNativeBinding:async()=>++reads===1?{binding:f.binding,
      observedAtMs:Date.now(),protectedNativeWitness:true}:null});
    await assert.rejects(l.consumeAssertion(raw,intent),/CORE_APPROVAL_NATIVE_BINDING_UNVERIFIED/);
    assert.equal(reads,2);
    assert.equal((await f.admin.query('SELECT state FROM core_approval.challenges WHERE challenge_id=$1',
      [intent.challengeId])).rows[0].state,'ISSUED');
    f.setTrusted(false);await assert.rejects(f.create().consumeAssertion(raw,intent),/CORE_APPROVAL_PROVENANCE_UNVERIFIED/);
  }finally{await f.close()}
});

test('real PostgreSQL approval: controlled expiry during final witness await denies before durable consume',integration,async()=>{
  const f=await fixture();try{
    const {intent}=await f.issue();let reads=0,expired=false;
    // Real transactions/rows, with an explicit synthetic clock adapter. This
    // measures expiry handling without a 120-second sleep or OS clock change.
    const wrapped:DispatchStorePool={async connect(){const c=await f.runtime.connect();return {
      query:async(sql,values=[])=>{const r=await c.query(sql,values);
        if(expired&&sql.includes('clock_timestamp()'))return {rows:[{now_ms:String(intent.expiresAtMs)}]};
        return {rows:r.rows as Record<string,unknown>[]}},release:(destroy=false)=>c.release(destroy)}}};
    await assert.rejects(f.create({pool:wrapped,readProtectedNativeBinding:async()=>{
      if(++reads===2)expired=true;
      return {binding:f.binding,observedAtMs:Date.now(),protectedNativeWitness:true};
    }}).consumeAssertion(assertion(intent,f.keys.privateKey),intent),/CORE_APPROVAL_CHALLENGE_EXPIRED/);
    assert.equal(expired,true);
    assert.equal((await f.admin.query('SELECT state FROM core_approval.challenges WHERE challenge_id=$1',
      [intent.challengeId])).rows[0].state,'ISSUED');
  }finally{await f.close()}
});

test('real PostgreSQL approval: a controlled late ACK denies the receipt and retains its consumed tombstone',integration,async()=>{
  const f=await fixture(),realNow=Date.now;try{
    const {intent}=await f.issue(),raw=assertion(intent,f.keys.privateKey);
    const wrapped:DispatchStorePool={async connect(){const c=await f.runtime.connect();return {
      query:async(sql,values=[])=>{const r=await c.query(sql,values);
        if(sql==='COMMIT')Date.now=()=>intent.expiresAtMs+1;
        return {rows:r.rows as Record<string,unknown>[]}},release:(destroy=false)=>c.release(destroy)}}};
    try{await assert.rejects(f.create({pool:wrapped}).consumeAssertion(raw,intent),
      /CORE_APPROVAL_ACK_EXPIRED_OR_UNKNOWN/)}finally{Date.now=realNow}
    await assert.rejects(f.create().consumeAssertion(raw,intent),/CORE_APPROVAL_CHALLENGE_REPLAY_OR_SCOPE/);
    assert.equal((await f.admin.query('SELECT state FROM core_approval.challenges WHERE challenge_id=$1',
      [intent.challengeId])).rows[0].state,'CONSUMED');
  }finally{Date.now=realNow;await f.close()}
});

test('real PostgreSQL approval: credential counters cannot be replayed through a different fresh challenge',integration,async()=>{
  const f=await fixture();try{
    const a=await f.issue();await f.create().consumeAssertion(assertion(a.intent,f.keys.privateKey,4),a.intent);
    const b=await f.issue();
    await assert.rejects(f.create().consumeAssertion(assertion(b.intent,f.keys.privateKey,4),b.intent),
      /CORE_WEBAUTHN_SIGNATURE_COUNTER_REPLAY/);
    await assert.rejects(f.create().consumeAssertion(assertion(b.intent,f.keys.privateKey,0),b.intent),
      /CORE_WEBAUTHN_SIGNATURE_COUNTER_REPLAY/);
    const r=await f.create().consumeAssertion(assertion(b.intent,f.keys.privateKey,5),b.intent);
    assert.equal(r.previousSignatureCounter,4);assert.equal(r.nextSignatureCounter,5);
  }finally{await f.close()}
});

test('real PostgreSQL approval: revoke after COMMIT blocks final readback and preserves one-use history',integration,async()=>{
  const f=await fixture();try{
    const {intent}=await f.issue(),raw=assertion(intent,f.keys.privateKey);let revoked=false;
    const wrapped:DispatchStorePool={async connect(){const c=await f.runtime.connect();return {
      query:async(sql,values=[])=>{const r=await c.query(sql,values);
        if(sql==='COMMIT'&&!revoked){revoked=true;
          await f.admin.query("UPDATE core_approval.bindings SET state='REVOKED' WHERE authority_id=$1",[f.authorityId]);}
        return {rows:r.rows as Record<string,unknown>[]}},release:(destroy=false)=>c.release(destroy)}}};
    await assert.rejects(f.create({pool:wrapped}).consumeAssertion(raw,intent),/CORE_APPROVAL_BINDING_REVOKED_OR_STALE/);
    assert.equal(revoked,true);
    assert.equal((await f.admin.query('SELECT state FROM core_approval.challenges WHERE challenge_id=$1',
      [intent.challengeId])).rows[0].state,'CONSUMED');
    await assert.rejects(f.create().consumeAssertion(raw,intent),/CORE_APPROVAL_BINDING_REVOKED_OR_STALE/);
  }finally{await f.close()}
});

test('real PostgreSQL approval: even a forged consumed DB flag cannot replace the authenticator signature in readback',integration,async()=>{
  const f=await fixture();try{
    const {intent}=await f.issue(),raw=assertion(intent,f.keys.privateKey,0),receiptId=randomUUID();
    const signature=Buffer.from(raw.signature,'base64url');signature[signature.length-1]=signature[signature.length-1]!^1;
    const forged={...raw,signature:signature.toString('base64url')};
    await f.runtime.query("UPDATE core_approval.challenges SET state='CONSUMED',receipt_id=$2,"+
      'assertion_sha256=$3,assertion=$4::jsonb,previous_counter=0,next_counter=0,consumed_ms=$5 WHERE challenge_id=$1',
      [intent.challengeId,receiptId,'f'.repeat(64),JSON.stringify(forged),Date.now()]);
    await assert.rejects(f.create().readConsumed(receiptId,f.binding),/CORE_WEBAUTHN_SIGNATURE_INVALID/);
    await assert.rejects(f.create().consumeAssertion(raw,intent),/CORE_APPROVAL_CHALLENGE_REPLAY_OR_SCOPE/);
  }finally{await f.close()}
});

test('real PostgreSQL approval: key rewrite, history erase/reopen and counter rollback are denied',integration,async()=>{
  const f=await fixture();try{
    const {intent}=await f.issue();await f.create().consumeAssertion(assertion(intent,f.keys.privateKey),intent);
    await assert.rejects(f.runtime.query('UPDATE core_approval.credentials SET public_key_pem=$2 WHERE credential_id=$1',
      [f.credentialId,'substituted-key']),/permission denied/i);
    await assert.rejects(f.runtime.query('UPDATE core_approval.credentials SET signature_counter=0 WHERE credential_id=$1',
      [f.credentialId]),/CORE_APPROVAL_CREDENTIAL_REWRITE_DENIED/);
    await assert.rejects(f.runtime.query("UPDATE core_approval.challenges SET state='ISSUED' WHERE challenge_id=$1",
      [intent.challengeId]),/CORE_APPROVAL_HISTORY_REWRITE_DENIED/);
    await assert.rejects(f.runtime.query('DELETE FROM core_approval.challenges WHERE challenge_id=$1',
      [intent.challengeId]),/permission denied/i);
    await assert.rejects(f.runtime.query('UPDATE core_approval.bindings SET binding=$2::jsonb WHERE authority_id=$1',
      [f.authorityId,JSON.stringify({...f.binding,ownerEpoch:2})]),/permission denied/i);
    await assert.rejects(f.runtime.query('UPDATE core_approval.bindings SET read_lock_guard=true WHERE authority_id=$1',
      [f.authorityId]),/check constraint/i);
    await assert.rejects(f.create({pool:f.admin as DispatchStorePool}).issueChallenge({...f.binding,
      credentialId:f.credentialId,rpId:f.rpId,challengeId:randomUUID()}),/CORE_APPROVAL_ROLE_OVERPRIVILEGED/);
  }finally{await f.close()}
});

// Software EC/native witnesses here are explicit fixtures. Real PostgreSQL
// verifies durable one-use semantics, not a physical Windows approval ceremony.
async function approved(f:Awaited<ReturnType<typeof fixture>>):Promise<CoreNativeProof>{
  const {intent}=await f.issue(),r=await f.create().consumeAssertion(assertion(intent,f.keys.privateKey,0),intent);
  return {...f.binding,challengeId:intent.challengeId,receiptId:r.receiptId,
    approvedAtMs:r.consumedAtMs,consumed:true};
}

test('real PostgreSQL enrollment: approval readback cannot replace the separate one-use D1 handoff',integration,async()=>{
  const f=await fixture();try{
    const p=await approved(f);
    await assert.rejects(f.create().readEnrollmentProof(p.receiptId,f.binding),/CORE_APPROVAL_ENROLLMENT_NOT_CONSUMED/);
    assert.deepEqual(await f.create().consumeForEnrollment(p,'a'.repeat(64)),p);
    assert.deepEqual(await f.create().readEnrollmentProof(p.receiptId,f.binding),p);
    await assert.rejects(f.create().consumeForEnrollment(p,'a'.repeat(64)),/CORE_APPROVAL_ENROLLMENT_REPLAY/);
    await assert.rejects(f.create().consumeForEnrollment(p,'b'.repeat(64)),/CORE_APPROVAL_ISSUER_UNVERIFIED/);
    assert.equal((await f.admin.query('SELECT issuer_spki_sha256 FROM core_approval.enrollment_consumptions '+
      'WHERE receipt_id=$1',[p.receiptId])).rows[0].issuer_spki_sha256,'a'.repeat(64));
    for(const sql of ['UPDATE core_approval.enrollment_consumptions SET consumed_ms=1',
      'DELETE FROM core_approval.enrollment_consumptions','TRUNCATE core_approval.enrollment_consumptions']){
      await assert.rejects(f.runtime.query(sql),/permission denied/i);
    }
    await assert.rejects(f.admin.query('UPDATE core_approval.enrollment_consumptions SET consumed_ms=consumed_ms+1 '+
      'WHERE receipt_id=$1',[p.receiptId]),/CORE_APPROVAL_ENROLLMENT_HISTORY_REWRITE_DENIED/);
  }finally{await f.close()}
});

test('real PostgreSQL enrollment: requested issuer must match independent protected readback',integration,async()=>{
  const f=await fixture();try{
    const p=await approved(f);
    // Caller-supplied issuer hashes cannot be proved by merely writing them
    // into the immutable handoff row. Deny mismatch and absent native issuer
    // before connecting or inserting any enrollment consumption.
    await assert.rejects(f.create().consumeForEnrollment(p,'b'.repeat(64)),
      /CORE_APPROVAL_ISSUER_UNVERIFIED/);
    f.setIssuer(null);
    await assert.rejects(f.create().consumeForEnrollment(p,'a'.repeat(64)),
      /CORE_APPROVAL_ISSUER_UNVERIFIED/);
    assert.equal((await f.admin.query('SELECT COUNT(*) AS n FROM core_approval.enrollment_consumptions '+
      'WHERE receipt_id=$1',[p.receiptId])).rows[0].n,'0');
    f.setIssuer('a'.repeat(64));
    assert.deepEqual(await f.create().consumeForEnrollment(p,'a'.repeat(64)),p);
    // After durable COMMIT, a mismatched or rotated protected issuer forbids
    // readback but must never reopen the already-consumed one-use receipt.
    f.setIssuer('b'.repeat(64));
    await assert.rejects(f.create().readEnrollmentProof(p.receiptId,f.binding),
      /CORE_APPROVAL_ISSUER_UNVERIFIED/);
    await assert.rejects(f.create().consumeForEnrollment(p,'b'.repeat(64)),
      /CORE_APPROVAL_ENROLLMENT_REPLAY/);
    assert.equal((await f.admin.query('SELECT COUNT(*) AS n FROM core_approval.enrollment_consumptions '+
      'WHERE receipt_id=$1',[p.receiptId])).rows[0].n,'1');
  }finally{await f.close()}
});

test('real PostgreSQL enrollment: issuer changes during native witness await deny before INSERT',integration,async()=>{
  const f=await fixture();try{
    const p=await approved(f);let reads=0;
    const ledger=f.create({readProtectedNativeBinding:async(expected,signal)=>{
      const current=await f.config.readProtectedNativeBinding(expected,signal);
      reads++;
      return current?{...current,issuerSpkiSha256:(reads===2?'b':'a').repeat(64)}:null;
    }});
    // Initial readback matches A, but the second independent witness (inside
    // the transaction, before the irreversible INSERT) reports issuer B.
    await assert.rejects(ledger.consumeForEnrollment(p,'a'.repeat(64)),
      /CORE_APPROVAL_ISSUER_UNVERIFIED/);
    assert.equal(reads,2,'the protected issuer is checked again inside the transaction');
    assert.equal((await f.admin.query('SELECT COUNT(*) AS n FROM core_approval.enrollment_consumptions '+
      'WHERE receipt_id=$1',[p.receiptId])).rows[0].n,'0',
      'a changed issuer cannot leave a committed enrollment receipt');
    assert.deepEqual(await f.create().consumeForEnrollment(p,'a'.repeat(64)),p);
  }finally{await f.close()}
});

test('real PostgreSQL enrollment: issuer rotation after DB clock read denies handoff before INSERT',integration,async()=>{
  const f=await fixture();try{
    const p=await approved(f);let flipped=false;
    // The independent native witness is initially issuer A. A real SQL clock
    // read finishes, then a concurrent protected issuer rotation becomes
    // observable BEFORE the permanent handoff INSERT. A witness checked
    // before the awaited SQL read would miss this race and consume the receipt.
    const guarded:DispatchStorePool={async connect(){const c=await f.runtime.connect();return {
      query:async(sql,values=[])=>{
        const result=await c.query(sql,values);
        if(sql.includes('clock_timestamp()')&&!flipped){
          flipped=true;f.setIssuer('b'.repeat(64));
        }
        return {rows:result.rows as Record<string,unknown>[]};
      },release:(destroy=false)=>c.release(destroy),
    }}};
    await assert.rejects(f.create({pool:guarded}).consumeForEnrollment(p,'a'.repeat(64)),
      /CORE_APPROVAL_ISSUER_UNVERIFIED/);
    assert.equal(flipped,true,'the protected issuer was rotated after a genuine SQL clock read');
    assert.equal((await f.admin.query('SELECT COUNT(*) AS n FROM core_approval.enrollment_consumptions '+
      'WHERE receipt_id=$1',[p.receiptId])).rows[0].n,'0',
      'no one-use enrollment tombstone may be inserted after issuer rotation');
    f.setIssuer('a'.repeat(64));
    assert.deepEqual(await f.create().consumeForEnrollment(p,'a'.repeat(64)),p,
      'a failed pre-INSERT check did not consume the one-use handoff');
  }finally{await f.close()}
});

test('real PostgreSQL enrollment: issuer changes after COMMIT deny ACK but preserve tombstone',integration,async()=>{
  const f=await fixture();try{
    const p=await approved(f);let switched=false;
    const wrapped:DispatchStorePool={async connect(){const c=await f.runtime.connect();return {
      query:async(sql,values=[])=>{
        const result=await c.query(sql,values);
        if(sql==='COMMIT'&&!switched){switched=true;f.setIssuer('b'.repeat(64))}
        return {rows:result.rows as Record<string,unknown>[]};
      },release:(destroy=false)=>c.release(destroy),
    }}};
    await assert.rejects(f.create({pool:wrapped}).consumeForEnrollment(p,'a'.repeat(64)),
      /CORE_APPROVAL_ISSUER_UNVERIFIED/);
    assert.equal(switched,true,'native issuer changed only after the durable COMMIT');
    const rows=(await f.admin.query('SELECT issuer_spki_sha256 FROM core_approval.enrollment_consumptions '+
      'WHERE receipt_id=$1',[p.receiptId])).rows;
    assert.equal(rows.length,1,'the previously consumed receipt remains durable');
    assert.equal(rows[0].issuer_spki_sha256,'a'.repeat(64));
    await assert.rejects(f.create().readEnrollmentProof(p.receiptId,f.binding),
      /CORE_APPROVAL_ISSUER_UNVERIFIED/);
    await assert.rejects(f.create().consumeForEnrollment(p,'b'.repeat(64)),
      /CORE_APPROVAL_ENROLLMENT_REPLAY/);
    f.setIssuer('a'.repeat(64));
    assert.deepEqual(await f.create().readEnrollmentProof(p.receiptId,f.binding),p,
      'restoring matching protected issuer only permits read-only reconciliation');
    await assert.rejects(f.create().consumeForEnrollment(p,'a'.repeat(64)),
      /CORE_APPROVAL_ENROLLMENT_REPLAY/);
  }finally{await f.close()}
});

test('real PostgreSQL enrollment: independent verifiers racing the same receipt admit exactly one',integration,async()=>{
  const f=await fixture();try{
    const p=await approved(f);
    const outcomes=await Promise.allSettled(Array.from({length:12},()=>f.create().consumeForEnrollment(p,'a'.repeat(64))));
    assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(outcomes.filter(r=>r.status==='rejected').length,11);
    assert.equal((await f.admin.query('SELECT COUNT(*) AS n FROM core_approval.enrollment_consumptions '+
      'WHERE receipt_id=$1',[p.receiptId])).rows[0].n,'1');
  }finally{await f.close()}
});

test('real PostgreSQL enrollment: lost handoff COMMIT ACK never becomes a successful retry',integration,async()=>{
  const f=await fixture();try{
    const p=await approved(f);let lost=false,destroyed=false;
    const wrapped:DispatchStorePool={async connect(){const c=await f.runtime.connect();return {
      query:async(sql,values=[])=>{const r=await c.query(sql,values);
        if(sql==='COMMIT'&&!lost){lost=true;throw Error('TEST_ENROLLMENT_ACK_LOST_AFTER_COMMIT')}
        return {rows:r.rows as Record<string,unknown>[]}},release:(destroy=false)=>{destroyed||=destroy;c.release(destroy)}}}};
    await assert.rejects(f.create({pool:wrapped}).consumeForEnrollment(p,'a'.repeat(64)),/CORE_APPROVAL_TRANSACTION_UNKNOWN/);
    assert.equal(lost,true);assert.equal(destroyed,true);
    await assert.rejects(f.create().consumeForEnrollment(p,'a'.repeat(64)),/CORE_APPROVAL_ENROLLMENT_REPLAY/);
    // Read-only reconciliation is possible, but it never authorizes a retry.
    assert.deepEqual(await f.create().readEnrollmentProof(p.receiptId,f.binding),p);
  }finally{await f.close()}
});

test('real PostgreSQL enrollment: forged receipt fields and current native session changes deny handoff',integration,async()=>{
  const f=await fixture();try{
    const p=await approved(f);
    for(const change of [{challengeId:randomUUID()},{approvedAtMs:p.approvedAtMs+1},
      {ownerAccountId:'forged-owner-account'},{windowsLogonSessionEpoch:randomUUID()},
      {windowsUserSid:'S-1-5-18'},{grantGeneration:3},{revokeEpoch:1}]){
      await assert.rejects(f.create().consumeForEnrollment({...p,...change},'a'.repeat(64)),
        /CORE_APPROVAL_(?:ENROLLMENT_PROOF_MISMATCH|NATIVE_BINDING_UNVERIFIED)/);
    }
    assert.equal((await f.admin.query('SELECT COUNT(*) AS n FROM core_approval.enrollment_consumptions '+
      'WHERE receipt_id=$1',[p.receiptId])).rows[0].n,'0');
    await f.create().consumeForEnrollment(p,'a'.repeat(64));
    f.setNative({...f.binding,windowsLogonSessionEpoch:randomUUID()});
    await assert.rejects(f.create().readEnrollmentProof(p.receiptId,f.binding),/CORE_APPROVAL_NATIVE_BINDING_UNVERIFIED/);
  }finally{await f.close()}
});

test('real PostgreSQL enrollment: database-clock expiry and final-witness revoke reject without reopening history',integration,async()=>{
  const f=await fixture();try{
    const p=await approved(f);
    const advanced:DispatchStorePool={async connect(){const c=await f.runtime.connect();return {
      query:async(sql,values=[])=>{const r=await c.query(sql,values);
        if(sql.includes('clock_timestamp()'))return {rows:[{now_ms:p.approvedAtMs+120000}]};
        return {rows:r.rows as Record<string,unknown>[]}},release:(destroy=false)=>c.release(destroy)}}};
    await assert.rejects(f.create({pool:advanced}).consumeForEnrollment(p,'a'.repeat(64)),/CORE_APPROVAL_ENROLLMENT_PROOF_EXPIRED/);
    let reads=0;
    await assert.rejects(f.create({readProtectedNativeBinding:async()=>++reads===1?{binding:f.binding,
      observedAtMs:Date.now(),protectedNativeWitness:true,issuerSpkiSha256:'a'.repeat(64)}:null})
      .consumeForEnrollment(p,'a'.repeat(64)),
      /CORE_APPROVAL_NATIVE_BINDING_UNVERIFIED/);
    assert.equal((await f.admin.query('SELECT COUNT(*) AS n FROM core_approval.enrollment_consumptions '+
      'WHERE receipt_id=$1',[p.receiptId])).rows[0].n,'0');
    assert.deepEqual(await f.create().consumeForEnrollment(p,'a'.repeat(64)),p);
  }finally{await f.close()}
});

test('real PostgreSQL enrollment: revoke after handoff COMMIT suppresses readback and preserves the tombstone',integration,async()=>{
  const f=await fixture();try{
    const p=await approved(f);let revoked=false;
    const wrapped:DispatchStorePool={async connect(){const c=await f.runtime.connect();return {
      query:async(sql,values=[])=>{const r=await c.query(sql,values);
        if(sql==='COMMIT'&&!revoked){revoked=true;
          await f.admin.query("UPDATE core_approval.bindings SET state='REVOKED' WHERE authority_id=$1",[f.authorityId]);}
        return {rows:r.rows as Record<string,unknown>[]}},release:(destroy=false)=>c.release(destroy)}}};
    await assert.rejects(f.create({pool:wrapped}).consumeForEnrollment(p,'a'.repeat(64)),/CORE_APPROVAL_BINDING_REVOKED_OR_STALE/);
    assert.equal((await f.admin.query('SELECT COUNT(*) AS n FROM core_approval.enrollment_consumptions '+
      'WHERE receipt_id=$1',[p.receiptId])).rows[0].n,'1');
  }finally{await f.close()}
});

test('real PostgreSQL enrollment: a controlled late ACK denies success without undoing consumption',integration,async()=>{
  const f=await fixture(),realNow=Date.now;try{
    const p=await approved(f);
    const wrapped:DispatchStorePool={async connect(){const c=await f.runtime.connect();return {
      query:async(sql,values=[])=>{const r=await c.query(sql,values);
        if(sql==='COMMIT')Date.now=()=>p.approvedAtMs+120001;
        return {rows:r.rows as Record<string,unknown>[]}},release:(destroy=false)=>c.release(destroy)}}};
    try{await assert.rejects(f.create({pool:wrapped}).consumeForEnrollment(p,'a'.repeat(64)),
      /CORE_APPROVAL_ENROLLMENT_ACK_EXPIRED_OR_UNKNOWN/)}finally{Date.now=realNow}
    await assert.rejects(f.create().consumeForEnrollment(p,'a'.repeat(64)),/CORE_APPROVAL_ENROLLMENT_REPLAY/);
  }finally{Date.now=realNow;await f.close()}
});

test('real PostgreSQL restart: native approval tombstone and counter survive actual database restart',{
  ...integration,skip:!enabled||!phase?'separate staged real restart; physical NOT_PROVEN':false,
},async()=>{
  const filename=path.join(process.env.RUNNER_TEMP??os.tmpdir(),'nexowire-approval-restart-fixture.json');
  if(phase==='seed'){
    const f=await fixture();try{
      const {intent}=await f.issue(),raw=assertion(intent,f.keys.privateKey,0);
      const receipt=await f.create().consumeAssertion(raw,intent);
      const proof:CoreNativeProof={...f.binding,challengeId:intent.challengeId,receiptId:receipt.receiptId,
        approvedAtMs:receipt.consumedAtMs,consumed:true};
      await f.create().consumeForEnrollment(proof,'a'.repeat(64));
      const started=(await f.admin.query('SELECT pg_postmaster_start_time() AS started')).rows[0].started as Date;
      await writeFile(filename,JSON.stringify({authorityId:f.authorityId,binding:f.binding,intent,raw,
        receipt,proof,serverStarted:started.toISOString()}),{mode:0o600});
    }finally{await f.close()}
    return;
  }
  assert.equal(phase,'verify');
  const saved=JSON.parse(await readFile(filename,'utf8')) as {authorityId:string;binding:CoreApprovalBinding;
    intent:CoreWebAuthnIntent;raw:CoreWebAuthnAssertion;receipt:{receiptId:string};
    proof:CoreNativeProof;serverStarted:string};
  CoreApprovalBindingSchema.parse(saved.binding);
  const runtime=pool('nexowire_approval_runtime');
  try{
    const started=(await runtime.query('SELECT pg_postmaster_start_time() AS started')).rows[0].started as Date;
    assert.ok(started.getTime()>new Date(saved.serverStarted).getTime(),'actual PostgreSQL process must restart');
    const ledger=new PostgresCoreApprovalLedger({authorityId:saved.authorityId,pool:runtime as DispatchStorePool,
      verifyProvenance:async()=>({verified:true,authorityId:saved.authorityId,validUntil:Date.now()+10000}),
      readProtectedNativeBinding:async()=>({binding:saved.binding,observedAtMs:Date.now(),
        protectedNativeWitness:true,issuerSpkiSha256:'a'.repeat(64)})});
    await assert.rejects(ledger.consumeAssertion(saved.raw,saved.intent),/CORE_APPROVAL_CHALLENGE_REPLAY_OR_SCOPE/);
    const receipt=await ledger.readConsumed(saved.receipt.receiptId,saved.binding);
    assert.equal(receipt.coreAuthority,false);assert.equal(receipt.consumed,true);
    assert.deepEqual(await ledger.readEnrollmentProof(saved.receipt.receiptId,saved.binding),saved.proof);
    await assert.rejects(ledger.consumeForEnrollment(saved.proof,'a'.repeat(64)),/CORE_APPROVAL_ENROLLMENT_REPLAY/);
  }finally{await runtime.end();await rm(filename,{force:true})}
});
