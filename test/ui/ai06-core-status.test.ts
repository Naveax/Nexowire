import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createContext,runInContext} from 'node:vm';

const connectJs=readFileSync('web/connect.js','utf8');
const connectHtml=readFileSync('web/connect.html','utf8');
const css=readFileSync('web/styles.css','utf8');
const deviceId='ai06-read-only-device';
const search='?'+new URLSearchParams({
  callback:'http://127.0.0.1:49321/nexowire-connect',
  state:'s'.repeat(43),deviceId,deviceName:'Owner PC',platform:'win32',
}).toString();

class FakeElement {
  value='';textContent='';href='';disabled=false;tabIndex=0;focused=false;
  dataset:Record<string,string>={};
  attributes:Record<string,string>={};
  classes=new Set<string>();
  className='';
  row:FakeElement|null=null;
  handlers:Record<string,(event?:{key?:string;preventDefault?:()=>void})=>unknown>={};
  classList={
    add:(v:string)=>this.classes.add(v),
    remove:(v:string)=>this.classes.delete(v),
    toggle:(v:string,force?:boolean)=>force===undefined
      ? (this.classes.has(v)?this.classes.delete(v):this.classes.add(v))
      : (force?this.classes.add(v):this.classes.delete(v)),
  };
  setAttribute(name:string,value:string){this.attributes[name]=value}
  removeAttribute(name:string){delete this.attributes[name]}
  addEventListener(type:string,handler:(event?:{key?:string})=>unknown){this.handlers[type]=handler}
  focus(){this.focused=true}
  select(){}
  closest(){return this.row??this}
}

function pairingBrowser(){
  const records=new Map<string,string>();
  const locks=new Set<string>();
  return {records,localStorage:{getItem:(key:string)=>records.get(key)??null,setItem:(key:string,value:string)=>records.set(key,value)},
    locks:{request:async(key:string,_options:unknown,callback:(lock:object|null)=>unknown)=>{
      if(locks.has(key))return callback(null);locks.add(key);
      try{return await callback({})}finally{locks.delete(key)}
    }}};
}

async function render(dashboard:unknown,options:{
  pairingStatus?:number; throwPairing?:boolean;
  pairingResponse?:()=>Promise<Response>;
  dashboardResponse?:()=>Promise<Response>;
  browser?:ReturnType<typeof pairingBrowser>;
  localState?:string;
}={}) {
  const ids=new Map<string,FakeElement>();
  const get=(id:string)=>{if(!ids.has(id))ids.set(id,new FakeElement());return ids.get(id)!};
  const tabs=['windows','macos','linux'].map(os=>{const el=new FakeElement();el.dataset.os=os;return el});
  get('install-command').row=new FakeElement();
  let postCount=0;
  const mutationIds:string[]=[];
  const browser=options.browser??pairingBrowser();
  const localSearch=new URLSearchParams(search);
  if(options.localState!==undefined)localSearch.set('state',options.localState);
  const ctx=createContext({
    URL,URLSearchParams,AbortSignal,Date,Response,TextEncoder,
    crypto:{subtle:{digest:async(_algorithm:string,input:Uint8Array)=>createHash('sha256').update(input).digest()}},
    localStorage:browser.localStorage,
    navigator:{userAgent:'Windows',locks:browser.locks,clipboard:{writeText:async()=>{}}},
    document:{
      getElementById:get,
      querySelectorAll:()=>tabs,
      querySelector:()=>new FakeElement(),
    },
    window:{location:{search:'?'+localSearch.toString(),pathname:'/connect.html',origin:'https://owner.fixture.invalid',
      replace:()=>{throw Error('fixture navigation blocked')}}},
    fetch:async(path:string,init?:RequestInit)=>{
      if(path==='/api/v1/me/dashboard')return options.dashboardResponse?.()??Response.json(dashboard);
      if(path==='/api/v1/pairing'){
        postCount++;
        mutationIds.push(new Headers(init?.headers).get('X-Nexowire-Mutation-Id')??'');
        if(options.pairingResponse)return options.pairingResponse();
        if(options.throwPairing)throw Error('ACK lost after POST');
        return Response.json({error:'UPSTREAM_UNKNOWN'},{status:options.pairingStatus??503});
      }
      throw Error('unexpected request '+path);
    },
  });
  runInContext(connectJs,ctx,{timeout:2000});
  await new Promise<void>(resolve=>setImmediate(resolve));
  await new Promise<void>(resolve=>setImmediate(resolve));
  return {get,postCount:()=>postCount,mutationIds,browser};
}

