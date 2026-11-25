import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';

const source=readFileSync('web/app.js','utf8');
const start=source.indexOf('function coreEnrollmentEligible(');
const end=source.indexOf('async function setDeviceBridgePreference(',start);
assert.ok(start>=0&&end>start,'actual CORE action implementation');

function device(overrides:Record<string,unknown>={}){
  return {id:'fixture-owner-device',platform:'win32',online:true,accessMode:'full',
    privilegeMode:'broker',adminBridgeReady:true,bridgePreference:{desiredMode:'auto'},
    persistentMaintenance:{enabled:true,active:false},
    physicalConsole:{deviceReady:true,localEnrolled:false,enrollmentRequested:false,active:false,observedAtMs:null},
    ...overrides};
}
type Device=ReturnType<typeof device>;
function snapshot(devices:Device[],accountId='fixture-owner'){return {accountId,devices}}
class Element {
  disabled=false;value='CORE UNLIMITED';textContent='';focused=false;
  focus(){this.focused=true}
}
function sharedBrowser(){
  const records=new Map<string,string>();
  const locks=new Set<string>();
  const localStorage={
    get length(){return records.size},
    key(index:number){return [...records.keys()][index]??null},
    getItem(key:string){return records.get(key)??null},
    setItem(key:string,value:string){records.set(key,value)},
    removeItem(key:string){records.delete(key)},
  };
  const navigator={locks:{request:async(key:string,_options:unknown,callback:(lock:object|null)=>unknown)=>{
    if(locks.has(key))return callback(null);
    locks.add(key);
    try{return await callback({name:key})}finally{locks.delete(key)}
  }}};
  return {records,localStorage,navigator};
}
function fixture(initial:Device,handler:()=>Promise<Response>,shared=sharedBrowser()){
  const nodes=new Map<string,Element>();
  const row={querySelector:(selector:string)=>{
    if(!nodes.has(selector))nodes.set(selector,new Element());
    return nodes.get(selector)!;
  }};
  const posts:{path:string;init:RequestInit}[]=[];
  let reads=0;
  let server=snapshot([initial]);
  const ctx=runInNewContext('const coreOperations=new Map();let currentSnapshot=null;\n'+
    source.slice(start,end)+'\n({setSnapshot:value=>currentSnapshot=value,coreOperations,coreEnrollmentEligible,coreReadbackMessage,reconcileCoreReadback,coreOperationAllows,performCoreAction,captureCoreFences,coreOperationFor})',{
      AbortSignal,crypto:{randomUUID},navigator:shared.navigator,localStorage:shared.localStorage,
      fetch:async(path:string,init:RequestInit)=>{if(init.method!=='POST')return Response.json(server);posts.push({path,init});return handler()},
      load:async()=>{reads++},
    }) as {
      setSnapshot(value:ReturnType<typeof snapshot>):void;
      coreOperations:Map<string,{inFlight:boolean;acknowledged:boolean;kind:string}>;
      coreEnrollmentEligible(value:Device):boolean;
      coreReadbackMessage(value:Device,operation?:unknown):string;
      reconcileCoreReadback(value:ReturnType<typeof snapshot>,captured:Map<string,string>):Promise<void>;
      captureCoreFences():Map<string,string>;
      coreOperationFor(id:string):unknown;
      coreOperationAllows(id:string,kind:string):boolean;
      performCoreAction(id:string,kind:string,row:unknown):Promise<void>;
    };
  ctx.setSnapshot(snapshot([initial]));
  return {...ctx,row,posts,reads:()=>reads,shared,
    setSnapshot(value:ReturnType<typeof snapshot>){server=value;ctx.setSnapshot(value)},
    setServer(value:ReturnType<typeof snapshot>){server=value},
    reconcileCoreReadback(value:ReturnType<typeof snapshot>,captured=ctx.captureCoreFences()){return ctx.reconcileCoreReadback(value,captured)},
  };
}

test('AI-06 readback: consent is eligible only for explicit current backend readiness and no pending/confirmed enrollment',()=>{
  const d=device();
  const f=fixture(d,async()=>Response.json({}));
  assert.equal(f.coreEnrollmentEligible(d),true);
  for(const candidate of [
    device({online:false}),device({platform:'linux'}),device({accessMode:'safe'}),
    device({privilegeMode:'direct'}),device({adminBridgeReady:false}),
    device({bridgePreference:{desiredMode:'off'}}),device({bridgePreference:undefined}),
    device({persistentMaintenance:{enabled:false}}),device({physicalConsole:undefined}),
    device({physicalConsole:{deviceReady:true,localEnrolled:false}}),
    device({physicalConsole:{deviceReady:false,localEnrolled:false,enrollmentRequested:false}}),
    device({physicalConsole:{deviceReady:true,localEnrolled:false,enrollmentRequested:true}}),
    device({physicalConsole:{deviceReady:true,localEnrolled:true,enrollmentRequested:false}}),
    device({physicalConsole:{deviceReady:true,localEnrolled:false,enrollmentRequested:false,active:true}}),
  ])assert.equal(f.coreEnrollmentEligible(candidate),false,JSON.stringify(candidate));
});

