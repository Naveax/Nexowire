import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PostgresBoundGrantCas,
  type AuthenticatedGrantScope,
  type ExternalGrantCas,
  type ExternalGrantCasReceipt,
} from '../src/agent/postgres-bound-grant-cas.js';
import type {CasRequest} from '../src/agent/remote-mutation-cas.js';
import type {WitnessPgPool} from '../src/agent/postgres-monotonic-witness.js';

const ids={
  authority:'00000000-0000-4000-8000-000000000101',
  owner:'00000000-0000-4000-8000-000000000102',
  foreignOwner:'00000000-0000-4000-8000-000000000103',
  device:'00000000-0000-4000-8000-000000000104',
  epoch:'00000000-0000-4000-8000-000000000105',
  session:'00000000-0000-4000-8000-000000000106',
  foreignSession:'00000000-0000-4000-8000-000000000107',
  request:'00000000-0000-4000-8000-000000000108',
};
const request=():CasRequest=>({
  deviceId:ids.device,epoch:ids.epoch,requestId:ids.request,
  fingerprint:'a'.repeat(64),capability:'windows.registry.set',
});
const scope=():AuthenticatedGrantScope=>({
  ownerId:ids.owner,deviceId:ids.device,deviceEpoch:ids.epoch,
  sessionEpoch:ids.session,expectedGeneration:4,requiredPrivilege:'CORE',
});
const hasCode=(code:string)=>(error:unknown):boolean=>
  (error as {code?:string})?.code===code;

function fixture(config:{
  resolve:()=>Promise<AuthenticatedGrantScope|undefined>;
  onClock?:()=>void|Promise<void>;
  onReservationRead?:()=>void|Promise<void>;
  reserve?:(
    request:CasRequest,scope:AuthenticatedGrantScope,
  )=>Promise<ExternalGrantCasReceipt>;
}){
  const evidence={
    queries:[] as string[],
    insert:null as unknown[]|null,
    externalCalls:0,
    externalScopes:[] as AuthenticatedGrantScope[],
    externalRequests:[] as CasRequest[],
  };
  const pool:WitnessPgPool={
    async connect(){
      return {
        async query(sql:string,values?:unknown[]){
          evidence.queries.push(sql);
          if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')
            return {rows:[]};
          if(sql.includes('FROM witness_devices'))
            return {rows:[{owner_id:ids.owner,epoch:ids.epoch,
              generation:4,state:'active'}]};
          if(sql.includes('FROM witness_delegations'))
            return {rows:[{owner_id:ids.owner,epoch:ids.epoch,
              session_epoch:ids.session,generation:4,
              core_enabled:true,root_expires_ms:null,max_seen_ms:0}]};
          if(sql.includes('clock_timestamp')){
            await config.onClock?.();
            return {rows:[{now_ms:Date.now()}]};
          }
          if(sql.includes('FROM witness_reservations')){
            await config.onReservationRead?.();
            return {rows:[]};
          }
          if(sql.startsWith('UPDATE witness_clock'))
            return {rows:[{last_sequence:71}]};
          if(sql.startsWith('INSERT INTO witness_reservations')){
            evidence.insert=[...(values??[])];
            return {rows:[{sequence:71}]};
          }
          if(sql.startsWith('UPDATE witness_delegations'))
            return {rows:[]};
          throw new Error('Unexpected synthetic SQL: '+sql);
        },
        release(){},
      };
    },
  };
  const externalCas:ExternalGrantCas={
    async reserveIfCurrent(input,authorization){
      evidence.externalCalls++;
      evidence.externalScopes.push({...authorization});
      evidence.externalRequests.push({...input});
      if(config.reserve)return config.reserve(input,authorization);
      return {
        authorityId:ids.authority,deviceId:input.deviceId,
        epoch:input.epoch,requestId:input.requestId,
        ownerId:authorization.ownerId,sessionEpoch:authorization.sessionEpoch,
        grantGeneration:authorization.expectedGeneration,
        fingerprint:input.fingerprint,capability:input.capability,
        sequence:71,created:true,
      };
    },
    async revokeIfCurrent(){throw new Error('No live revoke fixture')},
    async rePairIfCurrent(){throw new Error('No live re-pair fixture')},
  };
  const settings={
    authorityId:ids.authority,pool,externalCas,
    verifyProvenance:async()=>({
      verified:true,authorityId:ids.authority,validUntil:Date.now()+60_000,
    }),
    resolveAuthenticatedScope:async()=>config.resolve(),
  };
  const cas=new PostgresBoundGrantCas(settings);
  return {cas,evidence,settings};
}

