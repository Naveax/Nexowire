import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const app=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const start=app.indexOf('async function applyDeviceBridgeMode(');
const end=app.indexOf('\nasync function updateAutoSelection(',start);
assert.ok(start>=0&&end>start,'Admin Bridge apply flow is present');

interface FakeElement {
  value:string;disabled:boolean;hidden:boolean;textContent:string;
  focus:()=>void;
}
function element():FakeElement {
  return {value:'',disabled:false,hidden:true,textContent:'',focus:()=>undefined};
}

function harness(options:{
  phrase?:string;status?:'queued'|'claimed'|'applied'|'failed'|'expired';
  onPost?:()=>Promise<unknown>;
  statusRequestId?:string;
}={}){
  const nodes=new Map<string,FakeElement>();
  const selectors=[
    '.bridge-apply-panel','.bridge-apply-phrase',
    '.bridge-apply-toggle','.bridge-apply-approve','.bridge-command-status',
  ];
  for(const selector of selectors)nodes.set(selector,element());
  nodes.get('.bridge-apply-phrase')!.value=options.phrase??'APPLY BRIDGE MODE';
  const calls:Array<{endpoint:string;deviceId:string;body:unknown;token:string}>=[];
  const statusFetches:string[]=[];
  let reloads=0;
  const ids=new Set<string>();
  const requestId='00000000-0000-4000-a000-000000000001';
  const post=async(endpoint:string,deviceId:string,body:unknown,token:string)=>{
    calls.push({endpoint,deviceId,body,token});
    if(options.onPost)return await options.onPost();
    return {status:'queued',requestId,expiresAt:new Date(Date.now()+60_000).toISOString()};
  };
  const fakeFetch=async(url:string)=>{
    statusFetches.push(url);
    return {ok:true,json:async()=>({
      requestId:options.statusRequestId??requestId,
      deviceId:'device-a',status:options.status??'applied',
      failureCode:options.status==='failed'?'DEVICE_REJECTED':null,
    })};
  };
  const apply=new Function(
    'postDeviceMode','fetch','explainApiError','bridgeCommandsInFlight',
    'load','setTimeout',
    'return ('+app.slice(start,end).trim()+');',
  )(
    post,fakeFetch,(code:string)=>code,ids,async()=>{reloads++;},
    (cb:()=>void)=>{cb();return 0;},
  ) as (id:string,mode:string,row:unknown)=>Promise<void>;
  const row={querySelector:(selector:string)=>nodes.get(selector)};
  return {apply,row,nodes,calls,statusFetches,reloads:()=>reloads,ids};
}

test('real Admin Bridge apply requires typed owner phrase; preference alone never issues command',async()=>{
  const h=harness({phrase:'AUTO'});
  await h.apply('device-a','on',h.row);
  assert.equal(h.calls.length,0);
  assert.match(h.nodes.get('.bridge-command-status')!.textContent,/APPLY BRIDGE MODE/);
});

test('an explicit owner click queues, polls matching signed outcome and refreshes',async()=>{
  const h=harness();
  await h.apply('device-a','on',h.row);
  assert.deepEqual(h.calls,[{
    endpoint:'/api/v1/me/devices/bridge-command',
    deviceId:'device-a',
    body:{mode:'on',confirmation:'APPLY BRIDGE MODE'},
    token:'bridge-command-issue-v1',
  }]);
  assert.equal(h.statusFetches.length,1);
  assert.match(h.statusFetches[0]!,/\/api\/v1\/me\/devices\/bridge-command\/status\?requestId=/);
  assert.equal(h.reloads(),1);
  assert.equal(h.ids.size,0);
});

test('disabled transport is accurately reported, not a successful device state',async()=>{
  const h=harness({onPost:async()=>{throw new Error('BRIDGE_COMMAND_TRANSPORT_DISABLED');}});
  await h.apply('device-a','off',h.row);
  assert.equal(h.calls.length,1);
  assert.match(h.nodes.get('.bridge-command-status')!.textContent,/BRIDGE_COMMAND_TRANSPORT_DISABLED/);
  assert.equal(h.reloads(),0);
  assert.equal(h.nodes.get('.bridge-apply-approve')!.disabled,false);
});

test('wrong paired request identity is never accepted as Broker applied',async()=>{
  const h=harness({statusRequestId:'invalid'});
  await h.apply('device-a','auto',h.row);
  assert.equal(h.reloads(),0);
  assert.match(h.nodes.get('.bridge-command-status')!.textContent,/eşleşmiyor/);
});

test('signed failure is shown without treating Broker mode as applied',async()=>{
  const h=harness({status:'failed'});
  await h.apply('device-a','off',h.row);
  assert.equal(h.reloads(),0);
  assert.match(h.nodes.get('.bridge-command-status')!.textContent,/DEVICE_REJECTED/);
});

test('UI has a separate, initially hidden apply panel and does not autostart on preference',()=>{
  assert.match(app,/class="bridge-apply-panel" hidden/);
  assert.match(app,/class="bridge-apply-phrase"/);
  assert.match(app,/bridgeEligible=device\.online===true/);
  const preferenceStart=app.indexOf('async function setDeviceBridgePreference(');
  const preferenceEnd=app.indexOf('async function applyDeviceBridgeMode(',preferenceStart);
  assert.ok(preferenceStart>=0&&preferenceEnd>preferenceStart);
  const preference=app.slice(preferenceStart,preferenceEnd);
  assert.doesNotMatch(preference,/bridge-command/);
});
