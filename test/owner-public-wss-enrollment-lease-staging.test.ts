import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {
  ProposedOwnerPublicWssEnrollmentLease,
  ProposedEnrolledOwnerQuotaWsSession,
  ProposedOwnerWssSqliteReceiptJournal,
} from '../src/product/owner-public-wss-enrollment-lease-proposal.js';
import {
  serializeOwnerPublicWssEnrollment,
  type SignedOwnerPublicWssEnrollment,
  type TrustedOwnerPublicWssEnrollmentContext,
} from '../src/product/owner-public-wss-operator-enrollment-proposal.js';

const now=1_800_000_000_000;
const keys=generateKeyPairSync('ed25519');
const trusted:TrustedOwnerPublicWssEnrollmentContext={
  operatorId:'test-operator',keyId:'test-operator-key-01',
  operatorPublicKeyPem:keys.publicKey.export({
    format:'pem',type:'spki',
  }).toString(),
  accountId:'acct-7',deviceId:'device-9',
  activeSessionGeneration:14,minimumProfileRevision:9,nowMs:now,
};
const data:SignedOwnerPublicWssEnrollment={
  version:1,operatorId:trusted.operatorId,keyId:trusted.keyId,
  accountId:trusted.accountId,deviceId:trusted.deviceId,
  sessionGeneration:14,profileRevision:9,
  issuedAtMs:now-5_000,expiresAtMs:now+60_000,
  profile:{
    endpoint:'wss://edge.example.com/internal/owner-quota/v1/outbound',
    expectedHostname:'edge.example.com',
    trustedSpkiSha256:['a'.repeat(64)],caMode:'system',
  },
  signature:'',
};
function signed():SignedOwnerPublicWssEnrollment{
  const v={...data,profile:{...data.profile}};
  v.signature=sign(null,serializeOwnerPublicWssEnrollment(v),
    keys.privateKey).toString('base64url');
  return v;
}

test('independent trusted state is freshly read before each request',async()=>{
  let reads=0;
  const lease=await ProposedOwnerPublicWssEnrollmentLease.establish(
    signed(),async()=>{reads++;return {...trusted}},
  );
  assert.equal(lease.profile.endpoint,data.profile.endpoint);
  await lease.requireCurrent();
  await lease.requireCurrent();
  assert.equal(reads,3);
  lease.invalidate();
  await assert.rejects(lease.requireCurrent(),/invalidated/);
  assert.equal(reads,3);
});

test('session generation revocation invalidates lease permanently',async()=>{
  let epoch=14;
  const lease=await ProposedOwnerPublicWssEnrollmentLease.establish(
    signed(),async()=>({...trusted,activeSessionGeneration:epoch}),
  );
  await lease.requireCurrent();
  epoch=15;
  await assert.rejects(lease.requireCurrent(),/revoked|unavailable/);
  epoch=14;
  await assert.rejects(lease.requireCurrent(),/invalidated/);
});

test('account/device/key/revision changes must fail closed',async()=>{
  for(const changed of [
    {deviceId:'another-device'},
    {accountId:'another-account'},
    {keyId:'rotated-operator-key'},
    {minimumProfileRevision:10},
  ]){
    let state={...trusted};
    const lease=await ProposedOwnerPublicWssEnrollmentLease.establish(
      signed(),async()=>state,
    );
    state={...trusted,...changed};
    await assert.rejects(lease.requireCurrent(),/revoked|unavailable/);
  }
});

test('expiry and unavailable authority deny old enrollment',async()=>{
  let clock=now;
  let offline=false;
  const reader=async()=>{
    if(offline)throw new Error('owner offline');
    return {...trusted,nowMs:clock};
  };
  const lease=await ProposedOwnerPublicWssEnrollmentLease.establish(
    signed(),reader,
  );
  await lease.requireCurrent();
  clock=now+60_000;
  await assert.rejects(lease.requireCurrent(),/expired|revoked|unavailable/);
  clock=now;
  await assert.rejects(lease.requireCurrent(),/invalidated/);
  const newLease=await ProposedOwnerPublicWssEnrollmentLease.establish(
    signed(),reader,
  );
  offline=true;
  await assert.rejects(newLease.requireCurrent(),/unavailable/);
});

test('tampered initial enrollment cannot start public WSS dial',async()=>{
  const altered=signed();
  altered.profile={...altered.profile,trustedSpkiSha256:['b'.repeat(64)]};
  let reads=0;
  await assert.rejects(ProposedEnrolledOwnerQuotaWsSession.connect(
    altered,async()=>{reads++;return {...trusted}}, new ProposedOwnerWssSqliteReceiptJournal(new DatabaseSync(':memory:')),
  ),/signature/);
  assert.equal(reads,1);
});

test('caller mutation after valid enrollment cannot switch endpoint',async()=>{
  const envelope=signed();
  const lease=await ProposedOwnerPublicWssEnrollmentLease.establish(
    envelope,async()=>({...trusted}),
  );
  envelope.profile={
    ...envelope.profile,
    expectedHostname:'wrong.example.com',
    endpoint:'wss://wrong.example.com/internal/owner-quota/v1/outbound',
  };
  envelope.signature='A'.repeat(86);
  assert.equal(lease.profile.endpoint,data.profile.endpoint);
  await lease.requireCurrent();
});

/**
 * Isolated transport seam: we intentionally avoid any public network,
 * production owner URL or native Broker. TypeScript's private constructor
 * emits a normal JS constructor, so Reflect.construct is test-only.
 */
