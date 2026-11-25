import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {randomUUID} from 'node:crypto';

const source=readFileSync('web/app.js','utf8');
const start=source.indexOf('function validCoreRevision(');
const end=source.indexOf('async function setDeviceBridgePreference(',start);
assert.ok(start>=0&&end>start,'actual CORE action implementation');

function device(overrides:Record<string,unknown>={}){
  return {id:'fixture-owner-device',platform:'win32',online:true,accessMode:'full',
    privilegeMode:'broker',adminBridgeReady:true,bridgePreference:{desiredMode:'auto'},
    persistentMaintenance:{enabled:true,active:false},coreMutationRevision:7,
    physicalConsole:{deviceReady:true,localEnrolled:false,enrollmentRequested:false,active:false,observedAtMs:null},
    ...overrides};
}
type Device=ReturnType<typeof device>;
function snapshot(devices:Device[],accountId='fixture-owner'){return {accountId,devices}}
class Element {
  disabled=false;value='CORE UNLIMITED';textContent='';focused=false;isConnected=true;
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
function fixture(initial:Device,handler:(init:RequestInit)=>Promise<Response>,shared=sharedBrowser()){
  const nodes=new Map<string,Element>();
  const row={querySelector:(selector:string)=>{
    if(!nodes.has(selector))nodes.set(selector,new Element());
    return nodes.get(selector)!;
  }};
  const posts:{path:string;init:RequestInit}[]=[];
  let reads=0;
  let server=snapshot([initial]);
  const receipts=new Map<string,unknown>();
  const timers:(()=>void)[]=[];
  const ctx=runInNewContext('const coreOperations=new Map();let currentSnapshot=null;\n'+
    source.slice(start,end)+'\n({setSnapshot:value=>currentSnapshot=value,coreOperations,coreEnrollmentEligible,coreReadbackMessage,reconcileCoreReadback,coreOperationAllows,performCoreAction,captureCoreFences,coreOperationFor,coreRemoteReadback,renderCoreReadbackCopy})',{
      AbortSignal,crypto:{randomUUID},navigator:shared.navigator,localStorage:shared.localStorage,
      setTimeout:(callback:()=>void)=>{timers.push(callback)},
      fetch:async(path:string,init:RequestInit)=>{if(path.startsWith('/api/v1/me/mutations/status?')){
        const id=new URL(path,'https://fixture.invalid').searchParams.get('mutationId')!;
        return receipts.has(id)?Response.json(receipts.get(id)):Response.json({error:'MUTATION_NOT_FOUND'},{status:404});
      }if(init.method!=='POST')return Response.json(server);posts.push({path,init});return handler(init)},
      load:async()=>{reads++},
    }) as {
      setSnapshot(value:ReturnType<typeof snapshot>):void;
      coreOperations:Map<string,{inFlight:boolean;acknowledged:boolean;kind:string}>;
      coreEnrollmentEligible(value:Device):boolean;
      coreReadbackMessage(value:Device,operation?:unknown):string;
      coreRemoteReadback(value:Device,view:ReturnType<typeof snapshot>,now?:number):{text:string;expiresAtMs:number|null};
      renderCoreReadbackCopy(element:Element,value:Device,view:ReturnType<typeof snapshot>,operation?:unknown):void;
      reconcileCoreReadback(value:ReturnType<typeof snapshot>,captured:Map<string,string>):Promise<void>;
      captureCoreFences():Map<string,string>;
      coreOperationFor(id:string):unknown;
      coreOperationAllows(id:string,kind:string):boolean;
      performCoreAction(id:string,kind:string,row:unknown,renderedRevision?:number):Promise<void>;
    };
  ctx.setSnapshot(snapshot([initial]));
  return {...ctx,row,posts,reads:()=>reads,shared,timers,
    receipt(state:string,overrides:Record<string,unknown>={},kind='consent'){
      const record=[...shared.records.values()].map(raw=>JSON.parse(raw)).find(value=>value.kind===kind);
      assert.ok(record,'fixture must have actual persisted intent');
      const id='core-v1:'+record.id;
      receipts.set(id,{mutationId:id,deviceId:record.deviceId,kind:'core-'+record.kind,state,expectedRevision:record.expectedRevision,...overrides});
    },
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
    device({persistentMaintenance:{enabled:false}}),device({physicalConsole:undefined}),device({coreMutationRevision:null}),device({coreMutationRevision:0}),
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
  assert.deepEqual(JSON.parse(String(f.posts[0]?.init.body)),{deviceId:d.id,expectedRevision:7});
  const requested=device({coreMutationRevision:8,physicalConsole:{deviceReady:true,localEnrolled:false,enrollmentRequested:true}});
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
  await f.reconcileCoreReadback(snapshot([requested]));
  assert.equal(f.coreOperationAllows(d.id,'consent'),false,'pending boolean is not a terminal receipt');
  f.receipt('PENDING');await f.reconcileCoreReadback(snapshot([requested]));
  assert.equal(f.coreOperationAllows(d.id,'consent'),false);
  f.receipt('APPLIED',{expectedRevision:6});await f.reconcileCoreReadback(snapshot([requested]));
  assert.equal(f.coreOperationAllows(d.id,'consent'),false);
  f.receipt('APPLIED');await f.reconcileCoreReadback(snapshot([d]));
  assert.equal(f.coreOperationAllows(d.id,'consent'),false,'older dashboard does not settle APPLIED');
  await f.reconcileCoreReadback(snapshot([requested]));f.setSnapshot(snapshot([requested]));
  assert.equal(f.coreOperations.has(d.id),false);
  await f.performCoreAction(d.id,'consent',f.row);
  assert.equal(f.posts.length,1,'already recorded request must not be repeated');
  assert.match(f.coreReadbackMessage(requested),/teslimi.*doğrulanmadı/);
});

test('AI-06 readback: consent response alone is not delivery or native approval',async()=>{
  const d=device();
  const f=fixture(d,async init=>Response.json({deviceId:d.id,enrollmentRequested:true,active:false,mutationId:new Headers(init.headers).get('X-Nexowire-Mutation-Id')}));
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
  const enabled=device({coreMutationRevision:8});
  await f.reconcileCoreReadback(snapshot([enabled]));f.setSnapshot(snapshot([enabled]));
  assert.equal(f.coreOperationAllows(d.id,'consent'),false);
  assert.equal(f.coreOperationAllows(d.id,'disable'),true);
  await f.performCoreAction(d.id,'disable',f.row);
  assert.equal(f.posts.length,2);
  assert.deepEqual(JSON.parse(String(f.posts[1]?.init.body)),{deviceId:d.id,enabled:false,expectedRevision:8});
  assert.equal(f.shared.records.size,2,'OFF preserves unresolved enable identity');
  await f.reconcileCoreReadback(snapshot([enabled]));
  assert.equal(f.coreOperationAllows(d.id,'disable'),false);
  assert.equal(f.coreOperationAllows(d.id,'enable'),false);
  const offDevice=device({coreMutationRevision:9,persistentMaintenance:{enabled:false,active:false}});
  f.receipt('APPLIED',{},'disable');
  await f.reconcileCoreReadback(snapshot([offDevice]));
  assert.equal(f.shared.records.size,1,'original unresolved enable is retained');
  f.receipt('APPLIED',{},'enable');
  await f.reconcileCoreReadback(snapshot([offDevice]));
  assert.equal(f.shared.records.size,0);
  assert.equal(f.coreOperations.has(d.id),false);
  const off=f.coreReadbackMessage(offDevice);
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
  const requested=device({coreMutationRevision:8,physicalConsole:{deviceReady:true,localEnrolled:false,enrollmentRequested:true,active:false}});
  await reloaded.reconcileCoreReadback(snapshot([requested]));
  assert.equal(shared.records.size,1,'matching dashboard alone is not a receipt');
  reloaded.receipt('APPLIED');
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
  const requested=device({coreMutationRevision:8,physicalConsole:{deviceReady:true,localEnrolled:false,enrollmentRequested:true,active:false}});
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

function revocationV1(now:number,state='REVOKED',epoch=8){
  return {version:1,source:'D1_REMOTE_AUTHORIZATION',
    remoteAuthorization:{state,authorizationEpoch:epoch,observedAtMs:now},
    localStop:'UNKNOWN',pendingRevoke:'UNKNOWN',nativeDrain:'UNKNOWN',
    effectReadback:'UNKNOWN',nativeEvidence:'NOT_AVAILABLE'};
}
test('AI-06 AI-03 contract v1: only exact fresh owner dashboard D1 epoch is visible; native STOP remains unknown',()=>{
  const now=1700000000000;
  const f=fixture(device(),async()=>Response.json({}));
  for(const [state,epoch] of [['ACTIVE',7],['REVOKED',8]] as const){
    const d=device({coreRevocation:revocationV1(now,state,epoch)});
    const view=snapshot([d]);
    const read=f.coreRemoteReadback(d,view,now+14999);
    assert.match(read.text,new RegExp(state+' \\(epoch '+epoch+'\\)'));
    assert.match(read.text,/yerel STOP veya drain kanıtı değildir/);
    assert.equal(read.expiresAtMs,now+15000);
    assert.match(f.coreRemoteReadback(d,view,now+15000).text,/UNKNOWN/);
    assert.match(f.coreRemoteReadback(d,view,now-1).text,/UNKNOWN/);
    assert.match(f.coreRemoteReadback(d,snapshot([d,d]),now).text,/UNKNOWN/);
    assert.match(f.coreRemoteReadback(d,snapshot([d],''),now).text,/UNKNOWN/);
    assert.match(f.coreRemoteReadback(d,snapshot([device({coreRevocation:revocationV1(now)})]),now).text,/UNKNOWN/);
  }
  const v1=revocationV1(now);
  for(const candidate of [undefined,null,{...v1,version:2},{...v1,source:'OTHER'},
    {...v1,localStop:'CONFIRMED'},{...v1,pendingRevoke:false},{...v1,nativeDrain:'COMPLETE'},
    {...v1,effectReadback:'VERIFIED'},{...v1,nativeEvidence:'VERIFIED'},
    {...v1,remoteAuthorization:{...v1.remoteAuthorization,authorizationEpoch:0}},
    {...v1,remoteAuthorization:{...v1.remoteAuthorization,authorizationEpoch:1.5}},
    {...v1,remoteAuthorization:{...v1.remoteAuthorization,observedAtMs:null}},
    {...v1,remoteAuthorization:{...v1.remoteAuthorization,state:'UNKNOWN'}},
  ]){
    const d=device({coreRevocation:candidate});
    const read=f.coreRemoteReadback(d,snapshot([d]),now);
    assert.match(read.text,/UNKNOWN/);
    assert.equal(read.expiresAtMs,null);
  }
});

test('AI-06 AI-03 contract v1: expired status clears existing copy, not newer action feedback or account',()=>{
  const d=device({coreRevocation:revocationV1(Date.now()-1000)});
  const f=fixture(d,async()=>Response.json({}));
  const view=snapshot([d]);f.setSnapshot(view);
  const element=new Element();
  f.renderCoreReadbackCopy(element,d,view);
  assert.match(element.textContent,/REVOKED \(epoch 8\)/);
  assert.equal(f.timers.length,1);
  f.timers.shift()!();
  assert.match(element.textContent,/Uzaktan yetki kaydı: UNKNOWN/);
  assert.doesNotMatch(element.textContent,/REVOKED \(epoch/);
  f.renderCoreReadbackCopy(element,d,view);
  element.textContent='New action feedback';
  f.timers.shift()!();
  assert.equal(element.textContent,'New action feedback');
  f.renderCoreReadbackCopy(element,d,view);
  f.setSnapshot(snapshot([device()],'other-owner'));
  const previous=element.textContent;
  f.timers.shift()!();
  assert.equal(element.textContent,previous,'old detached account callback must not update new account');
});

test('AI-06 CAS: stale card and changed preflight revision do not silently upgrade the intent',async()=>{
  const d=device(),f=fixture(d,async()=>Response.json({}));
  f.setServer(snapshot([device({coreMutationRevision:8})]));
  await f.performCoreAction(d.id,'consent',f.row);
  assert.equal(f.posts.length,0);
  f.setSnapshot(snapshot([device({coreMutationRevision:8})]));
  await f.performCoreAction(d.id,'consent',f.row,7);
  assert.equal(f.posts.length,0);
  await f.performCoreAction(d.id,'consent',f.row,8);
  assert.equal(f.posts.length,1);
  assert.equal(JSON.parse(String(f.posts[0]!.init.body)).expectedRevision,8);
});
test('AI-06 CAS: exact DENIED settles conflict without changing preference or asserting native effect',async()=>{
  const d=device(),f=fixture(d,async()=>Response.json({error:'DASHBOARD_MUTATION_REVISION_OR_STATE_CONFLICT'},{status:409}));
  await f.performCoreAction(d.id,'consent',f.row);
  const newer=device({coreMutationRevision:8});
  f.receipt('DENIED',{deviceId:'different-device'});
  await f.reconcileCoreReadback(snapshot([newer]));
  assert.equal(f.shared.records.size,1);
  f.receipt('DENIED',{kind:'core-enable'});
  await f.reconcileCoreReadback(snapshot([newer]));
  assert.equal(f.shared.records.size,1);
  f.receipt('DENIED');
  await f.reconcileCoreReadback(snapshot([newer]));
  assert.equal(f.shared.records.size,0);
  assert.equal(f.posts.length,1,'no automatic retry');
  const element=new Element(),view=snapshot([newer]);
  f.setSnapshot(view);f.renderCoreReadbackCopy(element,newer,view);
  assert.match(element.textContent,/D1 işlem kaydı: DENIED/);
  assert.doesNotMatch(element.textContent,/CORE FİZİKSEL AÇIK|STOP başarılı/);
});
