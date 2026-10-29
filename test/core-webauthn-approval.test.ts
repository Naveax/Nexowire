import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {prepareCoreWebAuthnChallenge,verifyCoreWebAuthnAssertion,consumeCoreWebAuthnApproval,
  type CoreWebAuthnIntent,type CoreWebAuthnAssertion,type PinnedCoreWebAuthnCredential,
  type CoreWebAuthnConsumeReceipt,type VerifiedCoreWebAuthnAssertion}
  from '../src/security/core-webauthn-approval.js';

// Software EC keys explicitly simulate an authenticator for cryptographic
// regressions. They are NOT Windows Hello, TPM attestation or human approval.
function fixture(counter=1,previous=0){
  const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const credentialId=randomBytes(32).toString('base64url');
  const challenge=prepareCoreWebAuthnChallenge({version:1,challengeId:randomUUID(),
    ownerAccountId:'owner-account-fixture',deviceId:'device-fixture-0001',installationId:randomUUID(),
    enrollmentId:randomUUID(),ownerEpoch:1,grantGeneration:2,revokeEpoch:0,windowsSessionId:2,
    windowsUserSid:'S-1-5-21-101-202-303-1001',windowsLogonLuid:'000000000000a101',
    windowsLogonSessionEpoch:randomUUID(),rpId:'core.fixture.invalid',credentialId});
  const auth=Buffer.alloc(37);createHash('sha256').update(challenge.intent.rpId).digest().copy(auth);
  auth[32]=0x05;auth.writeUInt32BE(counter,33);
  const signed=Buffer.concat([auth,createHash('sha256').update(challenge.clientDataJSON).digest()]);
  const assertion:CoreWebAuthnAssertion={version:1,kind:'core_webauthn_assertion_v1',credentialId,
    clientDataJSON:Buffer.from(challenge.clientDataJSON).toString('base64url'),
    authenticatorData:auth.toString('base64url'),signature:sign('sha256',signed,keys.privateKey).toString('base64url'),
    userHandle:null,coreAuthority:false};
  const credential:PinnedCoreWebAuthnCredential={credentialId,
    publicKeyPem:keys.publicKey.export({format:'pem',type:'spki'}).toString(),userHandle:null,
    previousSignatureCounter:previous};
  return {...challenge,assertion,credential,keys,auth};
}
function receipt(v:Readonly<VerifiedCoreWebAuthnAssertion>):CoreWebAuthnConsumeReceipt{
  return {challengeId:v.intent.challengeId,nonce:v.intent.nonce,intentSha256:v.intentSha256,
    credentialSpkiSha256:v.credentialSpkiSha256,previousSignatureCounter:v.previousSignatureCounter,
    nextSignatureCounter:v.nextSignatureCounter,consumed:true};
}

test('genuine EC signature over a nonce-bound fixture assertion verifies cryptography without granting CORE',()=>{
  const f=fixture(),v=verifyCoreWebAuthnAssertion(f.assertion,f.intent,f.credential);
  assert.equal(v.nextSignatureCounter,1);assert.equal(v.authenticatorUserPresence,true);
  assert.equal(v.authenticatorUserVerification,true);assert.equal(v.coreAuthority,false);
  assert.equal(v.physicalAcceptance,'NOT_PROVEN');assert.equal(Object.isFrozen(v.intent),true);
});

for(const field of ['ownerAccountId','deviceId','installationId','enrollmentId','ownerEpoch',
  'grantGeneration','revokeEpoch','windowsUserSid','windowsSessionId','windowsLogonLuid',
  'windowsLogonSessionEpoch','nonce'] as const){
  test('WebAuthn signature cannot migrate to another '+field,()=>{
    const f=fixture();const other={...f.intent};
    const old=other[field];
    (other as Record<string,unknown>)[field]=typeof old==='number'?old+1:
      field==='nonce'?'a'.repeat(64):field==='windowsUserSid'?'S-1-5-18':
      field==='windowsLogonLuid'?'000000000000b202':
      ['installationId','enrollmentId','windowsLogonSessionEpoch'].includes(field)?randomUUID():'changed-fixture-account';
    assert.throws(()=>verifyCoreWebAuthnAssertion(f.assertion,other,f.credential),/CORE_WEBAUTHN_CLIENT_DATA_UNBOUND/);
  });
}

