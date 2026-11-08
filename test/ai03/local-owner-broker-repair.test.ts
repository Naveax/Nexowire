import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalOwnerBrokerAdmission, requestedBrokerEffectMode } from '../../src/agent/privileged-broker-local-owner.js';
import { classifyPrivilegedBrokerTaskResult, buildPrivilegedBrokerLauncher } from '../../src/agent/privileged-broker-lifecycle.js';
import { assertCoreWindowsMutationAdmission } from '../../src/agent/core-windows-mutation-dispatch.js';
import { startPrivilegedBroker } from '../../src/agent/privileged-broker.js';

const id1='4bf8808a-5b3d-46eb-8694-45bd2d44acb0';
const id2='19d1368f-a44a-449c-84d5-7bd17b63dbcc';
const capability='windows.environment.set';
const input={scope:'machine',name:'NEXOWIRE_AI03_FIXTURE_ONLY',value:'1'};

test('P0 task result is only POSSIBLE IgnoreNew with confirmed running singleton settings',()=>{
  assert.equal(classifyPrivilegedBrokerTaskResult({state:'Running',lastTaskResult:0x800710e0},'IgnoreNew'),'POSSIBLE_IGNORE_NEW');
  for(const [state,setting] of [['Ready','IgnoreNew'],['Running','Unverified'],['Running','Other']] as const)
    assert.equal(classifyPrivilegedBrokerTaskResult({state,lastTaskResult:0x800710e0},setting),'TASK_FAILURE_OR_UNVERIFIED');
  assert.equal(classifyPrivilegedBrokerTaskResult({state:'Running',lastTaskResult:0},'IgnoreNew'),'SUCCESS');
  assert.equal(classifyPrivilegedBrokerTaskResult({state:'Running',lastTaskResult:null},'IgnoreNew'),'NO_LAST_RESULT');
});

