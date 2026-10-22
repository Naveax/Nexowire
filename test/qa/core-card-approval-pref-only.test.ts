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