test('AI-06 readback: same-device in-flight guard and stale/foreign readback cannot replay consent',async()=>{
  const d=device();
  let release!:(r:Response)=>void;
  const pending=new Promise<Response>(resolve=>{release=resolve});
  const f=fixture(d,()=>pending);
  const first=f.performCoreAction(d.id,'consent',f.row);
  await new Promise<void>(resolve=>setImmediate(resolve));
  // Same device, new row or old row: the fence is independent of DOM lifetime.
  f.setSnapshot(snapshot([d]));
  await f.performCoreAction(d.id,'consent',f.row);
  await f.performCoreAction(d.id,'disable',f.row);
  assert.equal(f.posts.length,1);
  assert.equal(f.posts[0]?.path,'/api/v1/me/devices/core-enrollment-request');
  assert.deepEqual(JSON.parse(String(f.posts[0]?.init.body)),{deviceId:d.id});
  const requested=device({physicalConsole:{deviceReady:true,localEnrolled:false,enrollmentRequested:true}});
  await f.reconcileCoreReadback(snapshot([requested]));
  assert.equal(f.coreOperations.get(d.id)?.inFlight,true);
  release(Response.json({error:'PRIVATE_SENTINEL'},{status:503}));await first;
  assert.equal(f.reads(),1);
  await f.reconcileCoreReadback(snapshot([d]));
  await f.reconcileCoreReadback(snapshot([requested],'different-owner'));
  await f.reconcileCoreReadback(snapshot([requested,requested]));
  assert.equal(f.coreOperationAllows(d.id,'consent'),false);
  await f.performCoreAction(d.id,'consent',f.row);
  assert.equal(f.posts.length,1);
  await f.reconcileCoreReadback(snapshot([requested]));f.setSnapshot(snapshot([requested]));
  assert.equal(f.coreOperations.has(d.id),false);
  await f.performCoreAction(d.id,'consent',f.row);
  assert.equal(f.posts.length,1,'already recorded request must not be repeated');
  assert.match(f.coreReadbackMessage(requested),/teslimi.*doğrulanmadı/);
});

test('AI-06 readback: consent response alone is not delivery or native approval',async()=>{
  const d=device();
  const f=fixture(d,async()=>Response.json({deviceId:d.id,enrollmentRequested:true,active:false}));
  await f.performCoreAction(d.id,'consent',f.row);
  assert.equal(f.coreOperations.get(d.id)?.acknowledged,true);
  await f.reconcileCoreReadback(snapshot([d]));
  assert.equal(f.coreOperationAllows(d.id,'consent'),false,'ACK without matching readback must not reopen request');
  const message=f.coreReadbackMessage(d,f.coreOperations.get(d.id));
  assert.match(message,/belirsiz|readback/);
  assert.match(message,/yerel iptal.*doğrulanmadı/);
});

test('AI-06 readback: ambiguous enable may persist preference; explicit OFF can safely cancel without asserting STOP',async()=>{
  const d=device({persistentMaintenance:{enabled:false,active:false}});
  let first=true;
  const f=fixture(d,async()=>{if(first){first=false;throw Error('private upstream token')}
    return Response.json({deviceId:d.id,persistentMaintenance:{enabled:false,active:false,updatedAt:'fixture'}})});
  await f.performCoreAction(d.id,'enable',f.row);
  assert.equal(f.coreOperations.get(d.id)?.acknowledged,false);
  const enabled=device();
  await f.reconcileCoreReadback(snapshot([enabled]));f.setSnapshot(snapshot([enabled]));
  assert.equal(f.coreOperationAllows(d.id,'consent'),false);
  assert.equal(f.coreOperationAllows(d.id,'disable'),true);
  await f.performCoreAction(d.id,'disable',f.row);
  assert.equal(f.posts.length,2);
  assert.deepEqual(JSON.parse(String(f.posts[1]?.init.body)),{deviceId:d.id,enabled:false});
  await f.reconcileCoreReadback(snapshot([enabled]));
  assert.equal(f.coreOperationAllows(d.id,'disable'),false);
  assert.equal(f.coreOperationAllows(d.id,'enable'),false);
  await f.reconcileCoreReadback(snapshot([d]));
  assert.equal(f.coreOperations.has(d.id),false);
  const off=f.coreReadbackMessage(d);
  assert.match(off,/hesap tercihini kapalı bildiriyor/);
  assert.match(off,/yerel STOP.*kanıtı değildir/);
  assert.doesNotMatch(off,/STOP başarılı|CORE FİZİKSEL AÇIK/);
});

test('AI-06 readback: malformed or wrong-device ACK does not confirm enable, duplicate identity rejects actions',async()=>{
  const d=device({persistentMaintenance:{enabled:false,active:false}});
  for(const reply of [()=>Response.json({deviceId:'other',persistentMaintenance:{enabled:true,active:false}}),
    ()=>new Response('not-json',{status:200}),()=>Response.json({deviceId:d.id,persistentMaintenance:{enabled:true,active:true}})]){
    const f=fixture(d,async()=>reply());
    await f.performCoreAction(d.id,'enable',f.row);
    assert.equal(f.coreOperations.get(d.id)?.acknowledged,false);
    await f.reconcileCoreReadback(snapshot([device()]));
    assert.equal(f.coreOperationAllows(d.id,'consent'),false);
  }
  const f=fixture(d,async()=>Response.json({}));
  f.setSnapshot(snapshot([d,d]));
  await f.performCoreAction(d.id,'enable',f.row);
  assert.equal(f.posts.length,0);
});

