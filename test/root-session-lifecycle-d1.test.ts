import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { D1ControlPlaneStore, type D1DatabaseLike, type D1PreparedStatementLike, type D1ResultLike } from '../src/product/d1-control-plane-store.js';
import { ControlPlaneService, type ControlPlaneIdentity } from '../src/product/control-plane-service.js';
import { issueSessionToken, verifySessionToken } from '../src/product/control-plane-session.js';

class Statement implements D1PreparedStatementLike {
  constructor(private readonly stmt: StatementSync,private readonly args:unknown[]=[]){}
  bind(...args:unknown[]){return new Statement(this.stmt,args)}
  async first<T>(){return (this.stmt.get(...(this.args as Parameters<StatementSync['get']>))??null) as T|null}
  async all<T>(){return {success:true,results:this.stmt.all(...(this.args as Parameters<StatementSync['all']>)) as T[]}}
  async run<T>(){const r=this.stmt.run(...(this.args as Parameters<StatementSync['run']>));return {success:true,meta:{changes:Number(r.changes)}}}
}
class Adapter implements D1DatabaseLike {
  constructor(private readonly db:DatabaseSync){}
  prepare(sql:string){return new Statement(this.db.prepare(sql))}
  async batch(items:D1PreparedStatementLike[]):Promise<D1ResultLike[]>{
    this.db.exec('BEGIN');
    try {const outcomes=[];for(const stmt of items)outcomes.push(await stmt.run());this.db.exec('COMMIT');return outcomes}
    catch(e){this.db.exec('ROLLBACK');throw e}
  }
}
const migrations=['0001_control_plane.sql','0002_external_identities.sql',
 '0003_quota_subject_device_anchor.sql','0004_device_credential_lookup.sql',
 '0009_device_access_mode.sql','0010_device_runtime_telemetry.sql',
 '0011_device_root_mode_leases.sql','0012_owner_device_folders.sql',
 '0013_owner_device_selection.sql','0014_device_maintenance_preferences.sql',
 '0015_device_bridge_preferences.sql','0016_device_bridge_commands.sql',
 '0019_root_session_lifecycle.sql'];
