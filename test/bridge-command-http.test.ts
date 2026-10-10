import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryControlPlaneStore} from '../src/product/memory-control-plane-store.js';
import {ControlPlaneService,type ControlPlaneIdentity} from '../src/product/control-plane-service.js';
import {createControlPlaneHttpHandler} from '../src/product/control-plane-http.js';

async function fixture(enabled=true) {
  let now=new Date('2026-10-10T15:00:00.000Z');
  const store=new MemoryControlPlaneStore();
  const service=new ControlPlaneService(store,{now:()=>now});
  const owner={accountId:'transport-owner',role:'user'} as const;
  const stranger={accountId:'another-owner',role:'user'} as const;
  const internal={accountId:'hub-service',role:'service'} as const;
  await service.ensureAccount({id:owner.accountId});
  await service.ensureAccount({id:stranger.accountId});
  const pairing=await service.beginPairing(owner,'transport-win32');
  const paired=await service.consumePairing({
    pairingId:pairing.pairingId,token:pairing.token,
    platform:'win32',deviceAnchorHash:'d'.repeat(64),
  });
  const deviceId=paired.device.id,credential=paired.deviceCredential;
  await service.setDeviceAccessMode(owner,deviceId,'full');
  const device=await store.getDevice(deviceId);
  assert.ok(device);
  await store.putDevice({...device,online:true,privilegeMode:'broker',adminBridgeReady:true});
  await service.setDeviceBridgePreference(owner,deviceId,'on');
  const handle=createControlPlaneHttpHandler(service,{
    enableBridgeCommandTransport:enabled,
    authenticate:async request=>{
      const raw=request.headers.get('x-test-identity');
      return raw?JSON.parse(raw) as ControlPlaneIdentity:null;
    },
  });
  const send=async(
    path:string,body:unknown,identity:ControlPlaneIdentity|null,
    confirmation?:string,
  )=>await handle(new Request('https://test.example'+path,{
    method:'POST',
    headers:{
      'content-type':'application/json',
      ...(identity?{'x-test-identity':JSON.stringify(identity)}:{}),
      ...(confirmation?{'x-nexowire-confirm':confirmation}:{}),
    },
    body:JSON.stringify(body),
  }));
  const ownerCommand='/api/v1/me/devices/bridge-command';
  const claim='/api/v1/internal/device/bridge-command/claim';
  const acknowledge='/api/v1/internal/device/bridge-command/receipt';
  const getStatus=async(id:string,identity:ControlPlaneIdentity)=>{
    return await handle(new Request(
      'https://test.example/api/v1/me/devices/bridge-command/status?requestId='+encodeURIComponent(id),
      {headers:{'x-test-identity':JSON.stringify(identity)}},
    ));
  };
  return {store,service,owner,stranger,internal,deviceId,credential,
    send,getStatus,ownerCommand,claim,acknowledge,
    advance:(ms:number)=>{now=new Date(now.getTime()+ms);},
    now:()=>now.toISOString()};
}

test('bridge command transport remains disabled by default even for authenticated users',async()=>{
  const f=await fixture(false);
  assert.equal((await f.send(f.ownerCommand,{
    deviceId:f.deviceId,mode:'on',confirmation:'APPLY BRIDGE MODE',
  },f.owner,'bridge-command-issue-v1')).status,503);
  assert.equal((await f.send(f.claim,{
    credential:f.credential,requestId:'11111111-1111-4111-8111-111111111111',
  },f.internal)).status,503);
});