test('AI-06 readback: actual backend denial code is localized but no raw error or false cancellation is shown',async()=>{
  const d=device();
  for(const [error,expected] of [
    ['CORE_NATIVE_CONSENT_PROVIDER_UNAVAILABLE',/Bağımsız yerel onay sağlayıcısı/],
    ['CORE_ALREADY_ENROLLED',/yerel CORE kaydının mevcut/],
    ['private token=fixture',/Sunucu isteği doğrulayamadı/],
    ['__proto__',/Sunucu isteği doğrulayamadı/],
  ] as const){
    const f=fixture(d,async()=>Response.json({error},{status:500}));
    await f.performCoreAction(d.id,'consent',f.row);
    const message=f.coreReadbackMessage(d,f.coreOperations.get(d.id));
    assert.match(message,/HTTP 500/);
    assert.match(message,expected);
    assert.doesNotMatch(message,/private token|__proto__|CORE_NATIVE_CONSENT_PROVIDER_UNAVAILABLE/);
    assert.equal(f.coreOperationAllows(d.id,'consent'),false);
  }
});

test('AI-06 cross-tab/reload: shared uncertainty survives lost ACK and stale cards cannot POST',async()=>{
  const d=device(),shared=sharedBrowser();
  let release!:(response:Response)=>void;
  const pending=new Promise<Response>(resolve=>{release=resolve});
  const first=fixture(d,()=>pending,shared);
  const second=fixture(d,async()=>Response.json({}),shared);
  const action=first.performCoreAction(d.id,'consent',first.row);
  await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(first.posts.length,1);
  const inFlightCapture=second.captureCoreFences();
  await second.performCoreAction(d.id,'consent',second.row);
  await second.performCoreAction(d.id,'disable',second.row);
  assert.equal(second.posts.length,0);
  release(Response.json({error:'PRIVATE_SENTINEL'},{status:503}));await action;
  const earlyPending=device({physicalConsole:{deviceReady:true,localEnrolled:false,enrollmentRequested:true,active:false}});
  await second.reconcileCoreReadback(snapshot([earlyPending]),inFlightCapture);
  assert.equal(shared.records.size,1,'GET started during earlier in-flight phase cannot clear settled marker');
  const reloaded=fixture(d,async()=>Response.json({}),shared);
  await reloaded.performCoreAction(d.id,'consent',reloaded.row);
  assert.equal(reloaded.posts.length,0);
  await reloaded.reconcileCoreReadback(snapshot([d]));
  assert.equal(reloaded.coreOperationAllows(d.id,'consent'),false);
  const requested=device({physicalConsole:{deviceReady:true,localEnrolled:false,enrollmentRequested:true,active:false}});
  await reloaded.reconcileCoreReadback(snapshot([requested]));
  assert.equal(shared.records.size,0);
  // The old second tab still has its original eligible UI snapshot.
  second.setServer(snapshot([requested]));
  await second.performCoreAction(d.id,'consent',second.row);
  assert.equal(second.posts.length,0,'fresh GET under lock denies stale card');
});

test('AI-06 cross-tab/reload: old GET cannot clear later operation and corrupt storage denies POST',async()=>{
  const d=device(),shared=sharedBrowser();
  const f=fixture(d,async()=>Response.json({error:'UNKNOWN'},{status:503}),shared);
  const captured=f.captureCoreFences();
  await f.performCoreAction(d.id,'consent',f.row);
  const requested=device({physicalConsole:{deviceReady:true,localEnrolled:false,enrollmentRequested:true,active:false}});
  await f.reconcileCoreReadback(snapshot([requested]),captured);
  assert.equal(shared.records.size,1);
  const key=[...shared.records.keys()][0]!;
  shared.records.set(key,'{malformed');
  const fresh=fixture(d,async()=>Response.json({}),shared);
  await fresh.performCoreAction(d.id,'consent',fresh.row);
  await fresh.performCoreAction(d.id,'disable',fresh.row);
  assert.equal(fresh.posts.length,0);
  assert.equal(shared.records.get(key),'{malformed');
});

test('AI-06 cross-tab/reload: unavailable lock or failed durable write never falls back to POST',async()=>{
  const d=device();
  const denied=sharedBrowser();
  denied.localStorage.setItem=()=>{throw Error('storage denied')};
  const f=fixture(d,async()=>Response.json({}),denied);
  await f.performCoreAction(d.id,'consent',f.row);
  assert.equal(f.posts.length,0);
  const unsupported=sharedBrowser();
  Object.defineProperty(unsupported.navigator,'locks',{value:undefined});
  const g=fixture(d,async()=>Response.json({}),unsupported);
  await g.performCoreAction(d.id,'consent',g.row);
  assert.equal(g.posts.length,0);
});