test('AI-05 SQL awaits cannot swap validated owner/session or original UUID',async()=>{
  const borrowed=scope(),raw=request();
  const h=fixture({
    resolve:async()=>borrowed,
    onClock:()=>{
      // This occurs AFTER the device and delegation row checks, but
      // BEFORE the external CAS reservation and local tombstone insert.
      borrowed.ownerId=ids.foreignOwner;
      borrowed.sessionEpoch=ids.foreignSession;
      borrowed.expectedGeneration=99;
      raw.requestId='00000000-0000-4000-8000-000000000199';
      raw.fingerprint='b'.repeat(64);
    },
  });
  const receipt=await h.cas.reserve(raw);
  assert.equal(receipt.created,true);
  assert.equal(receipt.requestId,ids.request);
  assert.equal(h.evidence.externalCalls,1);
  assert.deepEqual(h.evidence.externalScopes,[scope()]);
  assert.deepEqual(h.evidence.externalRequests,[request()]);
  assert.deepEqual(h.evidence.insert,[
    71,ids.request,ids.device,ids.owner,ids.epoch,
    'a'.repeat(64),'windows.registry.set',
  ]);
  assert.equal(h.evidence.queries.at(-1),'COMMIT');
});

test('AI-05 hostile identity getter denied without evaluation or CAS effect',async()=>{
  const borrowed=scope();
  let getterCalls=0;
  Object.defineProperty(borrowed,'ownerId',{
    enumerable:true,configurable:true,
    get(){getterCalls++;return ids.owner},
  });
  const h=fixture({resolve:async()=>borrowed});
  await assert.rejects(h.cas.reserve(request()),
    hasCode('BOUND_CAS_UNVERIFIED_SCOPE'));
  assert.equal(getterCalls,0);
  assert.equal(h.evidence.queries.length,0);
  assert.equal(h.evidence.externalCalls,0);
});

test('AI-05 lost external CAS ACK stays UNKNOWN with no internal replay',async()=>{
  const h=fixture({
    resolve:async()=>scope(),
    reserve:async()=>{throw new Error('Synthetic lost ACK after possible reserve')},
  });
  await assert.rejects(h.cas.reserve(request()),
    hasCode('BOUND_CAS_EXTERNAL_RESERVATION_UNKNOWN'));
  assert.equal(h.evidence.externalCalls,1);
  assert.equal(h.evidence.insert,null);
  assert.ok(h.evidence.queries.includes('ROLLBACK'));
  assert.ok(!h.evidence.queries.includes('COMMIT'));
});

test('AI-05 externally tombstoned UUID cannot be inserted as fresh',async()=>{
  const h=fixture({
    resolve:async()=>scope(),
    reserve:async(input,bound)=>({
      authorityId:ids.authority,deviceId:input.deviceId,epoch:input.epoch,
      requestId:input.requestId,ownerId:bound.ownerId,
      sessionEpoch:bound.sessionEpoch,grantGeneration:bound.expectedGeneration,
      fingerprint:input.fingerprint,capability:input.capability,
      sequence:70,created:false,
    }),
  });
  const receipt=await h.cas.reserve(request());
  assert.equal(receipt.created,false);
  assert.equal(receipt.sequence,70);
  assert.equal(h.evidence.externalCalls,1);
  assert.equal(h.evidence.insert,null);
  assert.equal(h.evidence.queries.at(-1),'COMMIT');
});

test('AI-05 external created:false is pinned before later SQL await',async()=>{
  const known=scope();
  const borrowed:ExternalGrantCasReceipt={
    authorityId:ids.authority,deviceId:ids.device,epoch:ids.epoch,
    requestId:ids.request,ownerId:known.ownerId,
    sessionEpoch:known.sessionEpoch,
    grantGeneration:known.expectedGeneration,
    fingerprint:'a'.repeat(64),capability:'windows.registry.set',
    sequence:70,created:false,
  };
  const h=fixture({
    resolve:async()=>scope(),
    reserve:async()=>borrowed,
    onReservationRead:()=>{
      // A borrowed receipt can be modified after validation if the CAS
      // adapter retains it. The original already-reserved outcome must win.
      borrowed.created=true;
      borrowed.sequence=999;
    },
  });
  const result=await h.cas.reserve(request());
  assert.equal(result.created,false);
  assert.equal(result.sequence,70);
  assert.equal(h.evidence.externalCalls,1);
  assert.equal(h.evidence.insert,null);
});

test('AI-05 accessor-backed external receipt denied without getter execution',async()=>{
  const known=scope();
  const borrowed:ExternalGrantCasReceipt={
    authorityId:ids.authority,deviceId:ids.device,epoch:ids.epoch,
    requestId:ids.request,ownerId:known.ownerId,
    sessionEpoch:known.sessionEpoch,
    grantGeneration:known.expectedGeneration,
    fingerprint:'a'.repeat(64),capability:'windows.registry.set',
    sequence:70,created:false,
  };
  let getterCalls=0;
  Object.defineProperty(borrowed,'created',{
    configurable:true,enumerable:true,
    get(){getterCalls++;return true},
  });
  const h=fixture({resolve:async()=>scope(),reserve:async()=>borrowed});
  await assert.rejects(h.cas.reserve(request()),
    hasCode('BOUND_CAS_EXTERNAL_PROOF_MISMATCH'));
  assert.equal(getterCalls,0);
  assert.equal(h.evidence.insert,null);
  assert.equal(h.evidence.externalCalls,1);
  assert.ok(h.evidence.queries.includes('ROLLBACK'));
});

