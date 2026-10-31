import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync, type StatementSync} from 'node:sqlite';
import {createHash, generateKeyPairSync, randomUUID, sign} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {D1CoreConsoleAuthority} from '../src/product/d1-core-console-authority.js';
import type {D1DatabaseLike, D1PreparedStatementLike} from '../src/product/d1-control-plane-store.js';
import {coreOperationBytes, type CoreAuthorityRequest} from '../src/protocol/core-console-authority.js';

// AI-06: isolated in-memory D1 and synthetic verifier only.
// These tests DO NOT establish protected Win32 consent or physical OS readback.
class Statement implements D1PreparedStatementLike {
  constructor(private readonly stmt:StatementSync,private readonly values:unknown[]=[]){}
  bind(...values:unknown[]){return new Statement(this.stmt,values);}
  async first<T>(){return (this.stmt.get(...this.values as never[])??null) as T|null;}
  async all<T>(){return {success:true,results:this.stmt.all(...this.values as never[]) as T[]};}
  async run<T>(){const r=this.stmt.run(...this.values as never[]);
    return {success:true,meta:{changes:Number(r.changes)}};}
}

function deferred(){
  let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const proceed=new Promise<void>(resolve=>{release=resolve;});
  return {started,release,wait:async()=>{entered();await proceed;}};
}

function fixture(withClaimMarker=true){
  const db=new DatabaseSync(':memory:');
  const deviceId='ai06-device-0001',ownerAccountId='ai06-owner-0001';
  const credential='nwx_dev_ai06_isolated_fixture_0001';
  const installationId=randomUUID(),enrollmentId=randomUUID(),receiptId=randomUUID();
  const signer=generateKeyPairSync('ed25519');
  const publicKeySpki=signer.publicKey.export({format:'der',type:'spki'}).toString('base64');
  const windowsLogonSessionEpoch=randomUUID();
  db.exec('CREATE TABLE accounts(id TEXT PRIMARY KEY);'+
    'CREATE TABLE devices(id TEXT PRIMARY KEY,owner_account_id TEXT,credential_hash TEXT,'+
    'platform TEXT,access_mode TEXT,online INTEGER,privilege_mode TEXT,admin_bridge_ready INTEGER)');
  db.prepare('INSERT INTO accounts VALUES(?)').run(ownerAccountId);
  db.prepare('INSERT INTO devices VALUES(?,?,?,?,?,?,?,?)').run(deviceId,ownerAccountId,
    createHash('sha256').update(credential).digest('hex'),'win32','full',1,'broker',1);
  for(const name of ['0014_device_maintenance_preferences.sql','0015_device_bridge_preferences.sql',
    '0019_core_console_authority.sql','0020_core_console_native_logon_binding.sql'])
    db.exec(readFileSync(new URL('../cloudflare/migrations/'+name,import.meta.url),'utf8'));
  if(withClaimMarker){
  // Isolated test-local emulation of the coordinator #996 additive schema;
  // migration is separately owned and is NOT written to AI-06's branch.
  db.exec(`ALTER TABLE device_core_console_operations
    ADD COLUMN native_claim_verified INTEGER NOT NULL DEFAULT 0
    CHECK(native_claim_verified IN (0,1));
    CREATE TRIGGER ai06_completion_requires_native_claim BEFORE UPDATE OF state
    ON device_core_console_operations
    WHEN NEW.state IN ('succeeded','denied') AND
      (OLD.state <> 'dispatched' OR OLD.native_claim_verified <> 1)
    BEGIN SELECT RAISE(ABORT,'CORE_NATIVE_CLAIM_NOT_VERIFIED'); END;`);
  }
  db.prepare('INSERT INTO device_maintenance_preferences VALUES(?,?,?,?)')
    .run(deviceId,ownerAccountId,1,'2026-10-31');
  db.prepare('INSERT INTO device_bridge_preferences VALUES(?,?,?,?)')
    .run(deviceId,ownerAccountId,'auto','2026-10-31');
  db.prepare(`UPDATE device_core_console_authority SET
    installation_id=?,enrollment_id=?,public_key_spki=?,native_consent_receipt_id=?,
    windows_user_sid=?,windows_session_id=?,windows_logon_luid=?,windows_logon_session_epoch=?
    WHERE device_id=?`).run(installationId,enrollmentId,publicKeySpki,receiptId,
      'S-1-5-21-101-202-303-1001',1,'0000000000000001',windowsLogonSessionEpoch,deviceId);
  // Deterministic point between latest D1 readback and the second claim CAS.
  // Source-level race only; not a real Windows event or a D1 production hook.
  let beforeMarkerCas:(()=>void)|undefined;
  const d1:D1DatabaseLike={prepare:sql=>{
    if(sql.includes('SET native_claim_verified=1')){
      const cb=beforeMarkerCas;beforeMarkerCas=undefined;cb?.();
    }
    return new Statement(db.prepare(sql));
  },
    batch:async statements=>{
      db.exec('BEGIN');
      try{const result=await Promise.all(statements.map(s=>s.run()));db.exec('COMMIT');return result;}
      catch(error){db.exec('ROLLBACK');throw error;}
    }};
  let pause:(()=>Promise<void>)|undefined;
  let nativeReadbackAllowed=true;
  const authority=new D1CoreConsoleAuthority(d1,{
    verifyAndConsume:async()=>false,
    currentReadback:async()=>{if(pause)await pause();return nativeReadbackAllowed;},
  });
  const requestId=randomUUID(),fingerprint='a'.repeat(64);
  const call=async(action:'reserve'|'claim'|'complete')=>{
    const request:CoreAuthorityRequest={
      action,deviceId,installationId,nonce:randomUUID(),issuedAtMs:Date.now(),
      requestId,fingerprint,
    };
    if(action==='complete')request.outcome='succeeded';
    request.signature=sign(null,coreOperationBytes(request),signer.privateKey).toString('base64');
    return authority.handle(credential,request);
  };
  const state=()=>db.prepare('SELECT state FROM device_core_console_operations WHERE request_id=?')
    .get(requestId)?.state;
  const marker=()=>withClaimMarker
    ?db.prepare('SELECT native_claim_verified FROM device_core_console_operations WHERE request_id=?')
      .get(requestId)?.native_claim_verified:null;
  return {db,call,state,marker,
    beforeMark:(cb:()=>void)=>{beforeMarkerCas=cb;},
    deviceStatus:()=>authority.deviceStatus(deviceId,ownerAccountId),
    pause:(work:()=>Promise<void>)=>{pause=work;},
    denyNativeReadback:()=>{nativeReadbackAllowed=false;}};
}

