import {createHash,randomBytes} from 'node:crypto';

/**
 * Broker #02 source contract ONLY. No physical or production provider is
 * installed. The authority must run independently of the caller and prove:
 * protected Broker image/token, scoped owner intent, durable monotonic CAS,
 * one-time commit, revoke fence, independent time and authenticated receipts.
 * A fixture, bearer, synthetic proof ID or JS boolean is NEVER such evidence.
 */
export interface BrokerVerifiedEffectBinding {
  readonly authorityId: string;
  readonly ownerId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly ownerEpoch: number;
  readonly deviceEpoch: number;
  readonly sessionEpoch: number;
  readonly generation: number;
  readonly highTokenProofId: string;
  readonly protectedBrokerProofId: string;
  readonly expiresAtMs: number;
}
export interface BrokerEffectRequest {
  readonly operationId: string;
  readonly capability: string;
  /** SHA-256 of EXACT frozen JSON `{capability,input}` passed to callback. */
  readonly inputSha256: string;
  readonly binding: BrokerVerifiedEffectBinding;
}
export interface BrokerEffectReceipt {
  readonly state: 'RESERVED' | 'COMMITTED';
  readonly operationId: string;
  readonly capability: string;
  readonly inputSha256: string;
  readonly challengeNonce: string;
  readonly ticket: string;
  readonly binding: BrokerVerifiedEffectBinding;
  /** Opaque remote authenticated proof, independently verified by adapter. */
  readonly proof: string;
}
export interface BrokerExternalEffectAdmission {
  /** Protected OS + owner grant readback; UNKNOWN/revoked must return null. */
  readVerifiedBinding(): Promise<BrokerVerifiedEffectBinding | null>;
  /**
   * Provider must enforce operationId uniqueness DURABLY across restarts.
   * All arguments, including challengeNonce, are scoped to one admission.
   */
  begin(request: BrokerEffectRequest,challengeNonce: string):
    Promise<BrokerEffectReceipt | null>;
  /** One irreversible consumption. COMMIT ACK loss = UNKNOWN, never retry. */
  commit(request: BrokerEffectRequest,ticket: string,challengeNonce: string):
    Promise<BrokerEffectReceipt | null>;
  /**
   * Authenticated proof verification using pinned external authority identity.
   * Caller-supplied fields/proofs must not satisfy this in production.
   */
  verifyReceipt(receipt: BrokerEffectReceipt): Promise<boolean>;
  /** Protected synchronous OS evidence at the exact callback boundary. */
  readVerifiedBindingNow(): BrokerVerifiedEffectBinding | null;
}

export class BrokerEffectAdmissionDenied extends Error {
  readonly code = 'BROKER_EFFECT_ADMISSION_REQUIRED';
  constructor() {
    super('BROKER_EFFECT_ADMISSION_REQUIRED');
    this.name = 'BrokerEffectAdmissionDenied';
  }
}

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VALID_ID=/^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,191}$/;
const SHA=/^[0-9a-f]{64}$/;
const TICKET=/^[a-zA-Z0-9_-]{24,256}$/;
const MAX_FUTURE_MS=30_000;
function deny(): never {throw new BrokerEffectAdmissionDenied();}

function bindingValid(b:BrokerVerifiedEffectBinding|null|undefined):
  b is BrokerVerifiedEffectBinding {
  if(!b || typeof b!=='object')return false;
  for(const key of ['authorityId','ownerId','deviceId','sessionId',
    'highTokenProofId','protectedBrokerProofId'] as const) {
    if(typeof b[key]!=='string'||!VALID_ID.test(b[key]))return false;
  }
  for(const key of ['ownerEpoch','deviceEpoch','sessionEpoch','generation'] as const){
    if(!Number.isSafeInteger(b[key])||b[key]<1)return false;
  }
  const now=Date.now();
  return Number.isSafeInteger(b.expiresAtMs) &&
    b.expiresAtMs>now && b.expiresAtMs-now<=MAX_FUTURE_MS;
}
function sameBinding(a:BrokerVerifiedEffectBinding,b:BrokerVerifiedEffectBinding):boolean {
  return a.authorityId===b.authorityId && a.ownerId===b.ownerId &&
    a.deviceId===b.deviceId && a.sessionId===b.sessionId &&
    a.ownerEpoch===b.ownerEpoch && a.deviceEpoch===b.deviceEpoch &&
    a.sessionEpoch===b.sessionEpoch && a.generation===b.generation &&
    a.highTokenProofId===b.highTokenProofId &&
    a.protectedBrokerProofId===b.protectedBrokerProofId &&
    a.expiresAtMs===b.expiresAtMs;
}
/** Freeze exact request bytes before the first await. No post-hash mutation. */
function frozenEffectInput(capability:string,input:unknown):
  {readonly input:unknown;readonly inputSha256:string} {
  if(typeof capability!=='string'||capability.length<1||capability.length>128)deny();
  let json: string | undefined;
  try{json=JSON.stringify({capability,input})}catch{deny()}
  if(!json || Buffer.byteLength(json,'utf8')>4*1024*1024)deny();
  let snapshot: {capability?:unknown;input?:unknown};
  try{snapshot=JSON.parse(json) as typeof snapshot}catch{deny()}
  if(snapshot.capability!==capability || !Object.hasOwn(snapshot,'input'))deny();
  const freeze=(v:unknown,depth:number):void=>{
    if(depth>64)deny();
    if(v && typeof v==='object'){
      for(const item of Object.values(v))freeze(item,depth+1);
      Object.freeze(v);
    }
  };
  freeze(snapshot.input,0);
  return {input:snapshot.input,
    inputSha256:createHash('sha256').update(json).digest('hex')};
}
function receiptMatches(receipt:BrokerEffectReceipt|null,
  state:'RESERVED'|'COMMITTED',req:BrokerEffectRequest,
  challengeNonce:string,expectedTicket?:string):receipt is BrokerEffectReceipt {
  if(!receipt || typeof receipt!=='object')return false;
  return receipt.state===state && receipt.operationId===req.operationId &&
    receipt.capability===req.capability && receipt.inputSha256===req.inputSha256 &&
    SHA.test(receipt.challengeNonce) && receipt.challengeNonce===challengeNonce &&
    TICKET.test(receipt.ticket) && (!expectedTicket||receipt.ticket===expectedTicket) &&
    typeof receipt.proof==='string' && receipt.proof.length>=24 &&
    receipt.proof.length<=8192 && bindingValid(receipt.binding) &&
    sameBinding(req.binding,receipt.binding);
}