test('owner approval is independent of saved bridge preference; no automatic queue',async()=>{
  const f=await fixture();
  const body={deviceId:f.deviceId,mode:'on',confirmation:'APPLY BRIDGE MODE'};
  assert.equal((await f.send(f.ownerCommand,body,null,'bridge-command-issue-v1')).status,401);
  assert.equal((await f.send(f.ownerCommand,body,f.stranger,'bridge-command-issue-v1')).status,404);
  assert.equal((await f.send(f.ownerCommand,body,f.internal,'bridge-command-issue-v1')).status,403);
  assert.equal((await f.send(f.ownerCommand,body,f.owner)).status,400);
  assert.equal((await f.send(f.ownerCommand,body,f.owner,'wrong')).status,400);
  assert.equal((await f.send(f.ownerCommand,{...body,confirmation:'NO'},f.owner,'bridge-command-issue-v1')).status,400);
  assert.equal((await f.send(f.ownerCommand,{...body,mode:'off'},f.owner,'bridge-command-issue-v1')).status,409);
  assert.equal((await f.send(f.claim,{credential:f.credential,requestId:'11111111-1111-4111-8111-111111111111'},f.internal)).status,409);
  const issued=await f.send(f.ownerCommand,body,f.owner,'bridge-command-issue-v1');
  assert.equal(issued.status,201);
  const command=await issued.json() as {requestId:string;status:string;deviceId:string};
  assert.equal(command.status,'queued');
  assert.equal(command.deviceId,f.deviceId);
  assert.equal((await f.getStatus(command.requestId,f.stranger)).status,404);
  const status=await f.getStatus(command.requestId,f.owner);
  assert.equal(status.status,200);
  assert.equal((await status.json() as {status:string}).status,'queued');
  assert.doesNotMatch(JSON.stringify(await f.getStatus(command.requestId,f.owner).then(x=>x.json())),/credentialBinding|credentialHash/);
});

test('only service and currently paired device can claim once, then submit verified receipt',async()=>{
  const f=await fixture();
  const body={deviceId:f.deviceId,mode:'on',confirmation:'APPLY BRIDGE MODE'};
  const issue=await f.send(f.ownerCommand,body,f.owner,'bridge-command-issue-v1');
  assert.equal(issue.status,201);
  const {requestId}=await issue.json() as {requestId:string};
  assert.equal((await f.send(f.claim,{credential:f.credential,requestId},f.owner)).status,403);
  assert.equal((await f.send(f.claim,{credential:'nwx_dev_fake',requestId},f.internal)).status,401);
  const claimed=await f.send(f.claim,{credential:f.credential,requestId},f.internal);
  assert.equal(claimed.status,200);
  const result=await claimed.json() as {intent:{requestId:string;desiredMode:string;credentialBinding:string}};
  assert.equal(result.intent.requestId,requestId);
  assert.equal(result.intent.desiredMode,'on');
  assert.match(result.intent.credentialBinding,/^[a-f0-9]{64}$/);
  assert.equal((await f.send(f.claim,{credential:f.credential,requestId},f.internal)).status,409);
  const receipt={
    type:'admin-bridge.mode-receipt',version:1,requestId,
    deviceId:f.deviceId,credentialBinding:result.intent.credentialBinding,
    desiredMode:'on',observedAt:f.now(),result:'applied',
    taskState:'Running',taskVerified:true,
    brokerHealth:'authenticated-ready',failureCode:null,
  };
  assert.equal((await f.send(f.acknowledge,{credential:f.credential,receipt},f.owner)).status,403);
  assert.equal((await f.send(f.acknowledge,{credential:'nwx_dev_fake',receipt},f.internal)).status,401);
  assert.equal((await f.send(f.acknowledge,{credential:f.credential,
    receipt:{...receipt,brokerHealth:'unverified'}},f.internal)).status,400);
  assert.equal((await f.getStatus(requestId,f.owner).then(x=>x.json()) as {status:string}).status,'claimed');
  const accepted=await f.send(f.acknowledge,{credential:f.credential,receipt},f.internal);
  assert.equal(accepted.status,200);
  assert.equal((await accepted.json() as {status:string}).status,'applied');
  assert.equal((await f.send(f.acknowledge,{credential:f.credential,receipt},f.internal)).status,409);
  assert.equal((await f.getStatus(requestId,f.owner).then(x=>x.json()) as {status:string}).status,'applied');
});

test('changing saved preference invalidates in-flight claims and receipts',async()=>{
  const f=await fixture();
  const issue=await f.send(f.ownerCommand,{
    deviceId:f.deviceId,mode:'on',confirmation:'APPLY BRIDGE MODE',
  },f.owner,'bridge-command-issue-v1');
  const {requestId}=await issue.json() as {requestId:string};
  const claimed=await f.send(f.claim,{credential:f.credential,requestId},f.internal);
  assert.equal(claimed.status,200);
  const {intent}=await claimed.json() as {intent:{credentialBinding:string}};
  await f.service.setDeviceBridgePreference(f.owner,f.deviceId,'off');
  await f.service.setDeviceBridgePreference(f.owner,f.deviceId,'on');
  const receipt={
    type:'admin-bridge.mode-receipt',version:1,requestId,
    deviceId:f.deviceId,credentialBinding:intent.credentialBinding,
    desiredMode:'on',observedAt:f.now(),result:'applied',
    taskState:'Running',taskVerified:true,
    brokerHealth:'authenticated-ready',failureCode:null,
  };
  assert.equal((await f.send(f.acknowledge,{credential:f.credential,receipt},f.internal)).status,409);
  assert.equal((await f.getStatus(requestId,f.owner).then(x=>x.json()) as {status:string}).status,'claimed');
});

