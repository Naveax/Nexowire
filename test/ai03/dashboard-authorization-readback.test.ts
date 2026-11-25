import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync,type StatementSync} from 'node:sqlite';
import {D1ControlPlaneStore,type D1DatabaseLike,type D1PreparedStatementLike}
  from '../../src/product/d1-control-plane-store.js';

class Statement implements D1PreparedStatementLike{
  constructor(private readonly s:StatementSync,private readonly values:unknown[]=[]){}
  bind(...values:unknown[]){return new Statement(this.s,values);}
  async first<T>():Promise<T|null>{return (this.s.get(...this.values as never[])??null) as T|null;}
  async all<T>(){return {success:true,results:this.s.all(...this.values as never[]) as T[]};}
  async run<T>(){const r=this.s.run(...this.values as never[]);return {success:true,meta:{changes:Number(r.changes)}};}
}
test('dashboard remote authorization uses owner-scoped SQL, reads revoked epoch without inventing native drain',async()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec("CREATE TABLE accounts(id TEXT PRIMARY KEY); INSERT INTO accounts VALUES ('owner-a'),('owner-b');"+
      "CREATE TABLE devices(id TEXT PRIMARY KEY,owner_account_id TEXT,access_mode TEXT);"+
      "INSERT INTO devices VALUES ('device-a','owner-a','full');"+
      "CREATE TABLE device_remote_authorization(device_id TEXT PRIMARY KEY,owner_account_id TEXT,authorization_epoch INTEGER,active INTEGER);"+
      "INSERT INTO device_remote_authorization VALUES ('device-a','owner-a',7,1);");
    const d1:D1DatabaseLike={prepare:sql=>new Statement(db.prepare(sql)),batch:async statements=>Promise.all(statements.map(s=>s.run()))};
    const store=new D1ControlPlaneStore(d1);
    const before=await store.readRemoteAuthorizationStatus('device-a','owner-a');
    assert.equal(before?.state,'ACTIVE');assert.equal(before?.authorizationEpoch,7);assert.ok((before?.observedAtMs??0)>0);
    assert.equal(await store.readRemoteAuthorizationStatus('device-a','owner-b'),null);
    assert.equal(await store.readRemoteAuthorizationStatus('missing','owner-a'),null);
    assert.equal(await store.revokeRemoteDeviceAuthorization('device-a','owner-a'),true);
    const after=await store.readRemoteAuthorizationStatus('device-a','owner-a');
    assert.equal(after?.state,'REVOKED');assert.equal(after?.authorizationEpoch,8);
    assert.equal(await store.readRemoteAuthorizationStatus('device-a','owner-b'),null);
    assert.equal(await store.revokeRemoteDeviceAuthorization('device-a','owner-a'),false);
    db.exec("UPDATE devices SET owner_account_id='owner-b' WHERE id='device-a'");
    assert.equal(await store.readRemoteAuthorizationStatus('device-a','owner-a'),null);
    assert.equal(await store.readRemoteAuthorizationStatus('device-a','owner-b'),null);
  }finally{db.close();}
});