/**
 * Exactly ONE effect callback. #03 must call this function separately for
 * EVERY real side-effect step with a NEW stable operation UUID. A single
 * outer gate is NOT a multi-step execution sandbox.
 *
 * Nonces follow #923 revoke and #925 grant-CAS 256-bit challenge/echo wire
 * convention, but are separate and cannot be used as revoke/grant proofs.
 */
export async function invokeBrokerEffectOnce<T>(
  authority:BrokerExternalEffectAdmission|undefined,
  operationId:unknown,capability:string,input:unknown,
  execute:(verifiedInput:unknown)=>T|Promise<T>,
  verifyWindowsElevationNow:()=>boolean,
):Promise<T>{
  if(!authority||typeof operationId!=='string'||!UUID.test(operationId))deny();
  // Anchor admission to elapsed monotonic time BEFORE any remote await.
  // A frozen or backwards wall clock must never extend a signed permit.
  let startedNs:bigint;
  let startedAtMs:number;
  try{startedNs=process.hrtime.bigint();startedAtMs=Date.now()}catch{deny()}
  if(typeof startedNs!=='bigint'||startedNs<0n||
     !Number.isSafeInteger(startedAtMs)||startedAtMs<=0)deny();
  const captured=frozenEffectInput(capability,input);
  if(!SHA.test(captured.inputSha256))deny();
  let first:BrokerVerifiedEffectBinding|null;
  try{first=await authority.readVerifiedBinding()}catch{deny()}
  if(!bindingValid(first))deny();
  // Use the ORIGINAL wall-time budget, capped at the 30 s binding limit.
  // Do not refresh the budget after begin/commit/readback awaits.
  const remainingMs=Math.min(MAX_FUTURE_MS,first.expiresAtMs-startedAtMs);
  if(!Number.isSafeInteger(remainingMs)||remainingMs<=0)deny();
  const budgetNs=BigInt(remainingMs)*1_000_000n;
  let lastNs=startedNs;
  const assertMonotonicFresh=():void=>{
    let nowNs:bigint;
    try{nowNs=process.hrtime.bigint()}catch{deny()}
    if(typeof nowNs!=='bigint'||nowNs<lastNs||
       nowNs-startedNs>=budgetNs)deny();
    lastNs=nowNs;
  };
  assertMonotonicFresh();
  const binding=Object.freeze({...first});
  const request:BrokerEffectRequest=Object.freeze({
    operationId,capability,inputSha256:captured.inputSha256,binding,
  });
  const reserveNonce=randomBytes(32).toString('hex');
  let reserved:BrokerEffectReceipt|null;
  try{reserved=await authority.begin(request,reserveNonce)}catch{deny()}
  assertMonotonicFresh();
  if(!receiptMatches(reserved,'RESERVED',request,reserveNonce))deny();
  try{if(await authority.verifyReceipt(reserved)!==true)deny()}catch{deny()}
  assertMonotonicFresh();
  const ticket=reserved.ticket;
  const commitNonce=randomBytes(32).toString('hex');
  let committed:BrokerEffectReceipt|null;
  try{committed=await authority.commit(request,ticket,commitNonce)}catch{deny()}
  assertMonotonicFresh();
  if(!receiptMatches(committed,'COMMITTED',request,commitNonce,ticket))deny();
  try{if(await authority.verifyReceipt(committed)!==true)deny()}catch{deny()}
  assertMonotonicFresh();
  let recent:BrokerVerifiedEffectBinding|null;
  try{recent=await authority.readVerifiedBinding()}catch{deny()}
  assertMonotonicFresh();
  if(!bindingValid(recent)||!sameBinding(binding,recent))deny();
  // Elevation probe may synchronously spawn Windows tooling and take seconds.
  // Run it BEFORE the last protected readback, never after it. No await or
  // slow OS operation may separate the fresh authority state from callback.
  try{if(verifyWindowsElevationNow()!==true)deny()}catch{deny()}
  assertMonotonicFresh();
  let immediate:BrokerVerifiedEffectBinding|null;
  try{immediate=authority.readVerifiedBindingNow()}catch{deny()}
  if(!bindingValid(immediate)||!sameBinding(binding,immediate))deny();
  assertMonotonicFresh();
  return execute(captured.input);
}