function dashboard(physical:unknown,override:Record<string,unknown>={}){
  return {corePhysicalStatusVerifierInstalled:true,devices:[{
    id:deviceId,platform:'win32',online:true,accessMode:'full',
    privilegeMode:'broker',adminBridgeReady:true,
    persistentMaintenance:{enabled:true},
    physicalConsole:physical,...override,
  }]};
}

test('AI-06: status defaults to UNKNOWN without an exact owner-device source',async()=>{
  for(const snapshot of [{},{devices:[]},{devices:[{id:'other',physicalConsole:{active:true}}]}]){
    const f=await render(snapshot);
    assert.equal(f.get('core-status-code').textContent,'UNKNOWN');
    assert.match(f.get('core-status-tr').textContent,/doğrulanamadı/);
    assert.equal(f.get('approve').disabled,false,'pairing remains separate from CORE');
  }
});

test('AI-06: explicit authority states are rendered without claiming verified execution',async()=>{
  const scenarios:[unknown,Record<string,unknown>,string][]=[
    [{active:false},{installationStatus:'NOT_INSTALLED'},'NOT_INSTALLED'],
    [{permissionRequired:true},{},'PERMISSION_REQUIRED'],
    [{enrollmentRequested:true,localEnrolled:false},{},'AWAITING_PHYSICAL_ACCEPTANCE'],
    [{state:'REVOKED_LOCALLY'},{},'REVOKED_LOCALLY'],
    [{active:false,localEnrolled:false},{},'BROKER_RUNNING_BUT_UNVERIFIED'],
  ];
  for(const [physical,override,expected] of scenarios){
    const f=await render(dashboard(physical,override));
    assert.equal(f.get('core-status-code').textContent,expected);
    assert.ok(f.get('core-status-en').textContent.length>25);
  }
});


test('AI-06: offline Broker configuration and duplicate device IDs stay UNKNOWN',async()=>{
  for(const override of [{online:false},{online:null},{online:undefined}]){
    const f=await render(dashboard({active:false},override));
    assert.equal(f.get('core-status-code').textContent,'UNKNOWN');
    assert.match(f.get('core-status-tr').textContent,/doğrulanamadı/);
    assert.equal(f.get('approve').disabled,false,'CORE status must not block account pairing');
  }
  const snapshot=dashboard({state:'REVOKED_LOCALLY'});
  const duplicate={...snapshot,devices:[
    ...snapshot.devices,
    {...snapshot.devices[0],physicalConsole:{state:'PERMISSION_REQUIRED'}},
  ]};
  const f=await render(duplicate);
  assert.equal(f.get('core-status-code').textContent,'UNKNOWN');
  const revoked=await render(dashboard({state:'REVOKED_LOCALLY'},{online:false}));
  assert.equal(revoked.get('core-status-code').textContent,'REVOKED_LOCALLY',
    'an explicitly recorded local revocation survives an offline device');
});

test('AI-06: enrollment recorded is not proof that the PC received a prompt',async()=>{
  const f=await render(dashboard({enrollmentRequested:true,localEnrolled:false},{online:false}));
  assert.equal(f.get('core-status-code').textContent,'AWAITING_PHYSICAL_ACCEPTANCE');
  assert.match(f.get('core-status-tr').textContent,/cihaza ulaştığı/);
  assert.match(f.get('core-status-en').textContent,/delivery to the PC/);
});

test('AI-06: forged / stale active dashboard cannot promote READY_VERIFIED',async()=>{
  const physical={localEnrolled:true,active:true,deviceReady:true,
    observedAtMs:Date.now()};
  const f=await render(dashboard(physical));
  assert.equal(f.get('core-status-code').textContent,'BROKER_RUNNING_BUT_UNVERIFIED');
  assert.notEqual(f.get('core-status-code').className,'pill good');
});


test('AI-06: pending pairing is single-flight even with repeated click events',async()=>{
  let release!:(response:Response)=>void;
  const pending=new Promise<Response>(resolve=>{release=resolve});
  const f=await render(dashboard({active:false}),{pairingResponse:()=>pending});
  const first=f.get('approve').handlers.click!();
  await f.get('approve').handlers.click!();
  assert.equal(f.postCount(),1,'one request while the first POST is unresolved');
  assert.equal(f.get('approve').disabled,true);
  release(Response.json({error:'fixture upstream unavailable'},{status:503}));
  await first;
  assert.equal(f.postCount(),1);
});