async function localSession(
  read:()=>Promise<TrustedOwnerPublicWssEnrollmentContext>,
  transport:{reserve:(frame:unknown)=>Promise<unknown>;close:()=>void},
):Promise<ProposedEnrolledOwnerQuotaWsSession>{
  const lease=await ProposedOwnerPublicWssEnrollmentLease.establish(signed(),read);
  return Reflect.construct(ProposedEnrolledOwnerQuotaWsSession,[
    lease,transport,
  ]) as ProposedEnrolledOwnerQuotaWsSession;
}
function quotaFrame(deviceId=trusted.deviceId){
  return {
    version:1 as const,kind:'reserve' as const,
    requestId:'frame-000001',
    envelope:{deviceId},
  } as Parameters<ProposedEnrolledOwnerQuotaWsSession['reserve']>[0];
}
function quotaReply(){
  return {
    version:1 as const,kind:'decision' as const,
    requestId:'frame-000001',httpStatus:200,
    data:{decision:{status:'reserved',authorizesToolExecution:false}},
  };
}

test('healthy in-flight reservation gets an independent post-response trust read',async()=>{
  let reads=0;
  let sends=0;
  let closes=0;
  const session=await localSession(
    async()=>{reads++;return {...trusted}},
    {reserve:async()=>{sends++;return quotaReply()},close:()=>{closes++}},
  );
  const result=await session.reserve(quotaFrame());
  assert.equal(result.httpStatus,200);
  assert.equal(reads,3); // establish, before send, AFTER response
  assert.equal(sends,1);
  assert.equal(closes,0);
  session.close();
  assert.equal(closes,1);
});

test('wrong enrolled device is rejected before trusted read or outbound send',async()=>{
  let reads=0;
  let sends=0;
  let closes=0;
  const session=await localSession(
    async()=>{reads++;return {...trusted}},
    {reserve:async()=>{sends++;return quotaReply()},close:()=>{closes++}},
  );
  await assert.rejects(
    session.reserve(quotaFrame('different-device')),
    /device binding mismatch/,
  );
  assert.equal(reads,1);
  assert.equal(sends,0);
  assert.equal(closes,1);
  await assert.rejects(session.reserve(quotaFrame()),/closed/);
});

test('session revocation while WSS RPC is pending rejects a late 200',async()=>{
  let generation=trusted.activeSessionGeneration;
  let start!:()=>void;
  let reply!: (value:ReturnType<typeof quotaReply>)=>void;
  const began=new Promise<void>(resolve=>{start=resolve});
  const waiting=new Promise<ReturnType<typeof quotaReply>>(resolve=>{
    reply=resolve;
  });
  let closes=0;
  let sends=0;
  const session=await localSession(
    async()=>({...trusted,activeSessionGeneration:generation}),
    {reserve:async()=>{sends++;start();return waiting},
      close:()=>{closes++}},
  );
  const pending=session.reserve(quotaFrame());
  await began;
  generation+=1;
  reply(quotaReply());
  await assert.rejects(pending,/revoked|unavailable/);
  assert.equal(sends,1);
  assert.equal(closes,1);
  generation-=1;
  await assert.rejects(session.reserve(quotaFrame()),/closed/);
});

test('trusted authority going offline before response invalidates the session',async()=>{
  let offline=false;
  let start!:()=>void;
  let reply!:(value:ReturnType<typeof quotaReply>)=>void;
  const began=new Promise<void>(resolve=>{start=resolve});
  const waiting=new Promise<ReturnType<typeof quotaReply>>(resolve=>{
    reply=resolve;
  });
  let closes=0;
  const session=await localSession(
    async()=>{
      if(offline)throw new Error('independent owner trust state unreachable');
      return {...trusted};
    },
    {reserve:async()=>{start();return waiting},
      close:()=>{closes++}},
  );
  const pending=session.reserve(quotaFrame());
  await began;
  offline=true;
  reply(quotaReply());
  await assert.rejects(pending,/revoked|unavailable/);
  assert.equal(closes,1);
});

test('explicit close during an in-flight call refuses even a delayed 200',async()=>{
  let start!:()=>void;
  let reply!:(value:ReturnType<typeof quotaReply>)=>void;
  const began=new Promise<void>(resolve=>{start=resolve});
  const waiting=new Promise<ReturnType<typeof quotaReply>>(resolve=>{
    reply=resolve;
  });
  let closes=0;
  const session=await localSession(
    async()=>({...trusted}),
    {reserve:async()=>{start();return waiting},
      close:()=>{closes++}},
  );
  const pending=session.reserve(quotaFrame());
  await began;
  session.close();
  reply(quotaReply());
  await assert.rejects(pending,/closed/);
  assert.equal(closes,1);
});
test('explicit lease invalidation during async owner read cannot be undone',async()=>{
  let calls=0;
  let finish!:(value:TrustedOwnerPublicWssEnrollmentContext)=>void;
  const read=async()=>{
    calls++;
    if(calls===1)return {...trusted};
    return new Promise<TrustedOwnerPublicWssEnrollmentContext>(resolve=>{
      finish=resolve;
    });
  };
  const lease=await ProposedOwnerPublicWssEnrollmentLease.establish(
    signed(),read,
  );
  const pending=lease.requireCurrent();
  lease.invalidate();
  finish({...trusted});
  await assert.rejects(pending,/revoked|unavailable/);
  assert.equal(calls,2);
  await assert.rejects(lease.requireCurrent(),/invalidated/);
});