test('AI-05 hostile CAS request getters never run before a reservation',async()=>{
  const raw=request();
  let getterCalls=0;
  Object.defineProperty(raw,'requestId',{
    enumerable:true,configurable:true,
    get(){getterCalls++;return ids.request},
  });
  const h=fixture({resolve:async()=>scope()});
  await assert.rejects(h.cas.reserve(raw),
    hasCode('BOUND_CAS_REQUEST_INVALID'));
  assert.equal(getterCalls,0);
  assert.equal(h.evidence.queries.length,0);
  assert.equal(h.evidence.externalCalls,0);
});

test('AI-05 request pollution and symbol keys cannot enter CAS identity',async()=>{
  const h=fixture({resolve:async()=>scope()});
  const symbols={...request(),[Symbol('hidden')]:ids.foreignOwner};
  const inherited=Object.assign(Object.create({hidden:ids.foreignOwner}),request()) as CasRequest;
  const extras={...request(),unexpected:ids.foreignSession};
  for(const raw of [symbols,inherited,extras] as unknown[]){
    await assert.rejects(h.cas.reserve(raw as CasRequest),
      hasCode('BOUND_CAS_REQUEST_INVALID'));
  }
  assert.equal(h.evidence.externalCalls,0);
  assert.equal(h.evidence.queries.length,0);
});

test('AI-05 hidden non-enumerable authorization fields fail closed',async()=>{
  const input=request();
  Object.defineProperty(input,'requestId',{
    value:ids.request,enumerable:false,configurable:true,
  });
  const first=fixture({resolve:async()=>scope()});
  await assert.rejects(first.cas.reserve(input),
    hasCode('BOUND_CAS_REQUEST_INVALID'));
  assert.equal(first.evidence.externalCalls,0);
  assert.equal(first.evidence.queries.length,0);

  const returnedScope=scope();
  Object.defineProperty(returnedScope,'ownerId',{
    value:ids.owner,enumerable:false,configurable:true,
  });
  const second=fixture({resolve:async()=>returnedScope});
  await assert.rejects(second.cas.reserve(request()),
    hasCode('BOUND_CAS_UNVERIFIED_SCOPE'));
  assert.equal(second.evidence.externalCalls,0);
  assert.equal(second.evidence.queries.length,0);

  const third=fixture({
    resolve:async()=>scope(),
    reserve:async(input,bound)=>{
      const receipt:ExternalGrantCasReceipt={
        authorityId:ids.authority,deviceId:input.deviceId,epoch:input.epoch,
        requestId:input.requestId,ownerId:bound.ownerId,
        sessionEpoch:bound.sessionEpoch,
        grantGeneration:bound.expectedGeneration,
        fingerprint:input.fingerprint,capability:input.capability,
        sequence:71,created:true,
      };
      Object.defineProperty(receipt,'created',{
        value:true,enumerable:false,configurable:true,
      });
      return receipt;
    },
  });
  await assert.rejects(third.cas.reserve(request()),
    hasCode('BOUND_CAS_EXTERNAL_PROOF_MISMATCH'));
  assert.equal(third.evidence.externalCalls,1);
  assert.equal(third.evidence.insert,null);
  assert.ok(third.evidence.queries.includes('ROLLBACK'));
});

test('AI-05 authority configuration is pinned before independent provenance',async()=>{
  const f=fixture({resolve:async()=>scope()});
  const foreign='00000000-0000-4000-8000-000000000299';
  f.settings.authorityId=foreign;
  const result=await f.cas.reserve(request());
  assert.equal(result.authorityId,ids.authority);
  assert.equal(result.created,true);
  assert.equal(f.evidence.externalCalls,1);
  assert.equal(f.evidence.queries.at(-1),'COMMIT');
});

test('AI-05 external CAS provider cannot be swapped during SQL await',async()=>{
  let unauthorizedCalls=0;
  let swap:()=>void=()=>{};
  const f=fixture({
    resolve:async()=>scope(),
    onClock:()=>swap(),
  });
  swap=()=>{
    f.settings.externalCas={
      ...f.settings.externalCas,
      reserveIfCurrent:async()=>{
        unauthorizedCalls++;
        throw new Error('Untrusted provider substitution after grant checks');
      },
    };
  };
  const result=await f.cas.reserve(request());
  assert.equal(result.created,true);
  assert.equal(result.authorityId,ids.authority);
  assert.equal(f.evidence.externalCalls,1);
  assert.equal(unauthorizedCalls,0);
  assert.equal(f.evidence.queries.at(-1),'COMMIT');
});

