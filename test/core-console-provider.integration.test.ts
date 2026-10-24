import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync,type StatementSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {D1CoreConsoleAuthority} from '../src/product/d1-core-console-authority.js';
import type {D1DatabaseLike,D1PreparedStatementLike} from '../src/product/d1-control-plane-store.js';
import {createControlPlaneHttpHandler} from '../src/product/control-plane-http.js';
import {CoreConsoleAdmission} from '../src/agent/core-console-admission.js';
import {CoreConsoleAuthorityClient,WindowsCoreConsoleProvider,type CoreProfileStore} from '../src/agent/windows-core-console-provider.js';
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
  for(const file of ['0014_device_maintenance_preferences.sql','0015_device_bridge_preferences.sql','0019_core_console_authority.sql'])
    db.exec(readFileSync(new URL('../cloudflare/migrations/'+file,import.meta.url),'utf8'));
  db.exec(`INSERT INTO device_maintenance_preferences VALUES('${deviceId}','${owner}',1,'2026-10-24');
    INSERT INTO device_bridge_preferences VALUES('${deviceId}','${owner}','auto','2026-10-24');`);
  // Idempotent migration must not reset existing counters, keys or requests.
  db.exec(readFileSync(new URL('../cloudflare/migrations/0019_core_console_authority.sql',import.meta.url),'utf8'));
  const d1:D1DatabaseLike={prepare:sql=>new Statement(db.prepare(sql)),
    batch:async statements=>{db.exec('BEGIN');try{const r=await Promise.all(statements.map(s=>s.run()));db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
  const authority=new D1CoreConsoleAuthority(d1);
  const handler=createControlPlaneHttpHandler({} as never,{authenticate:async()=>null,coreConsoleAuthority:authority});
  let beforeRequest:((body:Record<string,unknown>)=>void)|undefined;
  const fetcher=(async(input,init)=>{const request=new Request(String(input),init);
    beforeRequest?.(JSON.parse(String(init?.body)));return handler(request);}) as typeof fetch;
  const client=new CoreConsoleAuthorityClient('https://core.example',credential,fetcher);
  let record:Profile|null=null,stopped=false,blocked=false,consents=0,effects=0,desktop=true,bridge=true;
  let onNative:(()=>Promise<void>)|undefined;
  const store:CoreProfileStore={stopFile:'fixture-only-STOP',load:async()=>structuredClone(record),
    save:async p=>{record=structuredClone(p);},stop:async()=>{stopped=true;},clearStop:async()=>{stopped=false;},stopped:async()=>stopped,
    block:async()=>{blocked=true;},clearBlock:async()=>{blocked=false;},blocked:async()=>blocked};
  const options={deviceId,authority:client,store,
    broker:{probe:async()=>({reachable:bridge,elevated:bridge,version:NEXOWIRE_VERSION})},
    consent:async()=>{consents++;return true;},
    native:async()=>{effects++;await onNative?.();return {data:{syntheticNativeEffect:true}};},
    monitor:{desktopAllowed:()=>desktop,close:()=>{}},
  };
  const make=async()=>{const provider=new WindowsCoreConsoleProvider(options);await provider.initialize();
    return {provider,controller:new CoreConsoleAdmission(undefined,provider)};};
  return {db,authority,client,store,make,consents:()=>consents,effects:()=>effects,
    profile:()=>structuredClone(record)!,setProfile:(p:Profile)=>{record=structuredClone(p);},
    setDesktop:(v:boolean)=>{desktop=v;},setBridge:(v:boolean)=>{bridge=v;},
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
    assert.equal((await f.authority.deviceStatus(deviceId,owner)).active,true);
    await assert.rejects(f.authority.handle(credential,report),/NONCE_REPLAY/);
    f.db.exec('UPDATE device_core_console_authority SET status_observed_at_ms=0');
    assert.equal((await f.authority.deviceStatus(deviceId,owner)).active,false);
    f.db.exec('UPDATE device_maintenance_preferences SET enabled=0');
    const status=await f.authority.deviceStatus(deviceId,owner);
    assert.equal(status.active,false);assert.equal(status.localEnrolled,false);
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
