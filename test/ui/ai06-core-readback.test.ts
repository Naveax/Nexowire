import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

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
function fixture(initial:Device,handler:()=>Promise<Response>){
  const nodes=new Map<string,Element>();
  const row={querySelector:(selector:string)=>{
    if(!nodes.has(selector))nodes.set(selector,new Element());
    return nodes.get(selector)!;
  }};
  const posts:{path:string;init:RequestInit}[]=[];
  let reads=0;
  const ctx=runInNewContext('const coreOperations=new Map();let currentSnapshot=null;\n'+
    source.slice(start,end)+'\n({setSnapshot:value=>currentSnapshot=value,coreOperations,coreEnrollmentEligible,coreReadbackMessage,reconcileCoreReadback,coreOperationAllows,performCoreAction})',{
      AbortSignal,
      fetch:async(path:string,init:RequestInit)=>{posts.push({path,init});return handler()},
      load:async()=>{reads++},
    }) as {
      setSnapshot(value:ReturnType<typeof snapshot>):void;
      coreOperations:Map<string,{inFlight:boolean;acknowledged:boolean;kind:string}>;
      coreEnrollmentEligible(value:Device):boolean;
      coreReadbackMessage(value:Device,operation?:unknown):string;
      reconcileCoreReadback(value:ReturnType<typeof snapshot>):void;
      coreOperationAllows(id:string,kind:string):boolean;
      performCoreAction(id:string,kind:string,row:unknown):Promise<void>;
    };
  ctx.setSnapshot(snapshot([initial]));
  return {...ctx,row,posts,reads:()=>reads};
}

test('AI-06 readback: consent is eligible only for explicit current backend readiness and no pending/confirmed enrollment',()=>{
  const d=device();
  const f=fixture(d,async()=>Response.json({}));
  assert.equal(f.coreEnrollmentEligible(d),true);
  for(const candidate of [
    device({online:false}),device({platform:'linux'}),device({accessMode:'safe'}),
    device({privilegeMode:'direct'}),device({adminBridgeReady:false}),
    device({bridgePreference:{desiredMode:'off'}}),
    device({persistentMaintenance:{enabled:false}}),device({physicalConsole:undefined}),
    device({physicalConsole:{deviceReady:true,localEnrolled:false}}),
    device({physicalConsole:{deviceReady:false,localEnrolled:false,enrollmentRequested:false}}),
    device({physicalConsole:{deviceReady:true,localEnrolled:false,enrollmentRequested:true}}),
    device({physicalConsole:{deviceReady:true,localEnrolled:true,enrollmentRequested:false}}),
  ])assert.equal(f.coreEnrollmentEligible(candidate),false,JSON.stringify(candidate));
});

test('AI-06 readback: same-device in-flight guard and stale/foreign readback cannot replay consent',async()=>{
  const d=device();
  let release!:(r:Response)=>void;
  const pending=new Promise<Response>(resolve=>{release=resolve});
  const f=fixture(d,()=>pending);
  const first=f.performCoreAction(d.id,'consent',f.row);
  // Same device, new row or old row: the fence is independent of DOM lifetime.
  f.setSnapshot(snapshot([d]));
  await f.performCoreAction(d.id,'consent',f.row);
  await f.performCoreAction(d.id,'disable',f.row);
  assert.equal(f.posts.length,1);
  assert.equal(f.posts[0]?.path,'/api/v1/me/devices/core-enrollment-request');
  assert.deepEqual(JSON.parse(String(f.posts[0]?.init.body)),{deviceId:d.id});
  const requested=device({physicalConsole:{deviceReady:true,localEnrolled:false,enrollmentRequested:true}});
  f.reconcileCoreReadback(snapshot([requested]));
  assert.equal(f.coreOperations.get(d.id)?.inFlight,true);
  release(Response.json({error:'PRIVATE_SENTINEL'},{status:503}));await first;
  assert.equal(f.reads(),1);
  f.reconcileCoreReadback(snapshot([d]));
  f.reconcileCoreReadback(snapshot([requested],'different-owner'));
  f.reconcileCoreReadback(snapshot([requested,requested]));
  assert.equal(f.coreOperationAllows(d.id,'consent'),false);
  await f.performCoreAction(d.id,'consent',f.row);
  assert.equal(f.posts.length,1);
  f.reconcileCoreReadback(snapshot([requested]));f.setSnapshot(snapshot([requested]));
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
  f.reconcileCoreReadback(snapshot([d]));
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
  f.reconcileCoreReadback(snapshot([enabled]));f.setSnapshot(snapshot([enabled]));
  assert.equal(f.coreOperationAllows(d.id,'consent'),false);
  assert.equal(f.coreOperationAllows(d.id,'disable'),true);
  await f.performCoreAction(d.id,'disable',f.row);
  assert.equal(f.posts.length,2);
  assert.deepEqual(JSON.parse(String(f.posts[1]?.init.body)),{deviceId:d.id,enabled:false});
  f.reconcileCoreReadback(snapshot([enabled]));
  assert.equal(f.coreOperationAllows(d.id,'disable'),false);
  assert.equal(f.coreOperationAllows(d.id,'enable'),false);
  f.reconcileCoreReadback(snapshot([d]));
  assert.equal(f.coreOperations.has(d.id),false);
  const off=f.coreReadbackMessage(d);
  assert.match(off,/hesap tercihi kapalı/);
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
    f.reconcileCoreReadback(snapshot([device()]));
    assert.equal(f.coreOperationAllows(d.id,'consent'),false);
  }
  const f=fixture(d,async()=>Response.json({}));
  f.setSnapshot(snapshot([d,d]));
  await f.performCoreAction(d.id,'enable',f.row);
  assert.equal(f.posts.length,0);
});
