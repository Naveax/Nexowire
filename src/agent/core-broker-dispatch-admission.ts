import {createHash} from 'node:crypto';
import type {
  BrokerDispatchRequest,
} from './broker-external-dispatch-fence.js';
import {BrokerExternalDispatchFence} from './broker-external-dispatch-fence.js';

/**
 * Production CORE/ROOT effect dispatch is OFF. Do not flip this switch from
 * an HTTP body, health check, feature flag or test fixture. A real enabled
 * build requires physical Broker and independent CAS acceptance.
 */
export const CORE_EXECUTOR_DISPATCH_ENABLED = false;

export interface TrustedCoreBrokerDispatch {
  /** Created in the protected Broker host, never reconstructed from HTTP. */
  readonly fence: BrokerExternalDispatchFence;
  /**
   * Separately authenticate owner/device/session, epoch and grant generation.
   * A bearer token and user-supplied operation metadata are NOT authentication.
   */
  readonly resolveAuthenticatedRequest: (
    capability:string, input:unknown, fingerprint:string,
  ) => Promise<BrokerDispatchRequest>;
}

function blocked(code:string):never {
  throw Object.assign(new Error(code),{code});
}

/**
 * Bind immutable execution bytes to the CAS request's signed fingerprint.
 * This does not supply authentication; the trusted resolver and remote
 * authority must do that independently.
 */
export function brokerEffectFingerprint(capability:string,input:unknown):string {
  const encoded=JSON.stringify({capability,input});
  if(typeof encoded!=='string'||Buffer.byteLength(encoded,'utf8')>4*1024*1024)
    blocked('CORE_DISPATCH_INPUT_INVALID');
  return createHash('sha256').update(encoded).digest('hex');
}

/**
 * Isolated integration seam: a *signed*, externally committed, single-use
 * CAS admission wraps the actual OS-effect callback. Tests may supply a
 * synthetic authority, which is NEVER evidence of production authority.
 *
 * Callbacks are invoked synchronously as the fence's run() callback after
 * its final native-HIGH re-read. The effect must not perform any unrelated
 * asynchronous wait before the OS mutation.
 */
export async function executeAdmittedCoreBrokerEffect<T>(
  trusted:TrustedCoreBrokerDispatch,
  capability:string,
  input:unknown,
  effect:()=>Promise<T>,
):Promise<T> {
  if(!trusted || !(trusted.fence instanceof BrokerExternalDispatchFence)||
     typeof trusted.resolveAuthenticatedRequest!=='function')
    blocked('CORE_DISPATCH_TRUSTED_PROVIDER_UNAVAILABLE');
  const fingerprint=brokerEffectFingerprint(capability,input);
  let operation:BrokerDispatchRequest;
  try {
    operation=await trusted.resolveAuthenticatedRequest(
      capability,input,fingerprint);
  } catch {
    return blocked('CORE_DISPATCH_IDENTITY_UNAVAILABLE');
  }
  if(!operation||operation.capability!==capability||
     operation.fingerprint!==fingerprint||
     !operation.scope||
     !['CORE','ROOT'].includes(operation.scope.requiredPrivilege))
    blocked('CORE_DISPATCH_REQUEST_SCOPE_MISMATCH');
  // The #01 fence validates every scope/epoch/generation against signed
  // external begin+commit receipts, refreshes native HIGH before the effect,
  // fences UNKNOWN/revoke, and never retries an OS effect.
  return trusted.fence.execute(operation,effect);
}

/**
 * The only supported path for legacy /execute elevated effects.
 * This intentionally refuses even a plausible injected test provider while
 * physical CORE is disabled. Server code must NEVER call effect directly.
 */
export async function executeServerCoreBrokerMutation<T>(
  trusted:TrustedCoreBrokerDispatch|undefined,
  capability:string,
  input:unknown,
  effect:()=>Promise<T>,
):Promise<T> {
  if(!CORE_EXECUTOR_DISPATCH_ENABLED)
    blocked('CORE_ELEVATED_DISPATCH_DISABLED');
  if(!trusted)
    blocked('CORE_DISPATCH_TRUSTED_PROVIDER_UNAVAILABLE');
  return executeAdmittedCoreBrokerEffect(trusted,capability,input,effect);
}
