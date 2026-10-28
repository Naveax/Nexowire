import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync, type StatementSync} from 'node:sqlite';
import {createHash, generateKeyPairSync, randomUUID, sign} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {D1CoreConsoleAuthority} from '../src/product/d1-core-console-authority.js';
import type {D1DatabaseLike, D1PreparedStatementLike} from '../src/product/d1-control-plane-store.js';
import {coreOperationBytes, type CoreAuthorityRequest} from '../src/protocol/core-console-authority.js';
import {canonicalCoreConsoleEnrollment} from '../src/agent/core-console-enrollment-policy.js';
import {CoreConsoleAdmission} from '../src/agent/core-console-admission.js';
import {CoreConsoleAuthorityClient, WindowsCoreConsoleProvider, type CoreProfileStore,
  type NativeCoreConsentProof} from '../src/agent/windows-core-console-provider.js';
import {createControlPlaneHttpHandler} from '../src/product/control-plane-http.js';
import {NEXOWIRE_VERSION} from '../src/version.js';

// This in-memory fixture supplies no protected native approval or real OS
// readback. It tests only the source-level D1 claim/readiness contract.
class Statement implements D1PreparedStatementLike {
  constructor(private readonly stmt:StatementSync, private readonly values:unknown[] = []) {}
  bind(...values:unknown[]) { return new Statement(this.stmt, values); }
  async first<T>() { return (this.stmt.get(...this.values as never[]) ?? null) as T | null; }
  async all<T>() { return {success:true, results:this.stmt.all(...this.values as never[]) as T[]}; }
  async run<T>() { const result=this.stmt.run(...this.values as never[]);
    return {success:true, meta:{changes:Number(result.changes)}}; }
}

function gate() {
  let enter!:()=>void, release!:()=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;});
  const resumed=new Promise<void>(resolve=>{release=resolve;});
  return {entered, release, wait:async()=>{enter();await resumed;}};
}

