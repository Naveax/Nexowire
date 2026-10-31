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

function fixture(){
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
  db.prepare('INSERT INTO device_maintenance_preferences VALUES(?,?,?,?)')
    .run(deviceId,ownerAccountId,1,'2026-10-31');
  db.prepare('INSERT INTO device_bridge_preferences VALUES(?,?,?,?)')
    .run(deviceId,ownerAccountId,'auto','2026-10-31');
  db.prepare(`UPDATE device_core_console_authority SET
    installation_id=?,enrollment_id=?,public_key_spki=?,native_consent_receipt_id=?,
    windows_user_sid=?,windows_session_id=?,windows_logon_luid=?,windows_logon_session_epoch=?
    WHERE device_id=?`).run(installationId,enrollmentId,publicKeySpki,receiptId,
      'S-1-5-21-101-202-303-1001',1,'0000000000000001',windowsLogonSessionEpoch,deviceId);
  const d1:D1DatabaseLike={prepare:sql=>new Statement(db.prepare(sql)),
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
  const call=async(action:'reserve'|'claim')=>{
    const request:CoreAuthorityRequest={
      action,deviceId,installationId,nonce:randomUUID(),issuedAtMs:Date.now(),
      requestId,fingerprint,
    };
    request.signature=sign(null,coreOperationBytes(request),signer.privateKey).toString('base64');
    return authority.handle(credential,request);
  };
  const state=()=>db.prepare('SELECT state FROM device_core_console_operations WHERE request_id=?')
    .get(requestId)?.state;
  return {db,call,state,pause:(work:()=>Promise<void>)=>{pause=work;},
    denyNativeReadback:()=>{nativeReadbackAllowed=false;}};
}

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
