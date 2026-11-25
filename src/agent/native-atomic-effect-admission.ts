/** Native-side effect admission, never supplied by Hub or WebSocket JSON.
 * The injected provider must be a protected, independent OS/authority client;
 * this module does not implement or claim such a provider.
 */
import {createHash} from 'node:crypto';
import {types as utilTypes} from 'node:util';
import {executeNativeMutationOnce, MutationAuthorityDenied,
  type AtomicMutationAuthority, type MutationReservation} from '../core/atomic-mutation-authority.js';

export interface TrustedNativeMutationProvider {
  authority: AtomicMutationAuthority;
  /** Must authenticate the exact request against an independent durable CAS. */
  resolveTrustedReservation(input: Readonly<{
    deviceId: string; requestId: string; capability: string; wireSha256: string;
  }>, signal: AbortSignal): Promise<MutationReservation | undefined>;
}

const permitKeys=['authorityId','reservationId','created','ownerId','deviceId','authorizationEpoch',
  'leaseExpiresAtMs','requestId','capability','fingerprint'] as const;
/** Snapshot only plain data from the protected reader. An accessor, Proxy or
 * extra field must not alter the reservation across the admission await. */
function snapshotPermit(raw:unknown):Readonly<MutationReservation>|undefined{
  if(!raw||typeof raw!=='object'||utilTypes.isProxy(raw))return undefined;
  const proto=Object.getPrototypeOf(raw);
  if(proto!==Object.prototype&&proto!==null)return undefined;
  const fields=Object.getOwnPropertyDescriptors(raw);
  if(Reflect.ownKeys(fields).length!==permitKeys.length)return undefined;
  const out:Record<string,unknown>=Object.create(null);
  for(const key of permitKeys){
    const d=fields[key];if(!d||!('value' in d))return undefined;out[key]=d.value;
  }
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if(typeof out.reservationId!=='string'||!uuid.test(out.reservationId)||out.created!==true||
    typeof out.requestId!=='string'||!uuid.test(out.requestId)||
    typeof out.ownerId!=='string'||typeof out.deviceId!=='string'||typeof out.authorityId!=='string'||
    [out.ownerId,out.deviceId,out.authorityId].some(x=>! /^[A-Za-z0-9][A-Za-z0-9_.:@-]{1,127}$/.test(x as string))||
    typeof out.capability!=='string'||out.capability.length<1||out.capability.length>128||
    typeof out.fingerprint!=='string'||! /^[a-f0-9]{64}$/.test(out.fingerprint)||
    typeof out.authorizationEpoch!=='number'||!Number.isSafeInteger(out.authorizationEpoch)||
    typeof out.leaseExpiresAtMs!=='number'||!Number.isSafeInteger(out.leaseExpiresAtMs))return undefined;
  return Object.freeze(out) as unknown as Readonly<MutationReservation>;
}

export async function executeTrustedNativeMutation<T>(
  input: Readonly<{
    provider?: TrustedNativeMutationProvider;
    deviceId: string; requestId: string; capability: string;
    exactFrame: string; signal?: AbortSignal;
    timeoutMs?: number;
  }>,
  effect: () => Promise<T>,
): Promise<T> {
  if (!input.provider || !input.provider.authority ||
      typeof input.provider.resolveTrustedReservation !== 'function') {
    throw new MutationAuthorityDenied('NATIVE_MUTATION_AUTHORITY_UNAVAILABLE');
  }
  if (input.signal?.aborted) {
    throw new MutationAuthorityDenied('NATIVE_MUTATION_REQUEST_ABORTED');
  }
  const timeout = input.timeoutMs ?? 3_000;
  if (!Number.isSafeInteger(timeout) || timeout < 250 || timeout > 10_000) {
    throw new MutationAuthorityDenied('NATIVE_MUTATION_TIMEOUT_INVALID');
  }
  const {provider,deviceId,requestId,capability,signal}=input;
  const wireSha256 = createHash('sha256').update(input.exactFrame,'utf8').digest('hex');
  const authority=provider.authority,resolveReservation=provider.resolveTrustedReservation.bind(provider);
  const ctrl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const abort = () => ctrl.abort();
  input.signal?.addEventListener('abort', abort, {once:true});
  try {
    const rawPermit = await Promise.race([
      resolveReservation(Object.freeze({
        deviceId, requestId, capability, wireSha256,
      }),ctrl.signal),
      new Promise<undefined>(resolve => {
        // Referenced timer: no early Node 22 event-loop completion on stalled authority.
        timer = setTimeout(() => {ctrl.abort();resolve(undefined);},timeout);
      }),
    ]);
    if (ctrl.signal.aborted || signal?.aborted) {
      throw new MutationAuthorityDenied('NATIVE_MUTATION_AUTHORITY_UNAVAILABLE');
    }
    const permit=snapshotPermit(rawPermit);
    if (!permit || !permit.created ||
        permit.deviceId !== deviceId ||
        permit.requestId !== requestId ||
        permit.capability !== capability ||
        permit.fingerprint !== wireSha256 ||
        !Number.isSafeInteger(permit.authorizationEpoch) ||
        permit.authorizationEpoch < 1 ||
        !Number.isSafeInteger(permit.leaseExpiresAtMs) ||
        permit.leaseExpiresAtMs <= Date.now() ||
        typeof permit.ownerId !== 'string' || permit.ownerId.length === 0 ||
        typeof permit.authorityId !== 'string' || permit.authorityId.length === 0) {
      throw new MutationAuthorityDenied('NATIVE_MUTATION_RESERVATION_INVALID');
    }
    let result!: T,open=true,entered=false,completed=false,violated=false;
    // The resolution deadline does not authorize native execution. A distinct
    // bounded reservation lease is checked synchronously at the callback.
    clearTimeout(timer);timer=undefined;
    const remaining=permit.leaseExpiresAtMs-Date.now();
    if(remaining<=0||remaining>30000)
      throw new MutationAuthorityDenied('NATIVE_MUTATION_RESERVATION_INVALID');
    const deadline=process.hrtime.bigint()+BigInt(remaining)*1000000n;
    try{
      await executeNativeMutationOnce(authority,permit,async () => {
        if(!open||entered||signal?.aborted||Date.now()>=permit.leaseExpiresAtMs||
          process.hrtime.bigint()>=deadline){
          violated=true;
          throw new MutationAuthorityDenied('NATIVE_MUTATION_CALLBACK_INVALID');
        }
        entered=true;
        result=await effect();
        completed=true;
      });
      if(!entered||!completed||violated)
        throw new MutationAuthorityDenied('NATIVE_MUTATION_EFFECT_NOT_CONFIRMED');
      return result;
    }finally{
      // Any detached late callback remains denied after success/UNKNOWN.
      open=false;
    }
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort',abort);
    ctrl.abort();
  }
}
