import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {
  AtomicMutationCoordinator,
  executeNativeMutationOnce,
  type AtomicMutationAuthority,
  type BoundMutationIdentity,
  type MutationIntent,
  type MutationReservation,
  type ServerIssuedDeviceLease,
} from '../../src/core/atomic-mutation-authority.js';

const OWNER='owner-ai04';
const DEVICE='device-ai04';
const AUTHORITY='authority-ai04';
const nowAt=1_800_000_000_000;

type Status='RESERVED'|'DISPATCHED'|'EFFECT_CONSUMED';
function errorCode(error:unknown):string|undefined {
  return (error as {code?:string})?.code;
}
function wire(requestId=randomUUID(), capability='files.write') {
  return {requestId,capability,frame:JSON.stringify({
    type:'request',requestId,capability,input:{path:'C:\\fixture\\no-real-effects'},
    accessMode:'full',
  })};
}
function lease(now:number,epoch=7):BoundMutationIdentity {
  return Object.freeze({authorityId:AUTHORITY,ownerId:OWNER,deviceId:DEVICE,
    authorizationEpoch:epoch,leaseExpiresAtMs:now+20_000});
}

/**
 * CI fixture only, NEVER an independent/production authority. Its serial
 * critical section is a model for the required durable distributed contract.
 */
class FixtureAuthority implements AtomicMutationAuthority {
  private gate:Promise<void>=Promise.resolve();
  private readonly tombstones=new Map<string,{permit:MutationReservation;status:Status}>();
  active=true;
  ownerId=OWNER;
  deviceId=DEVICE;
  epoch=7;
  beforeDispatch?:()=>void;
  afterReserve?:()=>void;
  onNativeAdmission?:()=>void;
  reserveCalls=0;
  dispatchCalls=0;
  effectCalls=0;
  constructor(private readonly clock:()=>number){}

  private async serial<T>(fn:()=>Promise<T>|T):Promise<T>{
    const previous=this.gate;
    let unlock!:()=>void;
    this.gate=new Promise<void>(resolve=>{unlock=resolve;});
    await previous;
    try{return await fn();}finally{unlock();}
  }

  private current(scope:ServerIssuedDeviceLease):boolean {
    return this.active && scope.ownerId===this.ownerId &&
      scope.deviceId===this.deviceId && scope.authorizationEpoch===this.epoch &&
      scope.leaseExpiresAtMs>this.clock();
  }

  async reserveFresh(intent:Readonly<MutationIntent>):Promise<MutationReservation|null>{
    return this.serial(()=>{
      this.reserveCalls++;
      if(!this.current(intent))return null;
      const existing=this.tombstones.get(intent.deviceId+':'+intent.requestId);
      if(existing)return {...existing.permit,created:false};
      const permit:Object=Object.freeze({
        ...intent,authorityId:AUTHORITY,reservationId:randomUUID(),created:true,
      });
      const result=permit as MutationReservation;
      this.tombstones.set(intent.deviceId+':'+intent.requestId,
        {permit:result,status:'RESERVED'});
      this.afterReserve?.();
      return result;
    });
  }

  async dispatchIfCurrent(permit:Readonly<MutationReservation>,enqueueFrame:()=>void):Promise<void>{
    return this.serial(()=>{
      this.dispatchCalls++;
      this.beforeDispatch?.();
      const record=this.tombstones.get(permit.deviceId+':'+permit.requestId);
      if(!record || record.status!=='RESERVED' ||
          record.permit.reservationId!==permit.reservationId ||
          !this.current(permit))throw new Error('revoke/duplicate deny');
      // Consume BEFORE transmitting: errors imply UNKNOWN, not resubmission.
      record.status='DISPATCHED';
      enqueueFrame();
    });
  }

  async admitNativeEffectOnce(permit:Readonly<MutationReservation>,
      effect:()=>Promise<void>):Promise<void>{
    return this.serial(async()=>{
      this.onNativeAdmission?.();
      const record=this.tombstones.get(permit.deviceId+':'+permit.requestId);
      if(!record || record.status!=='DISPATCHED' ||
          record.permit.reservationId!==permit.reservationId ||
          !this.current(permit))throw new Error('native effect revoked or consumed');
      record.status='EFFECT_CONSUMED';
      this.effectCalls++;
      await effect();
    });
  }