test('absent UP or UV, synchronized credentials and unrecognized authenticator flags fail closed',()=>{
  const f=fixture();
  for(const flags of [0,1,4,0x0d,0x1d,0x45,0x85,0x25]){
    const auth=Buffer.from(f.auth);auth[32]=flags;
    assert.throws(()=>verifyCoreWebAuthnAssertion({...f.assertion,authenticatorData:auth.toString('base64url')},
      f.intent,f.credential),/CORE_WEBAUTHN_USER_VERIFICATION_REQUIRED/);
  }
});

test('credential, owner user handle, issuer key and RPID are independently pinned',()=>{
  const f=fixture();
  assert.throws(()=>verifyCoreWebAuthnAssertion({...f.assertion,credentialId:randomBytes(32).toString('base64url')},
    f.intent,f.credential),/CORE_WEBAUTHN_CREDENTIAL_NOT_PINNED/);
  assert.throws(()=>verifyCoreWebAuthnAssertion({...f.assertion,userHandle:'d3Jvbmc'},f.intent,f.credential),
    /CORE_WEBAUTHN_CREDENTIAL_NOT_PINNED/);
  const other=fixture();
  assert.throws(()=>verifyCoreWebAuthnAssertion(f.assertion,f.intent,
    {...f.credential,publicKeyPem:other.credential.publicKeyPem}),/CORE_WEBAUTHN_SIGNATURE_INVALID/);
  const auth=Buffer.from(f.auth);auth[0]=auth[0]!^1;
  assert.throws(()=>verifyCoreWebAuthnAssertion({...f.assertion,authenticatorData:auth.toString('base64url')},
    f.intent,f.credential),/CORE_WEBAUTHN_RP_ID_MISMATCH/);
});

test('stale, future, overlong challenges and fake approval flags never become authenticator evidence',()=>{
  const f=fixture(),now=Date.now();
  for(const changes of [{expiresAtMs:now-1},{issuedAtMs:now+60000},
    {expiresAtMs:f.intent.issuedAtMs+120001}]){
    assert.throws(()=>verifyCoreWebAuthnAssertion(f.assertion,{...f.intent,...changes},f.credential,now),
      /CORE_WEBAUTHN_CHALLENGE_STALE/);
  }
  assert.throws(()=>verifyCoreWebAuthnAssertion({...f.assertion,coreAuthority:true},f.intent,f.credential));
  assert.throws(()=>verifyCoreWebAuthnAssertion({...f.assertion,humanApproval:true},f.intent,f.credential));
});

test('signature counter rollback is rejected; counterless credentials still require one-use consume',async()=>{
  const stale=fixture(3,3);
  assert.throws(()=>verifyCoreWebAuthnAssertion(stale.assertion,stale.intent,stale.credential),
    /CORE_WEBAUTHN_SIGNATURE_COUNTER_REPLAY/);
  const f=fixture(0,0);let used=false;
  const testOnlyConsume=async(v:Readonly<VerifiedCoreWebAuthnAssertion>)=>{
    if(used)return null;used=true;return receipt(v);
  };
  assert.equal((await consumeCoreWebAuthnApproval(f.assertion,f.intent,f.credential,testOnlyConsume)).coreAuthority,false);
  await assert.rejects(consumeCoreWebAuthnApproval(f.assertion,f.intent,f.credential,testOnlyConsume),
    /CORE_WEBAUTHN_CONSUMPTION_DENIED/);
});

test('lost consume ACK is terminal: the same authenticator assertion cannot be replayed',async()=>{
  const f=fixture();let consumed=false;
  const testOnlyConsume=async(v:Readonly<VerifiedCoreWebAuthnAssertion>)=>{
    if(consumed)return null;consumed=true;void v;throw Error('TEST_ACK_LOST_AFTER_DURABLE_CONSUME');
  };
  await assert.rejects(consumeCoreWebAuthnApproval(f.assertion,f.intent,f.credential,testOnlyConsume),
    /CORE_WEBAUTHN_CONSUMPTION_UNKNOWN/);
  await assert.rejects(consumeCoreWebAuthnApproval(f.assertion,f.intent,f.credential,testOnlyConsume),
    /CORE_WEBAUTHN_CONSUMPTION_DENIED/);
});