const rotatedPublicKeySpki=generateKeyPairSync('ed25519').publicKey
  .export({format:'der',type:'spki'}).toString('base64');
const races=[
  {name:'offline',sql:'UPDATE devices SET online=0',
    restore:'UPDATE devices SET online=1'},
  {name:'platform changed to Linux',sql:"UPDATE devices SET platform='linux'",
    restore:"UPDATE devices SET platform='win32'"},
  {name:'Broker privilege mode dropped',sql:"UPDATE devices SET privilege_mode='direct'",
    restore:"UPDATE devices SET privilege_mode='broker'"},
  {name:'Broker readiness lost',sql:'UPDATE devices SET admin_bridge_ready=0',
    restore:'UPDATE devices SET admin_bridge_ready=1'},
  {name:'SAFE access mode',sql:"UPDATE devices SET access_mode='safe'",
    restore:"UPDATE devices SET access_mode='full'"},
  {name:'CORE preference revoked',sql:'UPDATE device_maintenance_preferences SET enabled=0',
    restore:'UPDATE device_maintenance_preferences SET enabled=1'},
  {name:'bridge disabled',sql:"UPDATE device_bridge_preferences SET desired_mode='off'",
    restore:"UPDATE device_bridge_preferences SET desired_mode='auto'"},
  {name:'owner account re-paired',sql:"UPDATE devices SET owner_account_id='ai06-owner-replaced'",
    restore:null},
  {name:'paired device credential rotated',sql:"UPDATE devices SET credential_hash='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'",
    restore:null},
  {name:'signing key rotated under the same enrollment',
    sql:`UPDATE device_core_console_authority SET public_key_spki='${rotatedPublicKeySpki}'`,
    restore:null},
  {name:'owner session epoch rotated',
    sql:"UPDATE device_core_console_authority SET windows_logon_session_epoch='replaced-ai06-epoch'",
    restore:null},
  {name:'owner authorization epoch rotated',
    sql:'UPDATE device_core_console_authority SET owner_epoch=owner_epoch+1',
    restore:null},
  {name:'durable revoke epoch advanced',
    sql:'UPDATE device_core_console_authority SET revoke_epoch=revoke_epoch+1',
    restore:null},
] as const;

for(const scenario of races)test('AI-06: claim is terminal when '+scenario.name+
  ' changes during async native readback',async()=>{
  const f=fixture(),g=deferred();
  try{
    await f.call('reserve');
    f.pause(g.wait);
    const claim=f.call('claim');
    await g.started;
    f.db.exec(scenario.sql);
    g.release();
    await assert.rejects(claim);
    assert.equal(f.state(),'unknown','consumed/uncertain request must have a durable tombstone');
    if(scenario.restore)f.db.exec(scenario.restore);
    await assert.rejects(f.call('claim'),'same request ID must never be claimed again');
    assert.equal(f.state(),'unknown');
  }finally{g.release();f.db.close();}
});

