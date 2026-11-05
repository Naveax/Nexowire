import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync, type StatementSync} from 'node:sqlite';
import {MemoryControlPlaneStore} from '../src/product/memory-control-plane-store.js';
import {ControlPlaneService} from '../src/product/control-plane-service.js';
import {
  D1ControlPlaneStore, type D1DatabaseLike,
  type D1PreparedStatementLike, type D1ResultLike,
} from '../src/product/d1-control-plane-store.js';

const owner = {accountId:'ai03-owner', role:'user'} as const;
const wrongOwner = {accountId:'ai03-foreign', role:'user'} as const;
async function pair(service:ControlPlaneService, name:string, deviceId?:string) {
  const challenge = await service.beginPairing(owner,name,deviceId);
  return service.consumePairing({
    pairingId:challenge.pairingId,token:challenge.token,
    platform:'win32',deviceAnchorHash:'a'.repeat(64),
  });
}
function grant(value:Awaited<ReturnType<ControlPlaneService['authenticateDeviceCredential']>>) {
  assert.ok(value);
  assert.ok(Number.isSafeInteger(value.authorizationEpoch));
  assert.ok(value.authorizationEpoch! >= 1);
  assert.ok(Number.isSafeInteger(value.leaseExpiresAtMs));
  assert.ok(value.leaseExpiresAtMs! > Date.now());
  assert.ok(value.leaseExpiresAtMs! <= Date.now()+30_500);
  return value.authorizationEpoch!;
}

test('AI-03 memory: SAFE, wrong owner, revoke, re-pair, owner-wide invalidation',async()=>{
  const store=new MemoryControlPlaneStore(), service=new ControlPlaneService(store);
  await service.ensureAccount({id:owner.accountId});
  await service.ensureAccount({id:wrongOwner.accountId});
  const first=await pair(service,'NAVEAX');
  const id=first.device.id;
  assert.equal((await service.authenticateDeviceCredential(first.deviceCredential))?.authorizationEpoch,undefined);
  await assert.rejects(service.setDeviceAccessMode(wrongOwner,id,'full'),/DEVICE_NOT_FOUND/);
  await service.setDeviceAccessMode(owner,id,'full');
  const a=grant(await service.authenticateDeviceCredential(first.deviceCredential));
  assert.equal(await store.getRemoteDeviceAuthorization(id,first.device.credentialHash,wrongOwner.accountId),null);
  await service.setDeviceAccessMode(owner,id,'safe');
  assert.equal((await service.authenticateDeviceCredential(first.deviceCredential))?.leaseExpiresAtMs,undefined);
  await service.setDeviceAccessMode(owner,id,'full');
  const b=grant(await service.authenticateDeviceCredential(first.deviceCredential));
  assert.ok(b>a);
  await assert.rejects(service.revokeDeviceRemoteAuthorization(wrongOwner,id),/DEVICE_NOT_FOUND/);
  assert.equal((await service.revokeDeviceRemoteAuthorization(owner,id)).revoked,true);
  assert.equal((await service.authenticateDeviceCredential(first.deviceCredential))?.authorizationEpoch,undefined);
  assert.equal((await service.revokeDeviceRemoteAuthorization(owner,id)).revoked,false);
  // Repeated unchanged FULL policy or presence must not restore revoked authority.
  await service.setDeviceAccessMode(owner,id,'full');
  assert.equal((await service.authenticateDeviceCredential(first.deviceCredential))?.authorizationEpoch,undefined);
  await service.setDeviceAccessMode(owner,id,'safe');
  await service.setDeviceAccessMode(owner,id,'full');
  const c=grant(await service.authenticateDeviceCredential(first.deviceCredential));
  assert.ok(c>b);
  const rotated=await pair(service,'re-paired NAVEAX',id);
  assert.equal(await service.authenticateDeviceCredential(first.deviceCredential),null);
  const d=grant(await service.authenticateDeviceCredential(rotated.deviceCredential));
  assert.ok(d>c);
  assert.equal(await store.revokeRemoteOwnerAuthorizations(owner.accountId),1);
  assert.equal((await service.authenticateDeviceCredential(rotated.deviceCredential))?.authorizationEpoch,undefined);
  await service.setDeviceAccessMode(owner,id,'safe');
  await service.setDeviceAccessMode(owner,id,'full');
  assert.ok(grant(await service.authenticateDeviceCredential(rotated.deviceCredential))>d);
});

test('AI-03 unavailable authority fails closed without fabricated lease',async()=>{
  class UnavailableStore extends MemoryControlPlaneStore {
    override async getRemoteDeviceAuthorization(_id:string,_hash:string,_owner:string):Promise<number|null> {
      throw new Error('D1_AUTHORITY_UNAVAILABLE');
    }
  }
  const store=new UnavailableStore(), service=new ControlPlaneService(store);
  await service.ensureAccount({id:owner.accountId});
  const device=await pair(service,'unavailable D1');
  await service.setDeviceAccessMode(owner,device.device.id,'full');
  await assert.rejects(service.authenticateDeviceCredential(device.deviceCredential),/D1_AUTHORITY_UNAVAILABLE/);
});