test('expired commands and a re-paired device cannot claim previous commands',async()=>{
  const f=await fixture();
  const issue=await f.send(f.ownerCommand,{
    deviceId:f.deviceId,mode:'on',confirmation:'APPLY BRIDGE MODE',
  },f.owner,'bridge-command-issue-v1');
  const {requestId}=await issue.json() as {requestId:string};
  f.advance(120_000);
  assert.equal((await f.send(f.claim,{credential:f.credential,requestId},f.internal)).status,409);
  const newIssue=await f.send(f.ownerCommand,{
    deviceId:f.deviceId,mode:'on',confirmation:'APPLY BRIDGE MODE',
  },f.owner,'bridge-command-issue-v1');
  assert.equal(newIssue.status,201);
  const nextId=(await newIssue.json() as {requestId:string}).requestId;
  const record=await f.store.getDevice(f.deviceId);
  assert.ok(record);
  await f.store.putDevice({...record,credentialHash:'f'.repeat(64)});
  assert.equal((await f.send(f.claim,{credential:f.credential,requestId:nextId},f.internal)).status,401);
});

test('failed device receipt is recorded as failure, never successful applied',async()=>{
  const f=await fixture();
  const issue=await f.send(f.ownerCommand,{
    deviceId:f.deviceId,mode:'on',confirmation:'APPLY BRIDGE MODE',
  },f.owner,'bridge-command-issue-v1');
  const {requestId}=await issue.json() as {requestId:string};
  const claimed=await f.send(f.claim,{credential:f.credential,requestId},f.internal);
  const {intent}=await claimed.json() as {intent:{credentialBinding:string}};
  const receipt={
    type:'admin-bridge.mode-receipt',version:1,requestId,
    deviceId:f.deviceId,credentialBinding:intent.credentialBinding,
    desiredMode:'on',observedAt:f.now(),result:'failed',
    taskState:'Ready',taskVerified:false,
    brokerHealth:'unverified',failureCode:'BROKER_NOT_ELEVATED',
  };
  const accepted=await f.send(f.acknowledge,{credential:f.credential,receipt},f.internal);
  assert.equal(accepted.status,200);
  assert.equal((await accepted.json() as {status:string}).status,'failed');
  assert.equal((await f.getStatus(requestId,f.owner).then(x=>x.json()) as {status:string;failureCode:string}).failureCode,'BROKER_NOT_ELEVATED');
});

test('offline and SAFE transitions deny a queued claim or in-flight completion',async()=>{
  const f=await fixture();
  const issue=await f.send(f.ownerCommand,{
    deviceId:f.deviceId,mode:'on',confirmation:'APPLY BRIDGE MODE',
  },f.owner,'bridge-command-issue-v1');
  assert.equal(issue.status,201);
  const {requestId}=await issue.json() as {requestId:string};
  const original=await f.store.getDevice(f.deviceId);
  assert.ok(original);
  await f.store.putDevice({...original,online:false});
  assert.equal((await f.send(f.claim,{
    credential:f.credential,requestId,
  },f.internal)).status,409);
  await f.store.putDevice(original);
  const claimed=await f.send(f.claim,{credential:f.credential,requestId},f.internal);
  assert.equal(claimed.status,200);
  const intent=(await claimed.json() as {intent:{credentialBinding:string}}).intent;
  // Revocation does not remotely execute anything; it prevents a stale ACK.
  await f.service.setDeviceAccessMode(f.owner,f.deviceId,'safe');
  const receipt={
    type:'admin-bridge.mode-receipt',version:1,requestId,
    deviceId:f.deviceId,credentialBinding:intent.credentialBinding,
    desiredMode:'on',observedAt:f.now(),result:'applied',
    taskState:'Running',taskVerified:true,
    brokerHealth:'authenticated-ready',failureCode:null,
  };
  assert.equal((await f.send(f.acknowledge,{
    credential:f.credential,receipt,
  },f.internal)).status,409);
});