test('mismatched durable consume and expiry during acknowledgement deny the assertion',async()=>{
  const f=fixture();
  await assert.rejects(consumeCoreWebAuthnApproval(f.assertion,f.intent,f.credential,
    async v=>({...receipt(v),nonce:'f'.repeat(64)})),/CORE_WEBAUTHN_CONSUMPTION_DENIED/);
  const realNow=Date.now;
  try{
    await assert.rejects(consumeCoreWebAuthnApproval(f.assertion,f.intent,f.credential,async v=>{
      Date.now=()=>f.intent.expiresAtMs+1;return receipt(v);
    }),/CORE_WEBAUTHN_CHALLENGE_STALE/);
  }finally{Date.now=realNow;}
});

test('noncanonical encoding, duplicate JSON keys, extra authenticator data and forged signatures fail',()=>{
  const f=fixture();
  assert.throws(()=>verifyCoreWebAuthnAssertion({...f.assertion,clientDataJSON:f.assertion.clientDataJSON+'='},f.intent,f.credential));
  assert.throws(()=>verifyCoreWebAuthnAssertion({...f.assertion,
    clientDataJSON:Buffer.from(f.clientDataJSON.replace('"type":','"type":"untrusted","type":')).toString('base64url')},
    f.intent,f.credential),/CORE_WEBAUTHN_CLIENT_DATA_UNBOUND/);
  assert.throws(()=>verifyCoreWebAuthnAssertion({...f.assertion,
    authenticatorData:Buffer.concat([f.auth,Buffer.from([0])]).toString('base64url')},f.intent,f.credential),
    /CORE_WEBAUTHN_ENCODING_INVALID/);
  const changed=Buffer.from(f.assertion.signature,'base64url');changed[changed.length-1]=changed[changed.length-1]!^1;
  assert.throws(()=>verifyCoreWebAuthnAssertion({...f.assertion,signature:changed.toString('base64url')},
    f.intent,f.credential),/CORE_WEBAUTHN_SIGNATURE_INVALID/);
});

test('native source requires the system WebAuthn API, user verification and never installs or grants authority',()=>{
  const source=readFileSync(new URL('../native/windows-core-webauthn-approval.c',import.meta.url),'utf8');
  assert.match(source,/WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED/);
  assert.match(source,/LOAD_LIBRARY_SEARCH_SYSTEM32/);
  assert.match(source,/WebAuthNAuthenticatorGetAssertion/);
  assert.match(source,/WebAuthNCancelCurrentOperation/);
  assert.doesNotMatch(source,/\b(?:ShellExecute|CreateService|AdjustTokenPrivileges|SwitchDesktop|SendInput|MessageBox)\w*\s*\(/);
});

test('real Windows API probe never opens approval UI or grants CORE',{
  skip:process.platform!=='win32'?'Windows-only WebAuthn API presence; physical approval NOT_PROVEN':false,
  timeout:20000,
},t=>{
  const exe=fileURLToPath(new URL('../native/windows-core-webauthn-approval.exe',import.meta.url));
  for(const args of [[],['--approve'],['--assert'],['--assert','bad/rp','a'.repeat(64),'00']]){
    const invalid=spawnSync(exe,args,{encoding:'utf8',timeout:3000,windowsHide:true});
    assert.equal(invalid.status,64,String(invalid.error??invalid.stderr));assert.equal(invalid.stdout,'');
  }
  const result=spawnSync(exe,['--probe'],{encoding:'utf8',timeout:5000,windowsHide:true});
  assert.ok(result.status===0||result.status===77,String(result.error??result.stderr));
  const raw=JSON.parse(result.stdout) as Record<string,unknown>;
  assert.equal(raw.coreAuthority,false);
  if(result.status===77){t.skip('OS WebAuthn API unavailable; no human approval evidence');return;}
  assert.equal(raw.kind,'core_webauthn_api_probe_v1');assert.equal(raw.physicalAcceptance,'NOT_PROVEN');
  assert.ok(Number.isInteger(raw.apiVersion)&&Number(raw.apiVersion)>0);
  t.diagnostic('OS_API_PRESENCE_ONLY; no assertion, credential creation or human interaction was attempted');
});