class Statement implements D1PreparedStatementLike {
  constructor(private readonly stmt:StatementSync,private readonly args:unknown[]=[]){}
  bind(...args:unknown[]):D1PreparedStatementLike{return new Statement(this.stmt,args);}
  async first<T>():Promise<T|null>{
    return (this.stmt.get(...(this.args as Parameters<StatementSync['get']>))??null) as T|null;
  }
  async all<T>():Promise<D1ResultLike<T>>{
    return {success:true,results:this.stmt.all(...(this.args as Parameters<StatementSync['all']>)) as T[]};
  }
  async run<T>():Promise<D1ResultLike<T>>{
    const v=this.stmt.run(...(this.args as Parameters<StatementSync['run']>));
    return {success:true,meta:{changes:Number(v.changes)}};
  }
}
class SqliteD1 implements D1DatabaseLike {
  constructor(private readonly db:DatabaseSync){}
  prepare(sql:string):D1PreparedStatementLike{return new Statement(this.db.prepare(sql));}
  async batch(items:D1PreparedStatementLike[]):Promise<D1ResultLike[]>{
    this.db.exec('BEGIN');
    try{
      const out:D1ResultLike[]=[];
      for(const item of items)out.push(await item.run());
      this.db.exec('COMMIT');return out;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
}

test('AI-03 D1: atomic ownership, monotonic epoch, tombstone and reuse',async()=>{
  const db=new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const names=[
    '0001_control_plane.sql','0002_external_identities.sql',
    '0003_quota_subject_device_anchor.sql','0004_device_credential_lookup.sql',
    '0009_device_access_mode.sql','0010_device_runtime_telemetry.sql',
    '0011_device_root_mode_leases.sql','0012_owner_device_folders.sql',
    '0013_owner_device_selection.sql','0014_device_maintenance_preferences.sql',
    '0015_device_bridge_preferences.sql','0016_device_bridge_commands.sql',
    '0019_core_console_authority.sql','0022_remote_agent_authorization_epoch.sql',
  ];
  for(const name of names)db.exec(readFileSync(path.join(process.cwd(),'cloudflare','migrations',name),'utf8'));
  try{
    const store=new D1ControlPlaneStore(new SqliteD1(db));
    const service=new ControlPlaneService(store);
    await service.ensureAccount({id:owner.accountId});
    await service.ensureAccount({id:wrongOwner.accountId});
    const first=await pair(service,'D1 device');
    await service.setDeviceAccessMode(owner,first.device.id,'full');
    const epochA=grant(await service.authenticateDeviceCredential(first.deviceCredential));
    const row=await store.getDevice(first.device.id);assert.ok(row);
    await store.putDevice({...row,online:true,updatedAt:new Date().toISOString()});
    assert.equal(grant(await service.authenticateDeviceCredential(first.deviceCredential)),epochA);
    assert.equal(await store.getRemoteDeviceAuthorization(first.device.id,first.device.credentialHash,wrongOwner.accountId),null);
    assert.equal(await store.revokeRemoteDeviceAuthorization(first.device.id,wrongOwner.accountId),false);
    assert.equal(await store.revokeRemoteDeviceAuthorization(first.device.id,owner.accountId),true);
    assert.equal((await service.authenticateDeviceCredential(first.deviceCredential))?.authorizationEpoch,undefined);
    await service.setDeviceAccessMode(owner,first.device.id,'safe');
    await service.setDeviceAccessMode(owner,first.device.id,'full');
    const epochB=grant(await service.authenticateDeviceCredential(first.deviceCredential));
    assert.ok(epochB>epochA);
    const next=await pair(service,'D1 re-pair',first.device.id);
    assert.equal(await service.authenticateDeviceCredential(first.deviceCredential),null);
    const epochC=grant(await service.authenticateDeviceCredential(next.deviceCredential));
    assert.ok(epochC>epochB);
    db.prepare('DELETE FROM devices WHERE id=?').run(first.device.id);
    const tomb=db.prepare('SELECT authorization_epoch AS epoch,active FROM device_remote_authorization WHERE device_id=?')
      .get(first.device.id) as {epoch:number;active:number};
    assert.equal(tomb.active,0);assert.ok(tomb.epoch>epochC);
    db.prepare(
      'INSERT INTO devices (id,owner_account_id,name,platform,credential_hash,access_mode,online,created_at,updated_at) VALUES (?,?,?,?,?,?,0,?,?)',
    ).run(first.device.id,owner.accountId,'reused','win32','1'.repeat(64),'full',
      new Date().toISOString(),new Date().toISOString());
    const reused=db.prepare('SELECT authorization_epoch AS epoch FROM device_remote_authorization WHERE device_id=?')
      .get(first.device.id) as {epoch:number};
    assert.ok(reused.epoch>tomb.epoch);
    assert.equal(await store.getRemoteDeviceAuthorization(first.device.id,'wrong',owner.accountId),null);
  }finally{db.close();}
});
