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


/**
 * #03 executor-side routing boundary for CORE/Broker task subprocesses.
 * #07's current task-os-sandbox-capability/worker is SOURCE-ONLY and has
 * launchAllowed=false; the accepted native sandbox launcher/attestation
 * interface does not exist. Do not convert a signed CORE grant into a shell
 * token or fall back to a current-user Node spawn, WSL or nested task graph.
 *
 * A top-level graph/runbook approval is not approval for its individual OS
 * effects (each job, artifact write, subprocess and retry). Future #07 must
 * admit each separate effect under an independent immutable request ID and
 * prove the low-privilege token, descendants, resource/IO/network confinement,
 * revoke/drain and no-replay before the launcher can resume any process.
 */
export const CORE_SANDBOX_REQUIRED_CAPABILITIES:ReadonlySet<string>=new Set([
  'shell.exec','wsl.exec','process.start','process.write',
  'task.graph.run','runbook.run','workspace.checks',
  'workspace.snapshot','workspace.detect',
]);

/**
 * A privileged-Broker route or any attached CORE dispatch candidate is never
 * allowed to silently reach legacy raw spawn without the independent #07
 * provider. A caller can request denial but cannot supply authority by
 * setting a UI flag or by injecting a fixture.
 *
 * Other legacy non-CORE paths remain unchanged; #04/#02 still MUST ensure
 * authentic CORE traffic is tagged as such at the protected entry point.
 */
export function assertCoreSandboxRouteUnavailable(
  capability:string,
  coreOrBrokerRouted:boolean,
):void{
  if(coreOrBrokerRouted && CORE_SANDBOX_REQUIRED_CAPABILITIES.has(capability))
    deny('OS_TASK_SANDBOX_UNAVAILABLE');
}

/**
 * #02's BrokerEffectRequest/operationId and #01's signed dispatch request are
 * NOT interchangeable: #919 reserves an effect ticket but #926 binds signed
 * receipts, nonce and monotonic deadlines. This source-only #03 compatibility
 * guard will not accept a #919 ticket as a #01 signed permit.
 *
 * Each OS callback (including installer/update stages) requires one native
 * protected Broker admission with a separate stable per-effect request UUID.
 * Reconcile UNKNOWN by observation only; never run a retry callback.
 */
export function assertNoSyntheticBrokerAdmission(
  _brokerTicket:unknown,
):never{
  return deny('CORE_BROKER_NATIVE_EFFECT_PROVIDER_UNAVAILABLE');
}