test('AI-05 Proxy-backed request/scope/receipt rejected without invoking traps',async()=>{
  let traps=0;
  const proxy=<T extends object>(value:T):T=>new Proxy(value,{
    ownKeys(target){traps++;return Reflect.ownKeys(target)},
    getOwnPropertyDescriptor(target,key){
      traps++;return Reflect.getOwnPropertyDescriptor(target,key);
    },
  });
  const raw=fixture({resolve:async()=>scope()});
  await assert.rejects(raw.cas.reserve(proxy(request())),
    hasCode('BOUND_CAS_REQUEST_INVALID'));
  assert.equal(raw.evidence.queries.length,0);
  assert.equal(raw.evidence.externalCalls,0);

  const identified=fixture({resolve:async()=>proxy(scope())});
  await assert.rejects(identified.cas.reserve(request()),
    hasCode('BOUND_CAS_UNVERIFIED_SCOPE'));
  assert.equal(identified.evidence.queries.length,0);
  assert.equal(identified.evidence.externalCalls,0);

  const proof=fixture({
    resolve:async()=>scope(),
    reserve:async(input,bound)=>proxy({
      authorityId:ids.authority,deviceId:input.deviceId,epoch:input.epoch,
      requestId:input.requestId,ownerId:bound.ownerId,
      sessionEpoch:bound.sessionEpoch,grantGeneration:bound.expectedGeneration,
      fingerprint:input.fingerprint,capability:input.capability,
      sequence:71,created:true,
    }),
  });
  await assert.rejects(proof.cas.reserve(request()),
    hasCode('BOUND_CAS_EXTERNAL_PROOF_MISMATCH'));
  assert.equal(proof.evidence.externalCalls,1);
  assert.equal(proof.evidence.insert,null);
  assert.ok(proof.evidence.queries.includes('ROLLBACK'));
  assert.equal(traps,0);
});

test('AI-05 PostgreSQL CAS constructor rejects accessor and Proxy provider config before side effects',()=>{
  const base=fixture({resolve:async()=>scope()}).settings;
  let getters=0,traps=0;
  const hostile=Object.defineProperty({...base},'externalCas',{
    enumerable:true,configurable:true,
    get(){getters++;return base.externalCas},
  });
  assert.throws(()=>new PostgresBoundGrantCas(hostile),
    hasCode('BOUND_CAS_AUTHORITY_INVALID'));
  const proxied=new Proxy(base,{
    ownKeys(target){traps++;return Reflect.ownKeys(target)},
    getOwnPropertyDescriptor(target,key){
      traps++;return Reflect.getOwnPropertyDescriptor(target,key);
    },
  });
  assert.throws(()=>new PostgresBoundGrantCas(proxied),
    hasCode('BOUND_CAS_AUTHORITY_INVALID'));
  const extra={...base,unexpected:'override'};
  assert.throws(()=>new PostgresBoundGrantCas(extra),
    hasCode('BOUND_CAS_AUTHORITY_INVALID'));
  assert.equal(getters,0);
  assert.equal(traps,0);
});

test('AI-05 external CAS method cannot be swapped during the PostgreSQL readback await',async()=>{
  let substitutionCalls=0;
  let fixtureRef!:ReturnType<typeof fixture>;
  fixtureRef=fixture({
    resolve:async()=>scope(),
    onClock:()=>{
      fixtureRef.settings.externalCas.reserveIfCurrent=async()=>{
        substitutionCalls++;
        throw new Error('swapped CAS method after grant checks');
      };
    },
  });
  const receipt=await fixtureRef.cas.reserve(request());
  assert.equal(receipt.created,true);
  assert.equal(receipt.requestId,ids.request);
  assert.equal(fixtureRef.evidence.externalCalls,1);
  assert.equal(substitutionCalls,0);
  assert.equal(fixtureRef.evidence.queries.at(-1),'COMMIT');
});

test('AI-05 PostgreSQL connection method cannot be replaced after identity await',async()=>{
  let substitutionCalls=0;
  let fixtureRef!:ReturnType<typeof fixture>;
  fixtureRef=fixture({
    resolve:async()=>{
      fixtureRef.settings.pool.connect=async()=>{
        substitutionCalls++;
        throw new Error('swapped PostgreSQL pool method after trusted identity');
      };
      return scope();
    },
  });
  const receipt=await fixtureRef.cas.reserve(request());
  assert.equal(receipt.created,true);
  assert.equal(fixtureRef.evidence.externalCalls,1);
  assert.equal(substitutionCalls,0);
  assert.equal(fixtureRef.evidence.queries.at(-1),'COMMIT');
});
