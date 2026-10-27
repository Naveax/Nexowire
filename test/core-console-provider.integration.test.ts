import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync,type StatementSync} from 'node:sqlite';
import {createHash,createPrivateKey,createPublicKey,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {D1CoreConsoleAuthority} from '../src/product/d1-core-console-authority.js';
import {canonicalCoreConsoleEnrollment} from '../src/agent/core-console-enrollment-policy.js';
import {coreOperationBytes} from '../src/protocol/core-console-authority.js';
import type {D1DatabaseLike,D1PreparedStatementLike} from '../src/product/d1-control-plane-store.js';
import {createControlPlaneHttpHandler} from '../src/product/control-plane-http.js';
import {CoreConsoleAdmission} from '../src/agent/core-console-admission.js';
import {CoreConsoleAuthorityClient,WindowsCoreConsoleProvider,type CoreProfileStore,
  type NativeCoreConsentProof,type NativeCoreConsentChallenge} from '../src/agent/windows-core-console-provider.js';
import {executeCapability} from '../src/agent/executors.js';
import {CoreNativeDenial} from '../src/agent/windows-core-console-native.js';
import {NEXOWIRE_VERSION} from '../src/version.js';
import {PathPolicy} from '../src/agent/path-policy.js';

class Statement implements D1PreparedStatementLike {
  constructor(private readonly s:StatementSync,private readonly values:unknown[]=[] ){}
  bind(...v:unknown[]){return new Statement(this.s,v);}
  async first<T>():Promise<T|null>{return (this.s.get(...this.values as never[])??null) as T|null;}
  async all<T>(){return {success:true,results:this.s.all(...this.values as never[]) as T[]};}
  async run<T>(){const r=this.s.run(...this.values as never[]);return {success:true,meta:{changes:Number(r.changes)}};}
}
type Profile=NonNullable<Awaited<ReturnType<CoreProfileStore['load']>>>;
const deviceId='device-core-0001',owner='owner-account-0001';
const credential='nwx_dev_'+createHash('sha256').update('isolated core fixture').digest('hex');
function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE accounts(id TEXT PRIMARY KEY);INSERT INTO accounts VALUES('${owner}');
    CREATE TABLE devices(id TEXT PRIMARY KEY,owner_account_id TEXT,credential_hash TEXT,platform TEXT,
      access_mode TEXT,online INTEGER,privilege_mode TEXT,admin_bridge_ready INTEGER);
    INSERT INTO devices VALUES('${deviceId}','${owner}','${createHash('sha256').update(credential).digest('hex')}',
      'win32','full',1,'broker',1);`);
  for(const file of ['0014_device_maintenance_preferences.sql','0015_device_bridge_preferences.sql',
    '0019_core_console_authority.sql','0020_core_console_native_logon_binding.sql'])
    db.exec(readFileSync(new URL('../cloudflare/migrations/'+file,import.meta.url),'utf8'));
  db.exec(`INSERT INTO device_maintenance_preferences VALUES('${deviceId}','${owner}',1,'2026-10-24');
    INSERT INTO device_bridge_preferences VALUES('${deviceId}','${owner}','auto','2026-10-24');`);
  // Idempotent migration must not reset existing counters, keys or requests.
  db.exec(readFileSync(new URL('../cloudflare/migrations/0019_core_console_authority.sql',import.meta.url),'utf8'));
  const d1:D1DatabaseLike={prepare:sql=>new Statement(db.prepare(sql)),
    batch:async statements=>{db.exec('BEGIN');try{const r=await Promise.all(statements.map(s=>s.run()));db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
  // In-memory fixture is explicitly NOT a trusted native OS approval source.
  let nativeReceipt:NativeCoreConsentProof|null=null,readbackEnabled=true,authorityReadbackEnabled=true;
  let currentLogon={windowsUserSid:'S-1-5-21-101-202-303-1001',windowsSessionId:1,
    windowsLogonLuid:'0000000000000001',windowsLogonSessionEpoch:randomUUID()};
  let beforeNativeReadback:(()=>void)|undefined;
  const consumedNativeReceipts=new Set<string>();
  const sameLogon=(proof:NativeCoreConsentProof)=>proof.windowsUserSid===currentLogon.windowsUserSid&&
    proof.windowsSessionId===currentLogon.windowsSessionId&&
    proof.windowsLogonLuid===currentLogon.windowsLogonLuid&&
    proof.windowsLogonSessionEpoch===currentLogon.windowsLogonSessionEpoch;
  const authority=new D1CoreConsoleAuthority(d1,{verifyAndConsume:async(proof,expected)=>{
    if(!readbackEnabled||!nativeReceipt||consumedNativeReceipts.has(proof.receiptId)||
      (Object.keys(nativeReceipt) as Array<keyof NativeCoreConsentProof>)
        .some(key=>proof[key]!==nativeReceipt![key])||
      proof.enrollmentId!==expected.enrollmentId||!sameLogon(proof))return false;
    consumedNativeReceipts.add(proof.receiptId);return true;
  },currentReadback:async expected=>{
    // Negative QA hook models a remote revoke/re-pair while native OS
    // verification is pending. The synthetic native side may still say yes.
    const hook=beforeNativeReadback;beforeNativeReadback=undefined;hook?.();
    return authorityReadbackEnabled&&!!nativeReceipt&&
    nativeReceipt.ownerAccountId===expected.ownerAccountId&&
    nativeReceipt.deviceId===expected.deviceId&&
    nativeReceipt.installationId===expected.installationId&&
    nativeReceipt.enrollmentId===expected.enrollmentId&&
    nativeReceipt.ownerEpoch===expected.ownerEpoch&&
    nativeReceipt.grantGeneration===expected.grantGeneration&&
    nativeReceipt.revokeEpoch===expected.revokeEpoch&&
    nativeReceipt.receiptId===expected.nativeConsentReceiptId&&
    nativeReceipt.windowsUserSid===expected.windowsUserSid&&
    nativeReceipt.windowsSessionId===expected.windowsSessionId&&
    nativeReceipt.windowsLogonLuid===expected.windowsLogonLuid&&
    nativeReceipt.windowsLogonSessionEpoch===expected.windowsLogonSessionEpoch&&sameLogon(nativeReceipt);
  }});
  const handler=createControlPlaneHttpHandler({} as never,{authenticate:async()=>null,coreConsoleAuthority:authority});
  let beforeRequest:((body:Record<string,unknown>)=>void)|undefined;
  const fetcher=(async(input,init)=>{const request=new Request(String(input),init);
    beforeRequest?.(JSON.parse(String(init?.body)));return handler(request);}) as typeof fetch;
  const client=new CoreConsoleAuthorityClient('https://core.example',credential,fetcher);
  let record:Profile|null=null,stopped=false,blocked=false,consents=0,effects=0,desktop=true,bridge=true;
  let forgedNativeReceipt:((value:NativeCoreConsentProof)=>NativeCoreConsentProof)|undefined;
  let onNative:(()=>Promise<void>)|undefined;
  const store:CoreProfileStore={stopFile:'fixture-only-STOP',load:async()=>structuredClone(record),
    save:async p=>{record=structuredClone(p);},stop:async()=>{stopped=true;},clearStop:async()=>{stopped=false;},stopped:async()=>stopped,
    block:async()=>{blocked=true;},clearBlock:async()=>{blocked=false;},blocked:async()=>blocked};
  const options={deviceId,authority:client,store,
    broker:{probe:async()=>({reachable:bridge,elevated:bridge,version:NEXOWIRE_VERSION})},
    // SYNTHETIC native receipt/readback fixture. It has no protected Windows
    // signer, human consent or real independent OS logon provenance.
    nativeConsent:{
      approveAndConsume:async(challenge:NativeCoreConsentChallenge)=>{
        consents++;
        const next:NativeCoreConsentProof={...challenge,receiptId:randomUUID(),
          ...currentLogon,approvedAtMs:Date.now(),consumed:true};
        nativeReceipt=forgedNativeReceipt?.(next)??next;
        return structuredClone(nativeReceipt);
      },
      currentReadback:async(receiptId:string)=>readbackEnabled&&nativeReceipt?.receiptId===receiptId&&sameLogon(nativeReceipt)
        ?structuredClone(nativeReceipt):null,
    },
    native:async()=>{effects++;await onNative?.();return {data:{syntheticNativeEffect:true}};},
    monitor:{desktopAllowed:()=>desktop,close:()=>{}},
  };
  const make=async(withNativeConsent=true)=>{
    const provider=new WindowsCoreConsoleProvider({...options,
      nativeConsent:withNativeConsent?options.nativeConsent:undefined});
    await provider.initialize();
    return {provider,controller:new CoreConsoleAdmission(undefined,provider)};
  };
  return {db,d1,authority,client,store,make,consents:()=>consents,effects:()=>effects,
    profile:()=>structuredClone(record)!,setProfile:(p:Profile)=>{record=structuredClone(p);},
    setDesktop:(v:boolean)=>{desktop=v;},setBridge:(v:boolean)=>{bridge=v;},
    setNativeReadback:(v:boolean)=>{readbackEnabled=v;},
    setAuthorityReadback:(v:boolean)=>{authorityReadbackEnabled=v;},
    setCurrentLogon:(v:typeof currentLogon)=>{currentLogon={...v};},
    duringNativeReadback:(cb:()=>void)=>{beforeNativeReadback=cb;},
    forgedNativeReceipt:(f:typeof forgedNativeReceipt)=>{forgedNativeReceipt=f;},
    nativeReceipt:()=>nativeReceipt,
    replaceNativeReceipt:(v:NativeCoreConsentProof)=>{nativeReceipt=v;},
    before:(cb:typeof beforeRequest)=>{beforeRequest=cb;},native:(cb:typeof onNative)=>{onNative=cb;}};
}
async function enable(f:ReturnType<typeof fixture>){const runtime=await f.make();
  assert.equal(await runtime.controller.enroll(new AbortController().signal),true);return runtime;}
const policy=new PathPolicy(['*']);
async function input(controller:CoreConsoleAdmission,id=randomUUID()){
  return executeCapability('windows.pointer.move',{hwnd:'0x123',x:0,y:0},policy,
    {accessMode:'full',requestId:id,coreConsole:controller});
}

test('real provider + HTTP handler + D1 SQL enroll, sign, dispatch and restart without repeated consent',async()=>{
  const f=fixture();try{
    const {controller}=await enable(f);assert.equal((await controller.status('full')).active,true);
    assert.deepEqual(await input(controller),{data:{syntheticNativeEffect:true}});
    assert.equal(f.consents(),1);assert.equal(f.effects(),1);
    const restarted=await f.make();assert.equal((await restarted.controller.status('full')).active,true);
    controller.close();assert.equal((await controller.status('full')).active,false,'closed providers cannot admit new input');
    await input(restarted.controller);assert.equal(f.consents(),1);assert.equal(f.effects(),2);
    assert.equal(await restarted.controller.enroll(new AbortController().signal),true);
    assert.equal(f.consents(),1,'valid existing enrollment must not show another prompt');
    assert.equal(f.db.prepare('SELECT count(*) n FROM device_core_console_operations WHERE state=\'succeeded\'').get()?.n,2);
  }finally{f.db.close();}
});

test('CORE enrollment retry updates only un-enrolled devices and cannot requeue an existing signed certificate',async()=>{
  const f=fixture();try{
    await f.authority.requestEnrollment(deviceId,owner);
    const pending=await f.authority.deviceStatus(deviceId,owner);
    assert.equal(pending.localEnrolled,false);
    assert.equal(pending.enrollmentRequested,true);
    await f.authority.requestEnrollment(deviceId,owner); // an initial stalled request is retryable
    await enable(f);
    const enrolled=await f.authority.deviceStatus(deviceId,owner);
    assert.equal(enrolled.localEnrolled,true);
    assert.equal(enrolled.enrollmentRequested,false);
    await assert.rejects(f.authority.requestEnrollment(deviceId,owner),/CORE_ALREADY_ENROLLED/);
    const after=await f.authority.deviceStatus(deviceId,owner);
    assert.equal(after.enrollmentRequested,false);
    assert.equal(after.localEnrolled,true);
    assert.equal(after.active,false,'enrollment never fabricates a fresh signed activity receipt');
    await assert.rejects(f.authority.requestEnrollment(deviceId,'foreign-owner'),/CORE_DEVICE_NOT_READY/);
  }finally{f.db.close();}
});

test('CORE OFF->ON invalidates an old signed backup; only new local consent can restore access',async()=>{
  const f=fixture();try{
    const {controller}=await enable(f);const backup=f.profile();
    f.db.exec('UPDATE device_maintenance_preferences SET enabled=0');
    assert.equal((await controller.status('full')).active,false);
    await assert.rejects(input(controller));assert.equal(f.effects(),0);
    f.db.exec('UPDATE device_maintenance_preferences SET enabled=1');f.setProfile(backup);
    const restored=await f.make();assert.equal((await restored.controller.status('full')).active,false);
    await assert.rejects(input(restored.controller));assert.equal(f.effects(),0);
    await restored.controller.enroll(new AbortController().signal);
    await input(restored.controller);assert.equal(f.effects(),1);assert.equal(f.consents(),2);
  }finally{f.db.close();}
});

test('SAFE, owner/re-pair, changed issuer, Broker loss and locked/private desktops fail closed',async()=>{
  const cases=["UPDATE devices SET access_mode='safe'","UPDATE devices SET owner_account_id='other-owner-0001'",
    "UPDATE devices SET credential_hash='"+'a'.repeat(64)+"'",
    "UPDATE device_core_console_authority SET public_key_spki='"+Buffer.alloc(44).toString('base64')+"'",
    "UPDATE device_bridge_preferences SET desired_mode='off'",
    "DELETE FROM device_maintenance_preferences"];
  for(const sql of cases){const f=fixture();try{const {controller}=await enable(f);f.db.exec(sql);
    assert.equal((await controller.status('full')).active,false,sql);await assert.rejects(input(controller));assert.equal(f.effects(),0);
  }finally{f.db.close();}}
  const f=fixture();try{const {controller}=await enable(f);
    assert.equal((await controller.status('safe')).active,false);
    f.setBridge(false);assert.equal((await controller.status('full')).active,false);
    f.setBridge(true);f.setDesktop(false);const locked=await controller.status('full');
    assert.equal(locked.active,false);assert.equal(locked.localEnrolled,true,'desktop denial does not erase a verified enrollment');
    await assert.rejects(input(controller));assert.equal(f.effects(),0);
  }finally{f.db.close();}
});

test('external one-use operation IDs prevent replay across a completely new local controller',async()=>{
  const f=fixture();try{const a=await enable(f);const id=randomUUID();await input(a.controller,id);
    const b=await f.make();await assert.rejects(input(b.controller,id));assert.equal(f.effects(),1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM device_core_console_operations').get()?.n,1);
  }finally{f.db.close();}
});

test('CORE OFF in the reserve->claim race prevents the actual native callback',async()=>{
  const f=fixture();try{const {controller}=await enable(f);
    f.before(body=>{if(body.action==='claim')f.db.exec('UPDATE device_maintenance_preferences SET enabled=0');});
    await assert.rejects(input(controller));assert.equal(f.effects(),0);
  }finally{f.db.close();}
});

test('parallel Agent instances cannot execute the same externally reserved input twice',async()=>{
  const f=fixture();try{const a=await enable(f),b=await f.make(),id=randomUUID();
    const results=await Promise.allSettled([input(a.controller,id),input(b.controller,id)]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.effects(),1);
  }finally{f.db.close();}
});

test('STOP persists locally and externally; restoring a local backup cannot borrow old CORE',async()=>{
  const f=fixture();try{const {controller}=await enable(f);const backup=f.profile();
    await controller.revoke();assert.equal(await f.store.stopped(),true);
    assert.equal((await controller.status('full')).active,false);f.setProfile(backup);await f.store.clearStop();
    const restored=await f.make();assert.equal((await restored.controller.status('full')).active,false);
    await assert.rejects(input(restored.controller));assert.equal(f.effects(),0);
  }finally{f.db.close();}
});

test('lost native ACK is UNKNOWN and is never replayed or treated as an empty journal',async()=>{
  const f=fixture();try{const {controller}=await enable(f);const id=randomUUID();
    f.native(async()=>{throw new Error('native transport lost after possible input');});
    await assert.rejects(input(controller,id));assert.equal(f.effects(),1);
    assert.equal(f.db.prepare('SELECT state FROM device_core_console_operations WHERE request_id=?').get(id)?.state,'unknown');
    const restarted=await f.make();await assert.rejects(input(restarted.controller,id));assert.equal(f.effects(),1);
  }finally{f.db.close();}
});

test('authority endpoint requires current paired credential and binds HTTPS response nonce',async()=>{
  const f=fixture();try{const runtime=await enable(f);
    const profile=f.profile();await assert.rejects(f.authority.handle('nwx_dev_invalidcredential',{
      action:'read',deviceId,installationId:profile.installationId,nonce:randomUUID(),issuedAtMs:Date.now()}),/UNAUTHENTICATED/);
    const fake=new CoreConsoleAuthorityClient('https://core.example',credential,(async()=>Response.json({nonce:randomUUID(),state:{}})) as typeof fetch);
    await assert.rejects(fake.call(profile,'read'),/UNBOUND/);
    assert.throws(()=>new CoreConsoleAuthorityClient('http://core.example',credential),/HTTPS_REQUIRED/);
    assert.equal((await runtime.controller.status('full')).active,true);
  }finally{f.db.close();}
});

test('a new local consent drains old native work before clearing persistent STOP',async()=>{
  const f=fixture();try{
    const {controller}=await enable(f);let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});f.native(async()=>gate);
    const old=input(controller).catch(e=>e);
    for(let i=0;i<50&&f.effects()===0;i++)await new Promise<void>(r=>setImmediate(r));
    assert.equal(f.effects(),1);await controller.revoke();
    let enrolled=false;
    const renewed=controller.enroll(new AbortController().signal).then(result=>{enrolled=result;});
    for(let i=0;i<10;i++)await new Promise<void>(r=>setImmediate(r));
    assert.equal(enrolled,false);assert.equal(await f.store.stopped(),true);
    release();await old;await renewed;
    assert.equal(enrolled,true);assert.equal(await f.store.stopped(),false);
    assert.equal((await controller.status('full')).active,true);
  }finally{f.db.close();}
});

test('signed status reports reject nonce replay and stop claiming ACTIVE when stale or revoked',async()=>{
  const f=fixture();try{
    await enable(f);let report:unknown;
    f.before(body=>{if(body.action==='report')report=structuredClone(body);});
    await f.client.call(f.profile(),'report',{active:true});
    const readyStatus=await f.authority.deviceStatus(deviceId,owner);
    assert.equal(readyStatus.active,true);
    assert.equal(readyStatus.localEnrolled,true);
    assert.equal(readyStatus.enrollmentRequested,false);
    assert.equal(readyStatus.deviceReady,true);
    await assert.rejects(f.authority.handle(credential,report),/NONCE_REPLAY/);
    f.db.exec('UPDATE device_core_console_authority SET status_observed_at_ms=0');
    assert.equal((await f.authority.deviceStatus(deviceId,owner)).active,false);
    f.db.exec('UPDATE device_maintenance_preferences SET enabled=0');
    const status=await f.authority.deviceStatus(deviceId,owner);
    assert.equal(status.active,false);assert.equal(status.localEnrolled,false);
    assert.equal(status.deviceReady,false);
  }finally{f.db.close();}
});

test('a proven pre-effect native denial does not discard an otherwise valid local CORE enrollment',async()=>{
  const f=fixture();try{const {controller}=await enable(f);
    f.native(async()=>{throw new CoreNativeDenial('target is no longer foreground');});
    await assert.rejects(input(controller));
    assert.equal((await controller.status('full')).active,true);assert.equal(f.consents(),1);
    assert.equal(f.db.prepare("SELECT state FROM device_core_console_operations").get()?.state,'denied');
    f.native(undefined);await input(controller);assert.equal(f.consents(),1);
  }finally{f.db.close();}
});


test('enrollment is registered once: a new nonce cannot re-register the same signed certificate',async()=>{
  const f=fixture();try{
    await enable(f);
    const profile=f.profile();
    const key=createPrivateKey({key:Buffer.from(profile.privateKey!,'base64'),format:'der',type:'pkcs8'});
    const spki=createPublicKey(key).export({format:'der',type:'spki'}).toString('base64');
    await assert.rejects(f.client.call(profile,'enroll',{
      certificate:profile.certificate,publicKeySpki:spki,
      nativeConsent:profile.nativeConsent,
    }),/CORE_AUTHORITY_DENIED_/);
    assert.equal((await f.authority.deviceStatus(deviceId,owner)).localEnrolled,true);
  }finally{f.db.close();}
});

test('external DB clock rejects signed stale and future local enrollment decisions',async()=>{
  const f=fixture();try{
    const installationId=randomUUID();
    const read=await f.authority.handle(credential,{
      action:'read',deviceId,installationId,nonce:randomUUID(),issuedAtMs:Date.now(),
    });
    const state=read.state;
    const pair=generateKeyPairSync('ed25519');
    const der=pair.publicKey.export({format:'der',type:'spki'});
    for(const approvedLocallyAtMs of [state.authorityTimeMs-3600000,state.authorityTimeMs+60000]){
      const enrollment={version:1 as const,scope:'physical-console' as const,
        ownerAccountId:owner,deviceId,installationId,enrollmentId:randomUUID(),
        ownerEpoch:state.ownerEpoch,grantGeneration:state.grantGeneration,
        revokeEpoch:state.revokeEpoch,approvedLocallyAtMs,
        issuerSpkiSha256:createHash('sha256').update(der).digest('hex')};
      const certificate={enrollment,signatureBase64:sign(null,
        canonicalCoreConsoleEnrollment(enrollment),pair.privateKey).toString('base64')};
      const request={action:'enroll' as const,deviceId,installationId,
        nonce:randomUUID(),issuedAtMs:Date.now(),certificate,
        publicKeySpki:der.toString('base64')};
      const signature=sign(null,coreOperationBytes(request),pair.privateKey).toString('base64');
      await assert.rejects(f.authority.handle(credential,{...request,signature}),
        /CORE_LOCAL_DECISION_NOT_FRESH/);
    }
    assert.equal((await f.authority.deviceStatus(deviceId,owner)).localEnrolled,false);
  }finally{f.db.close();}
});

test('missing protected native consent provider cannot show local approval or reuse a legacy certificate',async()=>{
  const f=fixture();try{
    const bare=await f.make(false);
    assert.equal((await bare.controller.status('full')).localEnrolled,false);
    assert.equal((await bare.controller.status('full')).state,'LOCAL_ENROLLMENT_REQUIRED');
    f.setBridge(false);
    assert.equal((await bare.controller.status('full')).state,'LOCAL_ENROLLMENT_REQUIRED',
      'native provider absence takes priority over missing Broker');
    f.setBridge(true);
    assert.equal(await bare.controller.enroll(new AbortController().signal),false);
    assert.equal(f.consents(),0);
    assert.equal((await f.authority.deviceStatus(deviceId,owner)).localEnrolled,false);
    const approved=await enable(f);
    assert.equal((await approved.controller.status('full')).active,true,'synthetic fixture only');
    const after=await f.make(false);
    const status=await after.controller.status('full');
    assert.equal(status.localEnrolled,false,'legacy DPAPI certificate alone never satisfies native readback');
    assert.equal(status.active,false);
    assert.equal(status.state,'LOCAL_ENROLLMENT_REQUIRED');
    await assert.rejects(input(after.controller));assert.equal(f.effects(),0);
  }finally{f.db.close();}
});

test('legacy local proof without session epoch remains revocable but never admits',async()=>{
  const f=fixture();try{
    const enrolled=await enable(f);const legacy=f.profile();
    const legacyProof={...legacy.nativeConsent!} as Partial<NativeCoreConsentProof>;
    delete legacyProof.windowsLogonSessionEpoch;
    legacy.nativeConsent=legacyProof as unknown as NativeCoreConsentProof;
    f.setProfile(legacy);
    const restarted=await f.make();
    const status=await restarted.controller.status('full');
    assert.equal(status.localEnrolled,false);assert.equal(status.active,false);
    await assert.rejects(input(restarted.controller));assert.equal(f.effects(),0);
    await assert.doesNotReject(restarted.provider.revoke());
    enrolled.controller.close();
  }finally{f.db.close();}
});

test('D1 persists exact receipt and Windows owner/logon binding for independent readback',async()=>{
  const f=fixture();try{
    await enable(f);const proof=f.nativeReceipt()!;
    const row=f.db.prepare('SELECT native_consent_receipt_id,windows_user_sid,windows_session_id,windows_logon_luid,windows_logon_session_epoch FROM device_core_console_authority').get() as Record<string,unknown>;
    assert.equal(row.native_consent_receipt_id,proof.receiptId);
    assert.equal(row.windows_user_sid,proof.windowsUserSid);
    assert.equal(row.windows_session_id,proof.windowsSessionId);
    assert.equal(row.windows_logon_luid,proof.windowsLogonLuid);
    assert.equal(row.windows_logon_session_epoch,proof.windowsLogonSessionEpoch);
    f.db.exec(`UPDATE device_core_console_authority SET windows_logon_session_epoch='${randomUUID()}'`);
    assert.equal((await f.authority.deviceStatus(deviceId,owner)).localEnrolled,false,
      'changed D1 session epoch must fail independent native readback');
  }finally{f.db.close();}
});

test('owner Windows logoff or new login session invalidates old consent and blocks effects',async()=>{
  const f=fixture();try{
    const {controller}=await enable(f);assert.equal((await controller.status('full')).active,true);
    f.setCurrentLogon({windowsUserSid:'S-1-5-21-101-202-303-1001',windowsSessionId:2,
      windowsLogonLuid:'0000000000000002',windowsLogonSessionEpoch:randomUUID()});
    assert.equal((await controller.status('full')).localEnrolled,false);
    assert.equal((await controller.status('full')).active,false);
    assert.equal((await f.authority.deviceStatus(deviceId,owner)).localEnrolled,false);
    await assert.rejects(input(controller));assert.equal(f.effects(),0);
  }finally{f.db.close();}
});

test('a login-session switch before or after D1 claim never reaches the native callback',async()=>{
  for(const switchPoint of ['before-claim','after-claim'] as const){
    const f=fixture();try{
      const {controller}=await enable(f);let claimed=false;
      const newLogon=()=>f.setCurrentLogon({windowsUserSid:'S-1-5-21-101-202-303-1001',
        windowsSessionId:2,windowsLogonLuid:'0000000000000002',windowsLogonSessionEpoch:randomUUID()});
      f.before(body=>{
        if(body.action==='claim'){
          if(switchPoint==='before-claim')newLogon();else claimed=true;
        }else if(body.action==='read'&&switchPoint==='after-claim'&&claimed){
          claimed=false;newLogon();
        }
      });
      const requestId=randomUUID();
      await assert.rejects(input(controller,requestId),/CORE_CONSOLE_MUTATION_STATE_UNKNOWN/);
      assert.equal(f.db.prepare('SELECT state FROM device_core_console_operations WHERE request_id=?').get(requestId)?.state,'unknown');
      assert.equal(f.effects(),0,switchPoint);
    }finally{f.db.close();}
  }
});

test('unavailable native provider cannot be overridden by a verified-looking fixture',async()=>{
  const f=fixture();try{
    const runtime=await enable(f);const base=runtime.provider;const binding=base.binding!;
    const controller=new CoreConsoleAdmission(binding,{
      binding,
      inspect:async signal=>({...await base.inspect(signal),nativeConsentProviderPresent:false,nativeAdmission:'verified' as const}),
      execute:(request,signal)=>base.execute(request,signal),revoke:()=>base.revoke(),
    });
    const status=await controller.status('full');
    assert.equal(status.localEnrolled,false);assert.equal(status.active,false);
    assert.equal(status.state,'LOCAL_ENROLLMENT_REQUIRED');
    await assert.rejects(input(controller),/LOCAL_ENROLLMENT_REQUIRED/);
    assert.equal(f.effects(),0);
  }finally{f.db.close();}
});

test('D1 consumes approval only when independent current owner-session readback still matches',async()=>{
  const f=fixture();try{
    f.before(body=>{if(body.action==='enroll')f.setAuthorityReadback(false);});
    const {controller}=await f.make();
    await assert.rejects(controller.enroll(new AbortController().signal),/CORE_AUTHORITY_DENIED_/);
    assert.equal(f.db.prepare('SELECT enrollment_id FROM device_core_console_authority').get()?.enrollment_id,null);
    assert.equal(f.db.prepare('SELECT native_consent_receipt_id FROM device_core_console_authority').get()?.native_consent_receipt_id,null);
    assert.equal(f.effects(),0);
  }finally{f.db.close();}
});

test('changed native Windows logon session or missing independent readback cannot reuse certificate',async()=>{
  const f=fixture();try{
    const {controller}=await enable(f);
    const proof=f.nativeReceipt()!;
    f.replaceNativeReceipt({...proof,windowsLogonLuid:'0000000000000002'});
    assert.equal((await controller.status('full')).active,false);
    assert.equal((await controller.status('full')).localEnrolled,false);
    await assert.rejects(input(controller));assert.equal(f.effects(),0);
    f.replaceNativeReceipt(proof);
    f.setNativeReadback(false);
    assert.equal((await controller.status('full')).active,false);
    assert.equal((await f.authority.deviceStatus(deviceId,owner)).localEnrolled,false,
      'D1 cannot treat a local DB certificate as native current readback');
    await assert.rejects(input(controller));assert.equal(f.effects(),0);
  }finally{f.db.close();}
});

test('forged owner/session native receipts and absent native readback never register enrollment',async()=>{
  for(const tamper of [
    (x:NativeCoreConsentProof)=>({...x,ownerEpoch:x.ownerEpoch+1}),
    (x:NativeCoreConsentProof)=>({...x,deviceId:'foreign-device-0001'}),
    (x:NativeCoreConsentProof)=>({...x,windowsLogonLuid:'nonsense'}),
    (x:NativeCoreConsentProof)=>({...x,windowsLogonLuid:'0000000000000000'}),
    (x:NativeCoreConsentProof)=>({...x,windowsSessionId:0}),
    (x:NativeCoreConsentProof)=>({...x,windowsLogonSessionEpoch:randomUUID()}),
    (x:NativeCoreConsentProof)=>({...x,windowsUserSid:'S-1-5-18'}),
  ]){
    const f=fixture();try{
      f.forgedNativeReceipt(tamper);
      const {controller}=await f.make();
      await assert.rejects(controller.enroll(new AbortController().signal));
      assert.equal((await f.authority.deviceStatus(deviceId,owner)).localEnrolled,false);
      assert.equal((await controller.status('full')).active,false);
    }finally{f.db.close();}
  }
  const f=fixture();try{
    f.setNativeReadback(false);
    const {controller}=await f.make();
    await assert.rejects(controller.enroll(new AbortController().signal),
      /CORE_NATIVE_CONSENT_READBACK_REQUIRED/);
    assert.equal((await f.authority.deviceStatus(deviceId,owner)).localEnrolled,false);
  }finally{f.db.close();}
});

test('default D1 authority denies self-signed enrollment, even with correct device credentials',async()=>{
  const f=fixture();try{
    await enable(f);
    const p=f.profile();
    const bare=new D1CoreConsoleAuthority(f.d1); // production: no trusted OS native verifier
    const readback=await bare.deviceStatus(deviceId,owner);
    assert.equal(readback.localEnrolled,false);
    assert.equal(readback.active,false);
    assert.equal(readback.deviceReady,false);
    await assert.rejects(bare.requestEnrollment(deviceId,owner),
      /CORE_NATIVE_CONSENT_PROVIDER_UNAVAILABLE/);
    const key=createPrivateKey({key:Buffer.from(p.privateKey!,'base64'),type:'pkcs8',format:'der'});
    const spki=createPublicKey(key).export({type:'spki',format:'der'}).toString('base64');
    const request={action:'enroll' as const,deviceId,installationId:p.installationId,
      nonce:randomUUID(),issuedAtMs:Date.now(),certificate:p.certificate,
      publicKeySpki:spki,nativeConsent:p.nativeConsent};
    const signature=sign(null,coreOperationBytes(request),key).toString('base64');
    await assert.rejects(bare.handle(credential,{...request,signature}),
      /CORE_NATIVE_CONSENT_PROVIDER_UNAVAILABLE/);
    assert.equal((await f.authority.deviceStatus(deviceId,owner)).localEnrolled,true,
      'the fixture authority was configured separately; production verifier still denied');
  }finally{f.db.close();}
});

test('non-enrollment signature v1 wire bytes remain backward compatible',()=>{
  const request={action:'read' as const,deviceId,installationId:randomUUID(),
    nonce:randomUUID(),issuedAtMs:Date.now()};
  const legacy=Buffer.from(JSON.stringify(['nexowire.core-console.operation.v1',
    request.action,request.deviceId,request.installationId,
    request.nonce,request.issuedAtMs,null,null,null,null]));
  assert.deepEqual(coreOperationBytes(request),legacy);
});

test('native readback completing after revoke, CORE OFF or re-pair never exposes stale enrollment',async()=>{
  const races=[
    "UPDATE device_maintenance_preferences SET enabled=0",
    "UPDATE devices SET owner_account_id='another-owner-0001'",
    "UPDATE device_core_console_authority SET enrollment_id=NULL,physical_active=0",
  ];
  for(const sql of races){
    const f=fixture();try{
      await enable(f);
      await f.client.call(f.profile(),'report',{active:true});
      const before=await f.authority.deviceStatus(deviceId,owner);
      assert.equal(before.active,true,'synthetic enrolled baseline');
      f.duringNativeReadback(()=>{f.db.exec(sql);});
      const after=await f.authority.deviceStatus(deviceId,owner);
      assert.equal(after.localEnrolled,false,sql);
      assert.equal(after.active,false,sql);
    }finally{f.db.close();}
  }
});
