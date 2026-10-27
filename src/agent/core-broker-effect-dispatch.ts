import {createHash} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import {
  BrokerExternalDispatchFence,
  type BrokerDispatchRequest,
} from './broker-external-dispatch-fence.js';

/**
 * #03 native Broker effect seam. This dependency must be constructed INSIDE
 * the protected Broker with an authenticated Windows/owner-session provider.
 * HTTP body fields, a bearer token, UI flags, and a signed fixture are never
 * a trusted resolver. Until that provider exists this stays unconfigured.
 */
export interface ProtectedBrokerEffectDispatch {
  readonly fence:BrokerExternalDispatchFence;
  /** Request ID and grant scope must come from authenticated Broker-side IPC,
   * not caller JSON, cookies, HTTP headers, or user controlled process.env.
   * The #01 fence additionally verifies identity, a fresh native HIGH image/
   * ACL readback, signed receipts, and remote begin+commit.
   */
  readonly resolveAuthenticatedRequest:
    (transport:IncomingMessage)=>Promise<BrokerDispatchRequest>;
}

export class CoreBrokerEffectDeniedError extends Error {
  readonly name='CoreBrokerEffectDeniedError';
  constructor(readonly code:string){
    super(code);
  }
}

/** Unambiguous binding between the *executed* capability/input pair and the
 * exact signed external-CAS request fingerprint. Only JSON values arrive at
 * the Broker /execute endpoint. No lossy String(input) coercion.
 */
export function brokerEffectFingerprint(capability:string,input:unknown):string{
  const serialized=JSON.stringify({capability,input});
  if(typeof serialized!=='string'){
    throw new CoreBrokerEffectDeniedError('CORE_EFFECT_INPUT_UNSERIALIZABLE');
  }
  return createHash('sha256').update(serialized,'utf8').digest('hex');
}

/**
 * The SINGLE effect callback boundary used by the legacy /execute Broker
 * route. Missing external provider is always a hard deny (not legacy fallback).
 * #01 fence owns online begin+commit, fresh native evidence readback before
 * callback, revoked/UNKNOWN fencing and scoped release/no replay semantics.
 *
 * A successful local fixture is not a deployed monotonic witness or Windows
 * token attestation. CORE_EXECUTOR_DISPATCH_ENABLED remains OFF.
 */
export async function executeProtectedBrokerEffect<T>(
  dispatch:ProtectedBrokerEffectDispatch|undefined,
  transport:IncomingMessage,
  capability:string,
  input:unknown,
  effect:()=>Promise<T>,
):Promise<T>{
  if(!dispatch || !(dispatch.fence instanceof BrokerExternalDispatchFence) ||
     typeof dispatch.resolveAuthenticatedRequest!=='function'){
    throw new CoreBrokerEffectDeniedError('CORE_EXTERNAL_CAS_DISPATCH_REQUIRED');
  }
  const fingerprint=brokerEffectFingerprint(capability,input);
  let request:BrokerDispatchRequest;
  try{
    request=await dispatch.resolveAuthenticatedRequest(transport);
  }catch{
    throw new CoreBrokerEffectDeniedError('CORE_AUTHENTICATED_INTENT_UNAVAILABLE');
  }
  if(!request || request.capability!==capability ||
     request.fingerprint!==fingerprint){
    throw new CoreBrokerEffectDeniedError('CORE_EFFECT_FINGERPRINT_MISMATCH');
  }
  // No other code path may invoke effect. The #01 fence verifies the scope,
  // current owner grant, native protected Broker identity and both CAS stages.
  return await dispatch.fence.execute(request,effect);
}