test('AI-06: HTTP 503, ACK-loss and request timeout cannot replay pairing POST',async()=>{
  const timeout=async():Promise<Response>=>{const error=new Error('fixture timeout');error.name='TimeoutError';throw error};
  for(const options of [{pairingStatus:503},{throwPairing:true},{pairingResponse:timeout}]){
    const f=await render(dashboard({active:false}),options);
    await f.get('approve').handlers.click!();
    assert.equal(f.postCount(),1);
    assert.equal(f.get('approve').disabled,true);
    assert.match(f.get('error-message').textContent,/kontrol et/);
    await f.get('approve').handlers.click!();
    assert.equal(f.postCount(),1,'uncertain operation was not replayed');
    assert.equal(f.get('connect-pill').textContent,'Hata');
  }
});


test('AI-06: dashboard timeout keeps pairing disabled and reports a safe, actionable error',async()=>{
  const timeout=async():Promise<Response>=>{const error=new Error('private upstream timeout token=fixture');error.name='TimeoutError';throw error};
  const f=await render({}, {dashboardResponse:timeout});
  assert.equal(f.get('approve').disabled,true);
  assert.equal(f.get('core-status-code').textContent,'UNKNOWN');
  assert.match(f.get('error-message').textContent,/Hesap doğrulanamadı/);
  assert.doesNotMatch(f.get('error-message').textContent,/private|token=fixture/);
  assert.equal(f.postCount(),0);
});

test('AI-06: bilingual CORE panel and zoom/keyboard/forced-color contracts',()=>{
  assert.match(connectHtml,/id="core-state-panel"/);
  assert.match(connectHtml,/id="core-status-code"[^>]*aria-describedby="core-status-tr core-status-en"/);
  assert.doesNotMatch(connectHtml,/id="core-status-code"[^>]*aria-live=/);
  assert.match(connectHtml,/class="core-state-description" role="status" aria-live="polite"/);
  assert.match(connectHtml,/id="core-status-tr" lang="tr"/);
  assert.match(connectHtml,/id="core-status-en" lang="en"/);
  assert.match(connectHtml,/Windows\/UAC onayı/);
  assert.match(connectJs,/CORE_INDEPENDENT_VERIFIER_INSTALLED = false/);
  assert.match(connectJs,/pairingOutcomeUncertain/);
  assert.match(connectJs,/signal: AbortSignal.timeout\(8000\)/);
  assert.match(connectJs,/signal: AbortSignal.timeout\(15000\)/);
  assert.match(connectJs,/ArrowRight.*ArrowLeft/);
  for(const breakpoint of [768,375,320])
    assert.ok(css.includes('max-width:'+breakpoint+'px'),'missing '+breakpoint+'px layout');
  assert.match(css,/prefers-reduced-motion:reduce/);
  assert.match(css,/forced-colors:active/);
});

test('AI-06 pairing: shared native session cannot POST in another tab or after reload',async()=>{
  const browser=pairingBrowser();
  const d=dashboard({active:false});
  const a=await render(d,{browser});
  const b=await render(d,{browser});
  await a.get('approve').handlers.click!();
  await b.get('approve').handlers.click!();
  assert.equal(a.postCount(),1);
  assert.equal(b.postCount(),0);
  const reload=await render(d,{browser});
  assert.equal(reload.get('approve').disabled,true);
  assert.equal(reload.postCount(),0);
  assert.equal(browser.records.size,1);
  const [key,value]=[...browser.records.entries()][0]!;
  assert.match(key,/pairing-v1:[0-9a-f]{64}$/);
  assert.equal(value,'attempted');
  assert.ok(!key.includes('s'.repeat(43)));
  const otherProfile=await render(d);
  await otherProfile.get('approve').handlers.click!();
  assert.equal(otherProfile.postCount(),1,'different profiles require backend deduplication');
  assert.deepEqual(otherProfile.mutationIds,a.mutationIds,'same local state derives identical opaque ID across profiles');
  const fresh=await render(d,{browser,localState:'n'.repeat(43)});
  await fresh.get('approve').handlers.click!();
  assert.equal(fresh.postCount(),1);
  assert.notEqual(fresh.mutationIds[0],a.mutationIds[0]);
});

test('AI-06 pairing: unavailable durable storage prevents POST',async()=>{
  const browser=pairingBrowser();
  browser.localStorage.setItem=()=>{throw Error('storage unavailable')};
  const f=await render(dashboard({active:false}),{browser});
  await f.get('approve').handlers.click!();
  assert.equal(f.postCount(),0);
  assert.equal(f.get('approve').disabled,true);
});