  async revoke():Promise<void> {
    await this.serial(()=>{this.active=false;this.epoch++;});
  }
  async rotate():Promise<void> {
    await this.serial(()=>{this.epoch++;});
  }
  status(deviceId:string,requestId:string):Status|undefined {
    return this.tombstones.get(deviceId+':'+requestId)?.status;
  }
}

function fixture(options?:{
  binding?:BoundMutationIdentity;
  verifier?:()=>Promise<ServerIssuedDeviceLease|undefined>;
  available?:boolean;
}) {
  let now=nowAt;
  const clock=()=>now;
  const authority=new FixtureAuthority(clock);
  const binding=options?.binding??lease(now);
  const verifier=options && 'verifier' in options ? options.verifier : async()=>lease(now);
  const gateway=new AtomicMutationCoordinator(
    binding,verifier,options?.available===false?undefined:authority,clock);
  const frames:string[]=[];
  const send=(frame:string)=>{frames.push(frame);};
  return {authority, binding, gateway, frames, send,
    advance:(ms:number)=>{now+=ms;},clock};
}

test('AI-04 missing bound verifier or CAS provider denies with zero frames',async()=>{
  const f=fixture({verifier:undefined});
  await assert.rejects(f.gateway.dispatch(wire(),f.send),
    e=>errorCode(e)==='AGENT_AUTH_NOT_BOUND');
  assert.equal(f.authority.reserveCalls,0);
  assert.equal(f.frames.length,0);
  const missing=fixture({available:false});
  await assert.rejects(missing.gateway.dispatch(wire(),missing.send),
    e=>errorCode(e)==='AGENT_AUTH_NOT_BOUND');
  assert.equal(missing.frames.length,0);
});

test('AI-04 wrong owner/device/epoch fails closed before CAS and before send',async()=>{
  for(const change of [
    {ownerId:'owner-wrong'},
    {deviceId:'device-wrong'},
    {authorizationEpoch:8},
  ]) {
    const bad={...lease(nowAt),...change};
    const f=fixture({verifier:async()=>bad});
    await assert.rejects(f.gateway.dispatch(wire(),f.send),
      e=>errorCode(e)==='AGENT_AUTH_REVOKED');
    assert.equal(f.authority.reserveCalls,0);
    assert.equal(f.frames.length,0);
  }
});

test('AI-04 expired lease and unavailable verifier are both zero-frame denies',async()=>{
  const stale=fixture();
  stale.advance(20_001);
  await assert.rejects(stale.gateway.dispatch(wire(),stale.send),
    e=>errorCode(e)==='AGENT_AUTH_REVOKED');
  assert.equal(stale.frames.length,0);
  const failed=fixture({verifier:async()=>{throw new Error('offline');}});
  await assert.rejects(failed.gateway.dispatch(wire(),failed.send),
    e=>errorCode(e)==='AGENT_AUTH_REVOKED');
  assert.equal(failed.frames.length,0);
});

