import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PostgresDispatchCredentialStore} from '../../src/agent/postgres-dispatch-credential-store.js';
import type {ProtectedDispatchCredentialRecord} from '../../src/agent/protected-broker-dispatch-service.js';
import type {DispatchStorePool} from '../../src/agent/postgres-broker-dispatch-authority.js';

const authorityId=randomUUID(),credentialSha256='a'.repeat(64);
const active:ProtectedDispatchCredentialRecord={credentialSha256,certificateSha256:'b'.repeat(64),
  brokerId:randomUUID(),ownerId:randomUUID(),deviceId:randomUUID(),installationId:randomUUID(),
  deviceEpoch:randomUUID(),sessionEpoch:randomUUID(),state:'ACTIVE',
  notBeforeMs:Date.now()-1000,expiresAtMs:Date.now()+60000};
const role={same_role:true,no_memberships:true,restricted:true,no_ddl:true,can_read:true,
  no_write:true,primary_only:true};

function fixture(){
  let rows:Record<string,unknown>[]=[{...active,notBeforeMs:String(active.notBeforeMs),
    expiresAtMs:String(active.expiresAtMs)}];
  let permissions={...role},trusted=true,verify=true,nativeCalls=0,connects=0;
  let duringNative:()=>void=()=>{};
  const commands:string[]=[],released:boolean[]=[];
  const pool:DispatchStorePool={async connect(){
    connects++;
    return {async query(sql,values){
      commands.push(sql);
      if(sql.startsWith('SELECT session_user='))return {rows:[permissions]};
      if(sql.includes('FROM core_dispatch.broker_credentials c')){
        assert.deepEqual(values,[authorityId,credentialSha256]);
        assert.match(sql,/g\.owner_id=c\.owner_id/);
        assert.match(sql,/g\.device_epoch=c\.device_epoch/);
        assert.match(sql,/g\.session_epoch=c\.session_epoch/);
        assert.match(sql,/g\.broker_id=c\.broker_id/);
        assert.match(sql,/c\.state='ACTIVE'/);
        assert.match(sql,/statement_timestamp\(\)/);
        return {rows};
      }
      assert.match(sql,/^(BEGIN READ ONLY|SET LOCAL (statement_timeout|lock_timeout)=|ROLLBACK)/);
      return {rows:[]};
    },release(destroy=false){released.push(destroy)}};
  }};
  const store=new PostgresDispatchCredentialStore({pool,authorityId,
    verifyProvenance:async()=>({verified:trusted,authorityId,validUntil:Date.now()+10000}),
    verifyInstallationBinding:async(record,signal)=>{
      nativeCalls++;assert.ok(Object.isFrozen(record));assert.equal(signal.aborted,false);
      duringNative();return verify;
    }});
  return {store,commands,released,setRows:(v:Record<string,unknown>[])=>{rows=v},
    setRole:(v:typeof role)=>{permissions=v},setTrust:(v:boolean)=>{trusted=v},
    setVerify:(v:boolean)=>{verify=v},setDuringNative:(v:()=>void)=>{duringNative=v},
    get connects(){return connects},get nativeCalls(){return nativeCalls}};
}
test('dispatch credential store uses a restricted primary read-only transaction and exact digest',async()=>{
  const f=fixture();
  await f.store.assertReady();
  const value=await f.store.lookup(credentialSha256);
  assert.deepEqual(value,active);assert.ok(Object.isFrozen(value));
  assert.equal(await f.store.lookup('bad'),undefined);
  assert.equal(f.connects,2);
  assert.equal(await f.store.verifyLiveBinding(active),true);
  assert.equal(f.nativeCalls,1);
  assert.deepEqual(f.released,[false,false,false]);
});
test('credential reader rejects every unverified privilege or provenance condition',async()=>{
  for(const key of Object.keys(role) as Array<keyof typeof role>){
    const f=fixture();f.setRole({...role,[key]:false});
    await assert.rejects(f.store.assertReady(),/ROLE_UNVERIFIED/);
    assert.equal(await f.store.lookup(credentialSha256),undefined);
    assert.ok(f.released.every(v=>v===true));
  }
  const f=fixture();f.setTrust(false);
  await assert.rejects(f.store.assertReady(),/PROVENANCE_UNVERIFIED/);
  assert.equal(await f.store.lookup(credentialSha256),undefined);
  assert.equal(f.connects,0);
});
test('credential reader rejects ambiguous, revoked, malformed or changed records',async()=>{
  const f=fixture();
  for(const rows of [[],[active,active],[{...active,state:'REVOKED'}],
    [{...active,credentialSha256:'c'.repeat(64)}],[{...active,expiresAtMs:'99999999999999999999'}]]){
    f.setRows(rows);assert.equal(await f.store.lookup(credentialSha256),undefined);
  }
  f.setRows([active]);f.setVerify(false);
  assert.equal(await f.store.verifyLiveBinding(active),false);
  f.setVerify(true);
  f.setDuringNative(()=>f.setRows([]));
  assert.equal(await f.store.verifyLiveBinding(active),false,'revoked while native proof pending');
  f.setRows([active]);
  f.setDuringNative(()=>f.setRows([{...active,installationId:randomUUID()}]));
  assert.equal(await f.store.verifyLiveBinding(active),false,'installation replaced while native proof pending');
});