function fixture() {
  const db=new DatabaseSync(':memory:');
  const owner='qa-owner-0001', device='qa-device-0001';
  const credential='nwx_dev_synthetic_fixture_0001';
  const installationId=randomUUID(), enrollmentId=randomUUID(), receiptId=randomUUID();
  const windowsLogonSessionEpoch=randomUUID(), approvedAtMs=Date.now()-1000;
  const signer=generateKeyPairSync('ed25519');
  const publicDer=signer.publicKey.export({format:'der',type:'spki'});
  const spki=publicDer.toString('base64');
  db.exec('CREATE TABLE accounts(id TEXT PRIMARY KEY);'+
    'CREATE TABLE devices(id TEXT PRIMARY KEY,owner_account_id TEXT,credential_hash TEXT,'+
    'platform TEXT,access_mode TEXT,online INTEGER,privilege_mode TEXT,admin_bridge_ready INTEGER)');
  db.prepare('INSERT INTO accounts VALUES(?)').run(owner);
  db.prepare('INSERT INTO devices VALUES(?,?,?,?,?,?,?,?)').run(device,owner,
    createHash('sha256').update(credential).digest('hex'),'win32','full',1,'broker',1);
  for (const file of ['0014_device_maintenance_preferences.sql','0015_device_bridge_preferences.sql',
    '0019_core_console_authority.sql','0020_core_console_native_logon_binding.sql'])
    db.exec(readFileSync(new URL('../cloudflare/migrations/'+file,import.meta.url),'utf8'));
  db.prepare('INSERT INTO device_maintenance_preferences VALUES(?,?,?,?)').run(device,owner,1,'2026-10-28');
  db.prepare('INSERT INTO device_bridge_preferences VALUES(?,?,?,?)').run(device,owner,'auto','2026-10-28');
  db.prepare(`UPDATE device_core_console_authority SET installation_id=?,enrollment_id=?,public_key_spki=?,
    native_consent_receipt_id=?,windows_user_sid=?,windows_session_id=?,windows_logon_luid=?,
    windows_logon_session_epoch=? WHERE device_id=?`).run(installationId,enrollmentId,spki,
    receiptId,'S-1-5-21-101-202-303-1001',1,'0000000000000001',windowsLogonSessionEpoch,device);
  const d1:D1DatabaseLike={prepare:sql=>new Statement(db.prepare(sql)),
    batch:async statements=>{db.exec('BEGIN');try{const result=await Promise.all(statements.map(s=>s.run()));
      db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}};
  let hold:(()=>Promise<void>) | undefined;
  const authority=new D1CoreConsoleAuthority(d1,{
    verifyAndConsume:async()=>false,
    currentReadback:async()=>{if(hold)await hold();return true;},
  });
  const requestId=randomUUID(), fingerprint='a'.repeat(64);
  const call=async(action:'reserve'|'claim')=>{
    const request:CoreAuthorityRequest={action,deviceId:device,installationId,nonce:randomUUID(),
      issuedAtMs:Date.now(),requestId,fingerprint};
    request.signature=sign(null,coreOperationBytes(request),signer.privateKey).toString('base64');
    return authority.handle(credential,request);
  };
  const enrollment={version:1 as const,scope:'physical-console' as const,ownerAccountId:owner,
    deviceId:device,installationId,enrollmentId,ownerEpoch:1,grantGeneration:1,revokeEpoch:0,
    approvedLocallyAtMs:approvedAtMs,issuerSpkiSha256:createHash('sha256').update(publicDer).digest('hex')};
  const nativeProof:NativeCoreConsentProof={version:1,challengeId:randomUUID(),receiptId,
    ownerAccountId:owner,deviceId:device,installationId,enrollmentId,ownerEpoch:1,grantGeneration:1,
    revokeEpoch:0,windowsUserSid:'S-1-5-21-101-202-303-1001',windowsSessionId:1,
    windowsLogonLuid:'0000000000000001',windowsLogonSessionEpoch,approvedAtMs,consumed:true};
  const handler=createControlPlaneHttpHandler({} as never,{authenticate:async()=>null,coreConsoleAuthority:authority});
  let claimStarted=false,afterClaimReadback:(()=>void)|undefined;
  let completionFault:'none'|'before'|'after'='none',nativeAckLost=false;
  const fetcher=(async(input,init)=>{
    const body=JSON.parse(String(init?.body)) as {action?:string};
    if(body.action==='claim')claimStarted=true;
    if(body.action==='complete'&&completionFault==='before'){
      completionFault='none';
      throw new Error('synthetic completion request unavailable before D1 transition');
    }
    const response=await handler(new Request(String(input),init));
    if(body.action==='complete'&&completionFault==='after'){
      completionFault='none';
      throw new Error('synthetic completion ACK lost after D1 transition');
    }
    return response;
  }) as typeof fetch;
  const client=new CoreConsoleAuthorityClient('https://qa-fixture.example',credential,fetcher);
  type Profile=NonNullable<Awaited<ReturnType<CoreProfileStore['load']>>>;
  let record:Profile={version:1,deviceId:device,installationId,authorityUrl:client.url,
    privateKey:signer.privateKey.export({format:'der',type:'pkcs8'}).toString('base64'),
    pendingRevoke:false,nativeConsent:nativeProof,certificate:{enrollment,
      signatureBase64:sign(null,canonicalCoreConsoleEnrollment(enrollment),signer.privateKey).toString('base64')}};
  let stopped=false,effects=0;
  const store:CoreProfileStore={stopFile:'qa-fixture-only',load:async()=>structuredClone(record),
    save:async p=>{record=structuredClone(p);},stop:async()=>{stopped=true;},
    clearStop:async()=>{stopped=false;},stopped:async()=>stopped};
  const createProvider=()=>new WindowsCoreConsoleProvider({deviceId:device,authority:client,store,
    broker:{probe:async()=>({reachable:true,elevated:true,version:NEXOWIRE_VERSION})},
    nativeConsent:{approveAndConsume:async()=>null,currentReadback:async()=>{
      if(claimStarted&&afterClaimReadback){const hook=afterClaimReadback;afterClaimReadback=undefined;hook();}
      return structuredClone(nativeProof);
    }},
    native:async()=>{
      effects++;
      if(nativeAckLost){nativeAckLost=false;throw new Error('synthetic native ACK lost after possible input');}
      return {synthetic:true};
    },monitor:{desktopAllowed:()=>true,close:()=>{}}});
  let provider=createProvider();
  let controller=new CoreConsoleAdmission(undefined,provider);
  const execute=(id:string)=>controller.execute('windows.pointer.move',{hwnd:'0x123',x:0,y:0},id,'full');
  return {db,call,execute,effects:()=>effects,hold:(fn:()=>Promise<void>)=>{hold=fn;},
    status:()=>controller.status('full'),stopped:()=>stopped,
    restart:()=>{provider.close();provider=createProvider();controller=new CoreConsoleAdmission(undefined,provider);},
    loseNativeAck:()=>{nativeAckLost=true;},
    loseCompletion:(phase:'before'|'after')=>{completionFault=phase;},
    afterClaimReadback:(fn:()=>void)=>{afterClaimReadback=fn;},state:()=>
    db.prepare('SELECT state FROM device_core_console_operations WHERE request_id=?').get(requestId)?.state};
}

test('synthetic D1 claim succeeds once while native readback and readiness remain current',async()=>{
  const f=fixture();try{
    await f.call('reserve');
    const result=await f.call('claim');
    assert.equal(result.state.deviceOnline,true);
    assert.equal(result.state.bridgeVerified,true);
    assert.equal(f.state(),'dispatched');
    await assert.rejects(f.call('claim'));
    assert.equal(f.state(),'dispatched');
  }finally{f.db.close();}
});

test('synthetic native UNKNOWN latches STOP when completion reporting succeeds',async()=>{
  const f=fixture(),id=randomUUID();try{
    f.loseNativeAck();
    await assert.rejects(f.execute(id));
    assert.equal(f.effects(),1);
    assert.equal(f.stopped(),true);
    assert.equal((await f.status()).active,false);
    await assert.rejects(f.execute(id));
    await assert.rejects(f.execute(randomUUID()));
    assert.equal(f.effects(),1);
  }finally{f.db.close();}
});

for(const phase of ['before','after'] as const)
test('synthetic native UNKNOWN must latch locally if completion fails '+phase+' D1 transition',async()=>{
  const f=fixture(),id=randomUUID();try{
    f.loseNativeAck();f.loseCompletion(phase);
    await assert.rejects(f.execute(id));
    const stoppedAfterUnknown=f.stopped();
    const activeAfterUnknown=(await f.status()).active;
    await assert.rejects(f.execute(id),'the same ID is still rejected by the local replay cache');
    // Explicitly issued by this test: the product did not automatically retry.
    // A fresh UUID is a separate operation and cannot bypass a required local
    // UNKNOWN/STOP latch without recovery or a new valid local enrollment.
    const nextAccepted=await f.execute(randomUUID()).then(()=>true,()=>false);
    assert.deepEqual({stoppedAfterUnknown,activeAfterUnknown,nextAccepted,effects:f.effects()},
      {stoppedAfterUnknown:true,activeAfterUnknown:false,nextAccepted:false,effects:1},
      'local UNKNOWN/STOP must survive an unavailable completion report and deny further synthetic effects');
  }finally{f.db.close();}
});

test('revoke during synthetic native readback denies claim and tombstones the request',async()=>{
  const f=fixture(), g=gate();try{
    await f.call('reserve');f.hold(g.wait);
    const claim=f.call('claim');await g.entered;
    f.db.exec('UPDATE device_maintenance_preferences SET enabled=0');g.release();
    await assert.rejects(claim,/CORE_NATIVE_CONSENT_SESSION_CHANGED/);
    assert.equal(f.state(),'unknown');
    await assert.rejects(f.call('claim'));
  }finally{g.release();f.db.close();}
});

test('synthetic final provider admits one current request and denies replay',async()=>{
  const f=fixture(), id=randomUUID();try{
    await f.execute(id);assert.equal(f.effects(),1);
    await assert.rejects(f.execute(id));assert.equal(f.effects(),1);
  }finally{f.db.close();}
});

for (const scenario of [
  {name:'device goes offline',sql:'UPDATE devices SET online=0'},
  {name:'Broker readiness is lost',sql:'UPDATE devices SET admin_bridge_ready=0'},
  {name:'device platform changes',sql:"UPDATE devices SET platform='linux'"},
]) test('final synthetic effect is denied after readiness loss: '+scenario.name,async()=>{
  const f=fixture(),g=gate(),id=randomUUID();try{
    f.hold(g.wait);const pending=f.execute(id);await g.entered;
    f.db.exec(scenario.sql);g.release();
    await assert.rejects(pending);
    await assert.rejects(f.execute(id));
    assert.equal(f.effects(),0,'no synthetic effect callback may run, including before a failed ACK');
  }finally{g.release();f.db.close();}
});

for (const scenario of [
  {name:'device goes offline',sql:'UPDATE devices SET online=0'},
  {name:'Broker readiness is lost',sql:'UPDATE devices SET admin_bridge_ready=0'},
  {name:'device platform changes',sql:"UPDATE devices SET platform='linux'"},
]) test('final synthetic readback catches readiness loss after claim: '+scenario.name,async()=>{
  const f=fixture(),id=randomUUID();try{
    f.afterClaimReadback(()=>f.db.exec(scenario.sql));
    await assert.rejects(f.execute(id));
    await assert.rejects(f.execute(id));
    assert.equal(f.effects(),0,'no synthetic effect callback may run after readiness changes');
  }finally{f.db.close();}
});

for (const scenario of [
  {name:'device goes offline',sql:'UPDATE devices SET online=0'},
  {name:'Broker readiness is lost',sql:'UPDATE devices SET admin_bridge_ready=0'},
  {name:'Broker privilege mode is lost',sql:"UPDATE devices SET privilege_mode='direct'"},
  {name:'device platform changes',sql:"UPDATE devices SET platform='linux'"},
]) test('readiness loss during synthetic native readback denies claim: '+scenario.name,async()=>{
  const f=fixture(), g=gate();try{
    await f.call('reserve');f.hold(g.wait);
    const claim=f.call('claim');await g.entered;
    f.db.exec(scenario.sql);g.release();
    const outcome=await claim.then(value=>({accepted:true,state:value.state}),
      ()=>({accepted:false,state:null}));
    assert.equal(outcome.accepted,false,'D1 must reject a claim if required readiness changed while readback waited');
    assert.equal(f.state(),'unknown','an uncertain, already consumed claim must be tombstoned');
    await assert.rejects(f.call('claim'));
  }finally{g.release();f.db.close();}
});


for(const phase of ['before','after'] as const)
test('synthetic native UNKNOWN must stay fenced after provider restart when completion fails '+phase+' D1 transition',async()=>{
  const f=fixture(),id=randomUUID();try{
    f.loseNativeAck();f.loseCompletion(phase);
    await assert.rejects(f.execute(id));
    assert.equal(f.effects(),1);
    // Reconstruct only the JS provider; the fixture store/D1 survive.
    // This is not a physical Agent, Windows session or service restart.
    f.restart();
    const stoppedAfterRestart=f.stopped();
    const activeAfterRestart=(await f.status()).active;
    const nextAccepted=await f.execute(randomUUID()).then(()=>true,()=>false);
    assert.deepEqual({stoppedAfterRestart,activeAfterRestart,nextAccepted,effects:f.effects()},
      {stoppedAfterRestart:true,activeAfterRestart:false,nextAccepted:false,effects:1},
      'remote completion failure must not allow a persisted enrollment to resume after provider reconstruction');
  }finally{f.db.close();}
});
