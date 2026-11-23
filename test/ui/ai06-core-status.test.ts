import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
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

async function render(dashboard:unknown,options:{
  pairingStatus?:number; throwPairing?:boolean;
  pairingResponse?:()=>Promise<Response>;
}={}) {
  const ids=new Map<string,FakeElement>();
  const get=(id:string)=>{if(!ids.has(id))ids.set(id,new FakeElement());return ids.get(id)!};
  const tabs=['windows','macos','linux'].map(os=>{const el=new FakeElement();el.dataset.os=os;return el});
  get('install-command').row=new FakeElement();
  let postCount=0;
  const ctx=createContext({
    URL,URLSearchParams,AbortSignal,Date,Response,
    navigator:{userAgent:'Windows',clipboard:{writeText:async()=>{}}},
    document:{
      getElementById:get,
      querySelectorAll:()=>tabs,
      querySelector:()=>new FakeElement(),
    },
    window:{location:{search,pathname:'/connect.html',origin:'https://owner.fixture.invalid',
      replace:()=>{throw Error('fixture navigation blocked')}}},
    fetch:async(path:string)=>{
      if(path==='/api/v1/me/dashboard')return Response.json(dashboard);
      if(path==='/api/v1/pairing'){
        postCount++;
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
  return {get,postCount:()=>postCount};
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

test('AI-06: HTTP 503 and ACK-loss cannot trigger a second pairing POST',async()=>{
  for(const options of [{pairingStatus:503},{throwPairing:true}]){
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

test('AI-06: bilingual CORE panel and zoom/keyboard/forced-color contracts',()=>{
  assert.match(connectHtml,/id="core-state-panel"/);
  assert.match(connectHtml,/id="core-status-code"[^>]*aria-live="polite"/);
  assert.match(connectHtml,/id="core-status-tr" lang="tr"/);
  assert.match(connectHtml,/id="core-status-en" lang="en"/);
  assert.match(connectHtml,/Windows\/UAC onayı/);
  assert.match(connectJs,/CORE_INDEPENDENT_VERIFIER_INSTALLED = false/);
  assert.match(connectJs,/pairingOutcomeUncertain/);
  assert.match(connectJs,/ArrowRight.*ArrowLeft/);
  for(const breakpoint of [768,375,320])
    assert.ok(css.includes('max-width:'+breakpoint+'px'),'missing '+breakpoint+'px layout');
  assert.match(css,/prefers-reduced-motion:reduce/);
  assert.match(css,/forced-colors:active/);
});