test('P0 local Broker mode is explicit and persists no plaintext credential in launcher',()=>{
  assert.equal(requestedBrokerEffectMode({}),'external');
  assert.equal(requestedBrokerEffectMode({NEXOWIRE_PRIVILEGED_BROKER_EFFECT_MODE:'local-owner'}),'local-owner');
  assert.throws(()=>requestedBrokerEffectMode({NEXOWIRE_PRIVILEGED_BROKER_EFFECT_MODE:'disabled-checks'}),/BROKER_EFFECT_MODE_INVALID/);
  const launcher=buildPrivilegedBrokerLauncher({
    cliEntrypoint:'C:\\Program Files\\Nexowire\\app\\dist\\src\\cli.js',
    execPath:'C:\\Program Files\\Nexowire\\runtime\\node.exe',
    execArgv:[],
    env:{NEXOWIRE_PRIVILEGED_BROKER_EFFECT_MODE:'local-owner',
      NEXOWIRE_CORE_AUTHORITY_URL:'https://core.example.test',
      NEXOWIRE_AGENT_TOKEN_DPAPI_FILE:'C:\\ProgramData\\Nexowire\\agent.dpapi',
      NEXOWIRE_AGENT_TOKEN:'fixture-plaintext-secret-never-persisted'},
  });
  assert.match(launcher,/NEXOWIRE_PRIVILEGED_BROKER_EFFECT_MODE='local-owner'/);
  assert.match(launcher,/NEXOWIRE_AGENT_TOKEN_DPAPI_FILE/);
  assert.doesNotMatch(launcher,/fixture-plaintext-secret-never-persisted/);
  assert.doesNotMatch(launcher,/\$env:NEXOWIRE_AGENT_TOKEN='/);
  const legacy=buildPrivilegedBrokerLauncher({
    cliEntrypoint:'C:\\Program Files\\Nexowire\\app\\dist\\src\\cli.js',
    execPath:'C:\\Program Files\\Nexowire\\runtime\\node.exe',
    execArgv:[],
    env:{},
  });
  assert.doesNotMatch(legacy,/NEXOWIRE_PRIVILEGED_BROKER_EFFECT_MODE/);
});

test('P0 local owner admission reserves once, checks fresh state twice and denies stale owner',async()=>{
  const reserved=new Set<string>();
  const events:string[]=[];
  let active=true;
  const gate=createLocalOwnerBrokerAdmission({
    readStatus:async()=>{events.push('read');return {
      active, localEnrolled:active,state:active?'ACTIVE_LOCAL_OWNER':'REVOKED_LOCALLY'};},
    reserve:async(id)=>{events.push('reserve');if(reserved.has(id))throw Error('EEXIST');reserved.add(id);},
  });
  await gate.authorizeOnce(id1);
  assert.deepEqual(events,['read','reserve','read']);
  await assert.rejects(gate.authorizeOnce(id1),/BROKER_LOCAL_OWNER_OPERATION_ALREADY_RECORDED/);
  active=false;
  await assert.rejects(gate.authorizeOnce(id2),/BROKER_LOCAL_OWNER_NOT_ACTIVE/);
  assert.equal(reserved.has(id2),false);
  await assert.rejects(gate.authorizeOnce('..\\..\\abusive'),/BROKER_LOCAL_OWNER_REQUEST_ID_REQUIRED/);
  gate.close();
  active=true;
  await assert.rejects(gate.authorizeOnce(id2),/BROKER_LOCAL_OWNER_REQUEST_ID_REQUIRED/);
});

test('P0 unknown result after reservation is never retried with the same UUID',async()=>{
  let readCount=0;
  const reserved=new Set<string>();
  const gate=createLocalOwnerBrokerAdmission({
    readStatus:async()=>({active:++readCount===1,localEnrolled:true,state:'ACTIVE_LOCAL_OWNER'}),
    reserve:async(id)=>{if(reserved.has(id))throw Error('EEXIST');reserved.add(id);},
  });
  await assert.rejects(gate.authorizeOnce(id1),/BROKER_LOCAL_OWNER_NOT_ACTIVE/);
  assert.equal(reserved.has(id1),true);
  await assert.rejects(gate.authorizeOnce(id1));
});

test('P0 default executor cannot be reached without a local Broker context',()=>{
  assert.throws(()=>assertCoreWindowsMutationAdmission(capability,input),/CORE_DISPATCH_EXTERNAL_ADMISSION_REQUIRED/);
});

test('P0 Windows loopback Broker executes exactly once with local owner admission', {
  skip:process.platform!=='win32',
},async()=>{
  let ran=0,active=true;
  const reserved=new Set<string>();
  const admission=createLocalOwnerBrokerAdmission({
    readStatus:async()=>({active,localEnrolled:active,state:active?'ACTIVE_LOCAL_OWNER':'REVOKED_LOCALLY'}),
    reserve:async(id)=>{if(reserved.has(id))throw Error('EEXIST');reserved.add(id);},
  });
  const token='ai03-windows-fixture-broker-bearer-token';
  const handle=await startPrivilegedBroker({
    tokens:[token],port:0,requireElevation:false,localOwnerAdmission:admission,
    execute:async(cap,raw)=>{
      assert.equal(cap,capability);
      assertCoreWindowsMutationAdmission(cap,raw);
      ran++;return {ran};
    },
  });
  const send=async(operationId:string,auth=token)=>{
    const response=await fetch(handle.url+'/execute',{
      method:'POST',headers:{authorization:'Bearer '+auth,'content-type':'application/json'},
      body:JSON.stringify({capability,input,operation_id:operationId}),
    });
    return {http:response.status,body:await response.json() as {ok:boolean;data?:{ran:number}}};
  };
  try{
    const bad=await send(id1,'wrong-token');assert.equal(bad.http,401);assert.equal(ran,0);
    const first=await send(id1);assert.equal(first.http,200);assert.equal(first.body.data?.ran,1);
    const replay=await send(id1);assert.equal(replay.http,400);assert.equal(ran,1);
    active=false;
    const revoked=await send(id2);assert.equal(revoked.http,400);assert.equal(ran,1);
  }finally{admission.close();await handle.close();}
});