test('AI-06: synthetic locked/logged-out desktop readback denies and tombstones claim',async()=>{
  const f=fixture(),g=deferred();
  try{
    await f.call('reserve');
    f.pause(g.wait);
    const claim=f.call('claim');
    await g.started;
    // Independent verifier is responsible for mapping locked/logged-out Win32
    // context to false. This fixture exercises only D1 fail-closed semantics.
    f.denyNativeReadback();
    g.release();
    await assert.rejects(claim,/CORE_NATIVE_CONSENT_SESSION_STALE/);
    assert.equal(f.state(),'unknown');
    await assert.rejects(f.call('claim'));
  }finally{g.release();f.db.close();}
});

test('AI-06: duplicate claimant cannot overwrite the winning dispatched claim',async()=>{
  const f=fixture(),g=deferred();
  try{
    await f.call('reserve');
    f.pause(g.wait);
    const winner=f.call('claim');
    await g.started;
    await assert.rejects(f.call('claim'));
    assert.equal(f.state(),'dispatched','loser may not tombstone winner');
    g.release();
    const response=await winner;
    assert.equal(response.state.devicePlatform,'win32');
    assert.equal(response.state.deviceReady,true);
    assert.equal(f.state(),'dispatched');
    await assert.rejects(f.call('claim'));
  }finally{g.release();f.db.close();}
});

test('AI-06: positive synthetic single claim succeeds but cannot replay',async()=>{
  const f=fixture();
  try{
    await f.call('reserve');
    const result=await f.call('claim');
    assert.equal(result.state.devicePlatform,'win32');
    assert.equal(result.state.deviceReady,true);
    assert.equal(f.state(),'dispatched');
    await assert.rejects(f.call('claim'));
    assert.equal(f.state(),'dispatched');
  }finally{f.db.close();}
});

test('AI-06: owner enrollment status denies a signing-key rotation during native readback',async()=>{
  const f=fixture(),g=deferred();
  try{
    f.pause(g.wait);
    const pending=f.deviceStatus();
    await g.started;
    f.db.prepare('UPDATE device_core_console_authority SET public_key_spki=?')
      .run(rotatedPublicKeySpki);
    g.release();
    const status=await pending;
    assert.equal(status.localEnrolled,false,'stale native identity must not publish local enrollment');
    assert.equal(status.active,false);
  }finally{g.release();f.db.close();}
});

test('AI-06: missing local signing key cannot be classified as enrolled',async()=>{
  const f=fixture();
  try{
    f.db.exec('UPDATE device_core_console_authority SET public_key_spki=NULL');
    const status=await f.deviceStatus();
    assert.equal(status.localEnrolled,false);
    assert.equal(status.active,false);
  }finally{f.db.close();}
});

const statusRaces=[
  {name:'device offline',sql:'UPDATE devices SET online=0'},
  {name:'platform no longer Windows',sql:"UPDATE devices SET platform='linux'"},
  {name:'Broker privilege lost',sql:"UPDATE devices SET privilege_mode='direct'"},
  {name:'Broker readiness lost',sql:'UPDATE devices SET admin_bridge_ready=0'},
  {name:'CORE preference off',sql:'UPDATE device_maintenance_preferences SET enabled=0'},
  {name:'owner logon epoch rotated',sql:"UPDATE device_core_console_authority SET windows_logon_session_epoch='rotated-during-readback'"},
  {name:'revoke epoch changed',sql:'UPDATE device_core_console_authority SET revoke_epoch=revoke_epoch+1'},
] as const;

for(const scenario of statusRaces)test('AI-06: deviceStatus cannot publish stale enrollment after '+scenario.name,async()=>{
  const f=fixture(),g=deferred();
  try{
    const before=await f.deviceStatus();
    assert.equal(before.localEnrolled,true,'test precondition: synthetic enrollment current');
    f.pause(g.wait);
    const pending=f.deviceStatus();
    await g.started;
    f.db.exec(scenario.sql);
    g.release();
    const after=await pending;
    assert.equal(after.localEnrolled,false,'post-await owner/readiness change must deny enrollment');
    assert.equal(after.active,false,'stale native session cannot report active CORE');
  }finally{g.release();f.db.close();}
});

