import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// #23 independent real-web-UI negative. No browser, OS UAC, API or device IO.
const app=readFileSync(new URL('../../web/app.js',import.meta.url),'utf8');
const start=app.indexOf('async function setDeviceCorePreference(');
const end=app.indexOf('\nasync function setDeviceBridgePreference(',start);
assert.ok(start>=0&&end>start,'existing production CORE approval handler exists');
const source=app.slice(start,end).trim();
interface FakeControl {
  value:string; disabled:boolean; textContent:string; focused:boolean;
  focus:()=>void;
}
const control=():FakeControl=>({
  value:'',disabled:false,textContent:'',focused:false,
  focus(){this.focused=true},
});
type CoreApproval=(deviceId:string,enabled:boolean,row:unknown)=>Promise<void>;

test('#780 real CORE card approval is only a preference, never a signed OS HIGH result',async()=>{
  const nodes=new Map([
    ['.core-toggle',control()],
    ['.core-approve',control()],
    ['.core-phrase',control()],
    ['.core-copy',control()],
  ]);
  const row={querySelector:(selector:string)=>nodes.get(selector)};
  let loadCalls=0;
  const calls:Array<{endpoint:string;deviceId:string;body:unknown;confirm:unknown}>=[];
  // Poison any attempt to trust a successful response body as native evidence.
  // Only the Promise-resolution protocol's "then" lookup is benign.
  const untrusted=new Proxy(Object.create(null) as Record<string,unknown>,{
    get(_target,key){if(key==='then')return undefined;
      throw Error('UNTRUSTED_APPROVAL_RESPONSE_READ:'+String(key));
    },
  });
  const post=async(endpoint:string,deviceId:string,body:unknown,confirm:unknown)=>{
    calls.push({endpoint,deviceId,body,confirm});
    return untrusted;
  };
  const load=async()=>{loadCalls++};
  const handler=new Function('postDeviceMode','load',
    'return ('+source+');')(post,load) as CoreApproval;

  nodes.get('.core-phrase')!.value='CORE';
  await handler('device-test',true,row);
  assert.equal(calls.length,0,'incomplete owner phrase must never issue CORE preference');
  assert.equal(loadCalls,0);
  assert.match(nodes.get('.core-copy')!.textContent,/CORE UNLIMITED/);

  nodes.get('.core-phrase')!.value='CORE UNLIMITED';
  await handler('device-test',true,row);
  assert.deepEqual(calls,[{
    endpoint:'/api/v1/me/devices/core-preference',
    deviceId:'device-test',
    body:{enabled:true,confirmation:'CORE UNLIMITED'},
    confirm:'core-preference-v1',
  }]);
  assert.equal(loadCalls,1,'separate independent dashboard readback is mandatory');
  assert.equal(nodes.get('.core-copy')!.textContent,'CORE kaydediliyor…');
  assert.doesNotMatch(nodes.get('.core-copy')!.textContent,
    /CORE YÖNETİCİ ETKİN|HIGH|UAC onaylandı|OS elevated/i);
  assert.equal(nodes.get('.core-toggle')!.disabled,true);
  assert.equal(nodes.get('.core-approve')!.disabled,true);
  assert.doesNotMatch(source,/Start-Process|consent\.exe|RunAs|window\.confirm/);
});

test('#787 stale owner epoch / early all-green snapshot must never render CORE effective or persistent tier',()=>{
  // Execute exactly the existing production dashboard tier/render code,
  // not a recreated security predicate or an imaginary #780 diff card.
  const tierStart=app.indexOf('function getDeviceTier(device) {');
  const tierEnd=app.indexOf('\nfunction syncDeviceToolbar(',tierStart);
  const coreStart=app.indexOf('const core = device.persistentMaintenance ??');
  const coreEndMarker='corePanel.hidden = true;';
  const coreEnd=app.indexOf(coreEndMarker,coreStart);
  assert.ok(tierStart>=0&&tierEnd>tierStart&&coreStart>=0&&coreEnd>coreStart,
    'live web tier and CORE card source must be present');
  const tier=new Function('return ('+app.slice(tierStart,tierEnd).trim()+');')()
    as (device:unknown)=>string;
  type View={
    effective:boolean;label:string;pressed:string|undefined;
    active:boolean;feedback:string;
  };
  const renderCore=new Function('device','row',
    app.slice(coreStart,coreEnd+coreEndMarker.length)+
    '\nreturn {effective:coreEffective,label:coreShortcut.textContent,'+
    'pressed:coreShortcut.getAttribute("aria-pressed"),'+
    'active:coreShortcut.classList.contains("active"),'+
    'feedback:coreText.textContent};') as
    (device:unknown,row:unknown)=>View;
  const controls=new Map<string,{
    textContent:string;hidden:boolean;attributes:Map<string,string>;
    classes:Set<string>;
    classList:{toggle:(name:string,active:boolean)=>void;contains:(name:string)=>boolean};
    setAttribute:(name:string,value:string)=>void;
    getAttribute:(name:string)=>string|undefined;
  }>();
  for(const key of ['.core-confirm-panel','.core-toggle','.core-copy',
    '.core-shortcut','.core-access']){
    const classes=new Set<string>(),attributes=new Map<string,string>();
    controls.set(key,{
      textContent:'',hidden:false,attributes,classes,
      classList:{
        toggle(name,active){if(active)classes.add(name);else classes.delete(name)},
        contains(name){return classes.has(name)},
      },
      setAttribute(name,value){attributes.set(name,value)},
      getAttribute(name){return attributes.get(name)},
    });
  }
  const row={querySelector:(key:string)=>controls.get(key)};
  // Deliberately inconsistent, forged successful snapshot: all old status
  // booleans green, yet a newer owner epoch revoked it just one ms later;
  // there is no installed final HIGH/native+CAS effect receipt.
  const hostile={
    platform:'win32',accessMode:'full',online:true,
    currentOwnerEpoch:5,currentGrantGeneration:9,
    persistentMaintenance:{
      enabled:true,active:true,effective:true,
      authoritySource:'independent-protected-windows-broker',
      localEnrollmentVerified:true,actualElevatedTokenVerified:true,
      brokerSourceAclVerified:true,brokerVersionVerified:true,
      ownerEpoch:4,grantGeneration:8,
      finalNativeEffectVerified:false,externalCasAtomicCommitVerified:false,
    },
  };
  const view=renderCore(hostile,row);
  // Separate 1-ms old "active" snapshot must not pollute CORE filter.
  const tierValue=tier({...hostile,persistentMaintenance:{
    ...hostile.persistentMaintenance,effective:false,
  }});
  assert.deepEqual({
    badge:view.label,
    pressed:view.pressed,
    highlighted:view.active,
    denied:!view.effective,
    tier:tierValue,
  },{
    badge:'CORE KAYITLI • YETKİ BEKLEMEDE',
    pressed:'false',
    highlighted:false,
    denied:true,
    tier:'full',
  },'local card/tier must fail closed without current epoch and physical HIGH/native CAS proof');
});