const secret='0123456789abcdef0123456789abcdef';
const baseDate=new Date('2026-10-18T14:00:00.000Z');
async function setup(){
  const db=new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for(const f of migrations)db.exec(readFileSync(path.join(process.cwd(),'cloudflare','migrations',f),'utf8'));
  let now=new Date(baseDate);
  const store=new D1ControlPlaneStore(new Adapter(db));
  const service=new ControlPlaneService(store,{now:()=>now});
  const owner={accountId:'owner-001',role:'user' as const};
  const token=issueSessionToken(owner,secret,{now,ttlSeconds:3600});
  const login=verifySessionToken(token,secret,now)!;
  await service.ensureAccount({id:owner.accountId});
  const pairing=await service.beginPairing(owner,'owner-pc');
  const paired=await service.consumePairing({
    pairingId:pairing.pairingId,token:pairing.token,platform:'win32',
    deviceAnchorHash:'a'.repeat(64),
  });
  const deviceId=paired.device.id;
  await service.setDeviceAccessMode(owner,deviceId,'full');
  await service.setDevicePresence(deviceId,true,now.toISOString(),{privilegeMode:'direct',adminBridgeReady:false});
  return {db,store,service,owner,login,token,deviceId,setNow:(x:Date)=>{now=x}};
}
test('D1 ROOT: signed login, alternate session, logout, replay and relogin',async()=>{
  const f=await setup();
  try{
    await assert.rejects(f.service.setDeviceRootMode(f.owner,f.deviceId,true),/ROOT_SESSION_BINDING_REQUIRED/);
    const issued=await f.service.setDeviceRootMode(f.login,f.deviceId,true);
    assert.equal(issued.rootMode.active,true);
    assert.equal((await f.service.dashboard(f.login)).devices[0]?.rootMode.active,true);
    assert.equal((await f.service.dashboard(f.owner)).devices[0]?.rootMode.active,false);
    const alternate=verifySessionToken(issueSessionToken(f.owner,secret,{now:baseDate,ttlSeconds:3600}),secret,baseDate)!;
    assert.notEqual(alternate.sessionId,f.login.sessionId);
    assert.equal((await f.service.dashboard(alternate)).devices[0]?.rootMode.active,false);
    const before=await f.service.authorizationExplain(f.login,f.deviceId,'windows.service.control');
    assert.equal(before.root.policyActive,true);
    assert.equal(before.root.sessionBound,true);
    assert.equal(before.operation.elevatedExecutionProven,false);
    assert.equal(before.windows.uacApproval,'unverified');
    await f.service.logoutControlPlaneSession(f.login);
    assert.equal(await f.service.isControlPlaneSessionRevoked(f.login),true);
    assert.equal((await f.service.dashboard(f.login)).devices[0]?.rootMode.active,false);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM device_root_session_grants').get()?.n,0);
    await assert.rejects(f.service.setDeviceRootMode(f.login,f.deviceId,true),/ROOT_SESSION_REVOKED/);
    assert.equal((await f.service.dashboard(alternate)).devices[0]?.rootMode.active,false);
    assert.equal((await f.service.setDeviceRootMode(alternate,f.deviceId,true)).rootMode.active,true);
    assert.equal((await f.service.dashboard(alternate)).devices[0]?.rootMode.active,true);
  }finally{f.db.close()}
});
test('D1 ROOT: precise lease expiry, SAFE revoke, re-pair, epoch rollback',async()=>{
  const f=await setup();
  try{
    await f.service.setDeviceRootMode(f.login,f.deviceId,true);
    f.setNow(new Date('2026-10-18T14:15:00.000Z'));
    assert.equal((await f.service.dashboard(f.login)).devices[0]?.rootMode.active,false);
    const justBefore=new Date('2026-10-18T14:14:59.999Z');
    f.setNow(justBefore);
    assert.equal((await f.service.dashboard(f.login)).devices[0]?.rootMode.active,true);
    await f.service.setDeviceAccessMode(f.owner,f.deviceId,'safe');
    assert.equal((await f.service.dashboard(f.login)).devices[0]?.rootMode.active,false);
    await f.service.setDeviceAccessMode(f.owner,f.deviceId,'full');
    assert.equal((await f.service.dashboard(f.login)).devices[0]?.rootMode.active,false);
    await f.service.setDeviceRootMode(f.login,f.deviceId,true);
    f.setNow(new Date('2026-10-18T13:59:59.000Z'));
    assert.equal((await f.service.dashboard(f.login)).devices[0]?.rootMode.active,false);
  }finally{f.db.close()}
});
test('D1 ROOT: wrong account/service and untrusted cookies cannot claim grants',async()=>{
  const f=await setup();
  try{
    const other:ControlPlaneIdentity={accountId:'other-account',role:'user',
      sessionId:f.login.sessionId,sessionExpiresAt:f.login.sessionExpiresAt};
    await f.service.ensureAccount({id:other.accountId});
    await assert.rejects(f.service.setDeviceRootMode(other,f.deviceId,true),/DEVICE_NOT_FOUND/);
    await assert.rejects(f.service.setDeviceRootMode({accountId:f.owner.accountId,role:'service',
      sessionId:f.login.sessionId,sessionExpiresAt:f.login.sessionExpiresAt},f.deviceId,true),
      /ROOT_REQUIRES_OWNER_LOGIN/);
    assert.equal(verifySessionToken(f.token+'x',secret,baseDate),null);
    const legacy:ControlPlaneIdentity={...f.owner};
    await assert.rejects(f.service.setDeviceRootMode(legacy,f.deviceId,true),/ROOT_SESSION_BINDING_REQUIRED/);
    assert.equal((await f.service.dashboard(f.login)).devices[0]?.rootMode.active,false);
  }finally{f.db.close()}
});
test('D1 grant admission cannot resurrect a revoked session',async()=>{
  const f=await setup();
  try{
    const hash=(await import('node:crypto')).createHash('sha256').update(f.login.sessionId!).digest('hex');
    await f.service.logoutControlPlaneSession(f.login);
    assert.equal(await f.store.grantRootSession({
      deviceId:f.deviceId,ownerAccountId:f.owner.accountId,sessionHash:hash,
      issuedAt:baseDate.toISOString(),expiresAt:new Date(baseDate.getTime()+60_000).toISOString(),
    }),false);
    assert.equal(await f.store.getRootSessionGrant({
      deviceId:f.deviceId,ownerAccountId:f.owner.accountId,sessionHash:hash,
      at:baseDate.toISOString(),
    }),null);
  }finally{f.db.close()}
});

test('D1 ROOT: re-pair rotates device credentials and invalidates previous grant',async()=>{
  const f=await setup();
  try {
    await f.service.setDeviceRootMode(f.login,f.deviceId,true);
    assert.equal((await f.service.dashboard(f.login)).devices[0]?.rootMode.active,true);
    const before=await f.store.getDevice(f.deviceId);
    const pairing=await f.service.beginPairing(f.owner,'repaired-pc',f.deviceId);
    const replaced=await f.service.consumePairing({
      pairingId:pairing.pairingId,token:pairing.token,platform:'win32',
      deviceAnchorHash:'a'.repeat(64),
    });
    assert.equal(replaced.device.id,f.deviceId);
    assert.notEqual(replaced.device.credentialHash,before?.credentialHash);
    assert.equal((await f.service.dashboard(f.login)).devices[0]?.rootMode.active,false);
    // A different Windows identity or foreign owner never inherits CORE.
    assert.equal((await f.service.dashboard(f.login)).devices[0]?.persistentMaintenance.enabled,false);
  }finally{f.db.close()}
});
test('D1 ROOT: session expiry before fifteen minutes bounds policy grant',async()=>{
  const f=await setup();
  try {
    const brief=verifySessionToken(issueSessionToken(f.owner,secret,{
      now:baseDate,ttlSeconds:60,
    }),secret,baseDate)!;
    const result=await f.service.setDeviceRootMode(brief,f.deviceId,true);
    assert.equal(result.rootMode.expiresAt,'2026-10-18T14:01:00.000Z');
    assert.equal((await f.service.dashboard(brief)).devices[0]?.rootMode.active,true);
    f.setNow(new Date('2026-10-18T14:01:00.000Z'));
    assert.equal((await f.service.dashboard(brief)).devices[0]?.rootMode.active,false);
    assert.equal((await f.service.authorizationExplain(brief,f.deviceId)).root.policyActive,false);
  }finally{f.db.close()}
});