test('AI-06: denied claim tombstones a concurrent premature completion as UNKNOWN',async()=>{
  const f=fixture(),g=deferred();
  try{
    await f.call('reserve');
    f.pause(g.wait);
    const claim=f.call('claim');
    await g.started;
    // A second properly signed caller may attempt a premature complete.
    // Existing D1 schema cannot reject it reliably until coordinator adds
    // a native-verified claim state/marker. Test the post-denial audit fence
    // without locking in the vulnerable early-acceptance behaviour.
    await f.call('complete').catch(()=>{});
    f.denyNativeReadback();
    g.release();
    await assert.rejects(claim,/CORE_NATIVE_CONSENT_SESSION_STALE/);
    assert.equal(f.state(),'unknown',
      'a denied, never-ACKed claim cannot retain synthetic succeeded/denied');
    await assert.rejects(f.call('claim'),'same request ID remains terminal');
    await assert.rejects(f.call('complete'),'premature completion cannot replay');
    assert.equal(f.state(),'unknown');
  }finally{g.release();f.db.close();}
});

test('AI-06: signed early completion is rejected until native-verified claim CAS',async()=>{
  const f=fixture(),g=deferred();
  try{
    await f.call('reserve');assert.equal(f.marker(),0);
    f.pause(g.wait);const pending=f.call('claim');await g.started;
    assert.equal(f.state(),'dispatched');assert.equal(f.marker(),0);
    await assert.rejects(f.call('complete'),
      /CORE_REVOKED_REPLAY_OR_CONFLICT|CORE_NATIVE_CLAIM_NOT_VERIFIED/);
    assert.equal(f.state(),'dispatched');assert.equal(f.marker(),0);
    g.release();await pending;
    assert.equal(f.marker(),1,'native verifier winner records the second CAS');
    await f.call('complete');assert.equal(f.state(),'succeeded');
    await assert.rejects(f.call('complete'),'terminal completion must not replay');
  }finally{g.release();f.db.close();}
});

test('AI-06: native readback denial leaves unverified UNKNOWN tombstone',async()=>{
  const f=fixture(),g=deferred();
  try{
    await f.call('reserve');f.pause(g.wait);
    const claim=f.call('claim');await g.started;
    f.denyNativeReadback();g.release();
    await assert.rejects(claim,/CORE_NATIVE_CONSENT_SESSION_STALE/);
    assert.equal(f.state(),'unknown');assert.equal(f.marker(),0);
    await assert.rejects(f.call('complete'));
  }finally{g.release();f.db.close();}
});

test('AI-06: missing coordinator claim-marker migration fails closed',async()=>{
  const f=fixture(false);
  try{
    await f.call('reserve');
    await assert.rejects(f.call('claim'),/native_claim_verified|no such column/i);
    assert.equal(f.state(),'unknown','no unsigned legacy fallback');
    await assert.rejects(f.call('complete'),/native_claim_verified|no such column/i);
  }finally{f.db.close();}
});

for(const change of [
  {name:'owner re-pair with new CORE preference enabled',apply:(f:ReturnType<typeof fixture>)=>{
    const owner='ai06-owner-repaired-after-readback';
    f.db.prepare('INSERT INTO accounts VALUES(?)').run(owner);
    f.db.prepare('UPDATE devices SET owner_account_id=?').run(owner);
    // Both tables have device_id PRIMARY KEY. Re-pair the *existing*
    // preference rows so the new owner remains READY at the second CAS.
    f.db.prepare('UPDATE device_maintenance_preferences SET owner_account_id=?,enabled=1 WHERE device_id=?')
      .run(owner,'ai06-device-0001');
    f.db.prepare("UPDATE device_bridge_preferences SET owner_account_id=?,desired_mode='auto' WHERE device_id=?")
      .run(owner,'ai06-device-0001');
  }},
  {name:'Windows logon epoch rotated',apply:(f:ReturnType<typeof fixture>)=>{
    f.db.exec("UPDATE device_core_console_authority SET windows_logon_session_epoch='ai06-new-logon-after-readback'");
  }},
  {name:'Broker privilege lost',apply:(f:ReturnType<typeof fixture>)=>{
    f.db.exec("UPDATE devices SET privilege_mode='direct'");
  }},
])test('AI-06: post-readback native marker CAS denies '+change.name,async()=>{
  const f=fixture();
  try{
    await f.call('reserve');
    f.beforeMark(()=>change.apply(f));
    await assert.rejects(f.call('claim'),/CORE_REVOKED_REPLAY_OR_CONFLICT/,
      'second CAS must fail on changed current owner/session/READY scope');
    assert.equal(f.state(),'unknown','winning claim can only quarantine');
    assert.equal(f.marker(),0,'denied stale claim cannot mark verified');
    await assert.rejects(f.call('claim'),'same UUID must remain non-replayable');
  }finally{f.db.close();}
});