test('AI-04 simultaneous duplicate UUID authorizes at most one frame',async()=>{
  const f=fixture(),request=wire();
  const outcome=await Promise.allSettled([
    f.gateway.dispatch(request,f.send),f.gateway.dispatch(request,f.send),
  ]);
  assert.equal(outcome.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(f.frames.length,1);
  assert.equal(f.authority.reserveCalls,2);
  assert.equal(f.authority.dispatchCalls,1);
  assert.equal(f.authority.status(DEVICE,request.requestId),'DISPATCHED');
});

test('AI-04 lost ACK, reconnect and identical UUID never schedule a second frame',async()=>{
  const f=fixture(),request=wire();
  await f.gateway.dispatch(request,f.send); // no ACK arrives
  // Reconnect creates a new session coordinator, but the durable CAS namespace
  // persists, independent of the Broker pending-map lifecycle.
  const fresh=new AtomicMutationCoordinator(f.binding,async()=>lease(f.clock()),f.authority,f.clock);
  await assert.rejects(fresh.dispatch(request,f.send),
    e=>errorCode(e)==='MUTATION_ALREADY_RESERVED');
  assert.deepEqual(f.frames,[request.frame]);
});

test('AI-04 rotation after reservation but before transmit preserves tombstone and emits zero frames',async()=>{
  const f=fixture(),request=wire();
  f.authority.afterReserve=()=>{f.authority.epoch++;};
  await assert.rejects(f.gateway.dispatch(request,f.send),
    e=>errorCode(e)==='MUTATION_STATE_UNKNOWN');
  assert.equal(f.frames.length,0);
  assert.equal(f.authority.status(DEVICE,request.requestId),'RESERVED');
  await assert.rejects(f.gateway.dispatch(request,f.send),
    e=>errorCode(e)==='MUTATION_ALREADY_RESERVED');
  assert.equal(f.frames.length,0);
});

test('AI-04 revoke ordered immediately before enqueue yields zero frames',async()=>{
  const f=fixture(),request=wire();
  f.authority.beforeDispatch=()=>{f.authority.active=false;f.authority.epoch++;};
  await assert.rejects(f.gateway.dispatch(request,f.send),
    e=>errorCode(e)==='MUTATION_STATE_UNKNOWN');
  assert.equal(f.frames.length,0);
});

test('AI-04 dispatch-time lease expiry returns UNKNOWN with no frame and no replay',async()=>{
  const f=fixture(),request=wire();
  f.authority.afterReserve=()=>{f.advance(20_001);};
  await assert.rejects(f.gateway.dispatch(request,f.send),
    e=>errorCode(e)==='AGENT_AUTH_REVOKED');
  assert.equal(f.frames.length,0);
});

test('AI-04 native effect admission is separate and one-time',async()=>{
  const f=fixture(),request=wire();
  const permit=await f.gateway.dispatch(request,f.send);
  let effects=0;
  await executeNativeMutationOnce(f.authority,permit,async()=>{effects++;});
  await assert.rejects(executeNativeMutationOnce(f.authority,permit,async()=>{effects++;}),
    e=>errorCode(e)==='NATIVE_MUTATION_EFFECT_NOT_ADMITTED');
  assert.equal(effects,1);
  assert.equal(f.authority.effectCalls,1);
});

test('AI-04 revocation after socket send but before native admission denies OS effect',async()=>{
  const f=fixture(),request=wire();
  const permit=await f.gateway.dispatch(request,f.send);
  assert.equal(f.frames.length,1);
  await f.authority.revoke();
  let effects=0;
  await assert.rejects(executeNativeMutationOnce(f.authority,permit,async()=>{effects++;}),
    e=>errorCode(e)==='NATIVE_MUTATION_EFFECT_NOT_ADMITTED');
  assert.equal(effects,0);
});

test('AI-04 unavailable native provider never executes effect',async()=>{
  const f=fixture();
  const permit=await f.gateway.dispatch(wire(),f.send);
  let effects=0;
  await assert.rejects(executeNativeMutationOnce(undefined,permit,async()=>{effects++;}),
    e=>errorCode(e)==='NATIVE_MUTATION_AUTHORITY_UNAVAILABLE');
  assert.equal(effects,0);
});

test('AI-04 network error after reserve stays UNKNOWN, duplicate cannot be resubmitted',async()=>{
  const f=fixture(),request=wire();
  await assert.rejects(f.gateway.dispatch(request,()=>{throw new Error('socket lost');}),
    e=>errorCode(e)==='MUTATION_STATE_UNKNOWN');
  assert.equal(f.frames.length,0);
  await assert.rejects(f.gateway.dispatch(request,f.send),
    e=>errorCode(e)==='MUTATION_ALREADY_RESERVED');
  assert.equal(f.frames.length,0);
});

test('AI-04 wire mismatch fails before reserve and cannot authorize another capability',async()=>{
  const f=fixture(),a=wire();
  await assert.rejects(f.gateway.dispatch({...a,capability:'process.start'},f.send),
    e=>errorCode(e)==='MUTATION_WIRE_SCOPE_MISMATCH');
  await assert.rejects(f.gateway.dispatch({...a,frame:'{bad json'},f.send),
    e=>errorCode(e)==='MUTATION_WIRE_INVALID');
  assert.equal(f.authority.reserveCalls,0);
  assert.equal(f.frames.length,0);
});

test('AI-04 tampered reservation scope never reaches a frame',async()=>{
  const f=fixture(),r=wire();
  const original=f.authority.reserveFresh.bind(f.authority);
  f.authority.reserveFresh=async intent=>{
    const permit=await original(intent);
    return permit?{...permit,fingerprint:createHash('sha256').update('wrong').digest('hex')}:null;
  };
  await assert.rejects(f.gateway.dispatch(r,f.send),
    e=>errorCode(e)==='MUTATION_CAS_INVALID_RECEIPT');
  assert.equal(f.frames.length,0);
});
