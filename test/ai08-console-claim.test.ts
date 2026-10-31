/** AI-08 independent D1 claim/readiness TOCTOU negative tests.
 * Disposable in-memory SQLite, synthetic signatures and verifier readbacks ONLY.
 * Not native UAC, desktop, owner or physical Windows evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync,type StatementSync} from 'node:sqlite';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {D1CoreConsoleAuthority} from '../src/product/d1-core-console-authority.js';
import type {D1DatabaseLike,D1PreparedStatementLike} from '../src/product/d1-control-plane-store.js';
import {coreOperationBytes,type CoreAuthorityRequest} from '../src/protocol/core-console-authority.js';

class Statement implements D1PreparedStatementLike {
  constructor(private readonly statement:StatementSync,private readonly values:unknown[]=[]){}
  bind(...values:unknown[]){return new Statement(this.statement,values)}
  async first<T>(){return (this.statement.get(...this.values as never[])??null) as T|null}
  async all<T>(){return {success:true,results:this.statement.all(...this.values as never[]) as T[]}}
  async run<T>(){
    const r=this.statement.run(...this.values as never[]);
    return {success:true,meta:{changes:Number(r.changes)}};
  }
}
function latch(){
  let enter!:()=>void,release!:()=>void;
  const entered=new Promise<void>(r=>{enter=r});
  const held=new Promise<void>(r=>{release=r});
  return {entered,release,wait:async()=>{enter();await held}};
}
function fixture(){
  const db=new DatabaseSync(':memory:');
  const credential='nwx_dev_ai08_only_00123456';
  const owner='ai08-owner',device='ai08-device';
  const installationId=randomUUID(),enrollmentId=randomUUID(),receiptId=randomUUID();
  const epoch=randomUUID(),requestId=randomUUID(),fingerprint='d'.repeat(64);
  const signer=generateKeyPairSync('ed25519');
  const spki=signer.publicKey.export({format:'der',type:'spki'}).toString('base64');
  db.exec('CREATE TABLE accounts(id TEXT PRIMARY KEY);'+
    'CREATE TABLE devices(id TEXT PRIMARY KEY,owner_account_id TEXT,credential_hash TEXT,'+
    'platform TEXT,access_mode TEXT,online INTEGER,privilege_mode TEXT,admin_bridge_ready INTEGER)');
  db.prepare('INSERT INTO accounts VALUES(?)').run(owner);
  db.prepare('INSERT INTO devices VALUES(?,?,?,?,?,?,?,?)').run(device,owner,
    createHash('sha256').update(credential).digest('hex'),'win32','full',1,'broker',1);
  for(const name of ['0014_device_maintenance_preferences.sql',
    '0015_device_bridge_preferences.sql','0019_core_console_authority.sql',
    '0020_core_console_native_logon_binding.sql']){
    db.exec(readFileSync(new URL('../cloudflare/migrations/'+name,import.meta.url),'utf8'));
  }
  db.prepare('INSERT INTO device_maintenance_preferences VALUES(?,?,?,?)')
    .run(device,owner,1,'2026-10-31');
  db.prepare('INSERT INTO device_bridge_preferences VALUES(?,?,?,?)')
    .run(device,owner,'auto','2026-10-31');
  db.prepare(`UPDATE device_core_console_authority SET installation_id=?,enrollment_id=?,
    public_key_spki=?,native_consent_receipt_id=?,windows_user_sid=?,
    windows_session_id=?,windows_logon_luid=?,windows_logon_session_epoch=?
    WHERE device_id=?`).run(installationId,enrollmentId,spki,receiptId,
    'S-1-5-21-100-200-300-1001',1,'0000000000000001',epoch,device);
  const dbLike:D1DatabaseLike={prepare:sql=>new Statement(db.prepare(sql)),
    batch:async statements=>{
      db.exec('BEGIN');try{
        const result=await Promise.all(statements.map(s=>s.run()));
        db.exec('COMMIT');return result;
      }catch(error){db.exec('ROLLBACK');throw error;}
    }};
  const gate=latch();
  let nativeReads=0;
  const auth=new D1CoreConsoleAuthority(dbLike,{
    verifyAndConsume:async()=>false,
    currentReadback:async()=>{nativeReads++;await gate.wait();return true;},
  });
  const call=async(action:'reserve'|'claim')=>{
    const request:CoreAuthorityRequest={action,deviceId:device,installationId,
      nonce:randomUUID(),issuedAtMs:Date.now(),requestId,fingerprint};
    request.signature=sign(null,coreOperationBytes(request),signer.privateKey).toString('base64');
    return auth.handle(credential,request);
  };
  return {db,call,gate,device,owner,reads:()=>nativeReads,
    state:()=>db.prepare('SELECT state FROM device_core_console_operations WHERE request_id=?')
      .get(requestId)?.state};
}

for(const scenario of [
  {name:'offline',sql:'UPDATE devices SET online=0'},
  {name:'Broker not ready',sql:'UPDATE devices SET admin_bridge_ready=0'},
  {name:'privilege downgrade',sql:"UPDATE devices SET privilege_mode='direct'"},
  {name:'platform substitution',sql:"UPDATE devices SET platform='linux'"},
  {name:'CORE disabled',sql:'UPDATE device_maintenance_preferences SET enabled=0'},
  // The outer claim has already consumed its request ID when native readback
  // waits. Any changed authoritative scope must tombstone, never replay.
  {name:'owner epoch rotated',sql:'UPDATE device_core_console_authority SET owner_epoch=owner_epoch+1'},
  {name:'grant generation rotated',sql:'UPDATE device_core_console_authority SET grant_generation=grant_generation+1'},
  {name:'revoke epoch advanced',sql:'UPDATE device_core_console_authority SET revoke_epoch=revoke_epoch+1'},
  {name:'enrollment replaced',sql:"UPDATE device_core_console_authority SET enrollment_id='00000000-0000-4000-8000-000000000801'"},
  {name:'native receipt replaced',sql:"UPDATE device_core_console_authority SET native_consent_receipt_id='00000000-0000-4000-8000-000000000802'"},
  {name:'Windows user SID rotated',sql:"UPDATE device_core_console_authority SET windows_user_sid='S-1-5-21-100-200-300-2002'"},
  {name:'Windows session changed',sql:'UPDATE device_core_console_authority SET windows_session_id=windows_session_id+1'},
  {name:'Windows logon LUID changed',sql:"UPDATE device_core_console_authority SET windows_logon_luid='0000000000000002'"},
  {name:'Windows session epoch changed',sql:"UPDATE device_core_console_authority SET windows_logon_session_epoch='00000000-0000-4000-8000-000000000803'"},
  {name:'SAFE access mode',sql:"UPDATE devices SET access_mode='safe'"},
]){
  test('AI-08: D1 claim after native readback rejects '+scenario.name,async()=>{
    const f=fixture();
    try{
      await f.call('reserve');
      const pending=f.call('claim');
      await f.gate.entered;
      f.db.exec(scenario.sql);
      f.gate.release();
      await assert.rejects(pending,/CORE_NATIVE_CONSENT_SESSION_CHANGED/);
      assert.equal(f.state(),'unknown','consumed claim must remain terminal');
      await assert.rejects(f.call('claim'),'same request ID must not replay');
      assert.equal(f.reads(),1,'no second native authority readback');
    }finally{f.gate.release();f.db.close();}
  });
}
