/**
 * #03: shared execution boundary for CORE Windows side effects.
 * This code is inert in production until the native protected Broker,
 * independent CAS provider and owner enrollment are separately accepted.
 * A bearer token, FULL UI state or caller-provided fixture is never admission.
 */
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {BrokerExternalDispatchFence,type BrokerDispatchRequest}
  from './broker-external-dispatch-fence.js';
import {privilegeRequirement} from '../security/privilege.js';

/** P0 HARD STOP. Do not turn on without physical native Broker acceptance. */
export const CORE_EXECUTOR_DISPATCH_ENABLED = false;

export interface CoreWindowsDispatchAdmission {
  /** Trusted native Broker-side fence, not parsed from JSON or a UI flag. */
  fence: BrokerExternalDispatchFence;
  /** Independently bound owner/device/session epochs, generation and UUID. */
  request: BrokerDispatchRequest;
}

interface ActiveEffect {
  capability: string;
  fingerprint: string;
  active: boolean;
}
const activeEffect = new AsyncLocalStorage<ActiveEffect>();

function deny(code:string):never{
  throw Object.assign(new Error(code),{code});
}

function canonical(value:unknown):string {
  if(value===null||typeof value==='string'||typeof value==='boolean') {
    return JSON.stringify(value);
  }
  if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(typeof value==='object'&&value!==null&&
     Object.getPrototypeOf(value)===Object.prototype){
    const obj=value as Record<string,unknown>;
    return '{'+Object.keys(obj).filter(key=>obj[key]!==undefined).sort()
      .map(key=>JSON.stringify(key)+':'+canonical(obj[key])).join(',')+'}';
  }
  deny('CORE_DISPATCH_INPUT_NOT_CANONICAL');
}

/** Bind exactly the capability and parsed JSON input to the remote CAS claim. */
export function coreWindowsEffectFingerprint(
  capability:string,input:unknown,
):string{
  if(typeof capability!=='string'||capability.length<1||
     capability.length>128)deny('CORE_DISPATCH_CAPABILITY_INVALID');
  return createHash('sha256').update(canonical({capability,input})).digest('hex');
}

/**
 * Called inside native Windows mutation executors. No legacy bearer-only
 * caller can manufacture the private async admission scope.
 * Async work spawned but not awaited loses permission when run() settles.
 */
export function assertCoreWindowsMutationAdmission(
  capability:string,input:unknown,
):void{
  if(privilegeRequirement(capability,input)!=='elevated')return;
  const state=activeEffect.getStore();
  if(!CORE_EXECUTOR_DISPATCH_ENABLED||
     !state?.active||state.capability!==capability||
     state.fingerprint!==coreWindowsEffectFingerprint(capability,input)){
    deny('CORE_DISPATCH_EXTERNAL_ADMISSION_REQUIRED');
  }
}

/**
 * The ONLY #03 entry to an elevated CORE callback.
 * Fence.execute requires signed external CAS begin+commit, fresh owner
 * identity and native HIGH/image/ACL readback; callback cannot run on
 * revoked, expired, UNKNOWN, lost ACK or stale HIGH proofs.
 * Never retry the native callback when remote outcome is unknown.
 */
export async function executeCoreWindowsMutation<T>(
  capability:string,input:unknown,
  admission:CoreWindowsDispatchAdmission|undefined,
  run:()=>Promise<T>,
):Promise<T>{
  if(!CORE_EXECUTOR_DISPATCH_ENABLED)
    deny('CORE_EXECUTOR_DISPATCH_NOT_INSTALLED');
  if(!admission||!(admission.fence instanceof BrokerExternalDispatchFence))
    deny('CORE_DISPATCH_TRUSTED_FENCE_REQUIRED');
  const request=admission.request;
  if(!request||request.scope?.requiredPrivilege!=='CORE'||
     request.capability!==capability||
     request.fingerprint!==coreWindowsEffectFingerprint(capability,input)||
     privilegeRequirement(capability,input)!=='elevated')
    deny('CORE_DISPATCH_REQUEST_BINDING_MISMATCH');
  return await admission.fence.execute(request,async()=>{
    const state:ActiveEffect={capability,
      fingerprint:request.fingerprint,active:true};
    try{return await activeEffect.run(state,run)}
    finally{state.active=false}
  });
}
