/**
 * #03: shared execution boundary for CORE Windows side effects.
 * This code is inert in production until the native protected Broker,
 * independent CAS provider and owner enrollment are separately accepted.
 * A bearer token, FULL UI state or caller-provided fixture is never admission.
 */
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {types as nodeTypes} from 'node:util';
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

/**
 * Encode ONLY JSON data. The input is untrusted and may contain getters,
 * sparse arrays, circular references or post-admission mutable objects.
 * Never invoke accessor properties to discover what is being authorized.
 */
function canonical(value:unknown,ancestors=new Set<object>()):string {
  if(value===null||typeof value==='string'||typeof value==='boolean')
    return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))
    return JSON.stringify(value);
  if(typeof value!=='object')deny('CORE_DISPATCH_INPUT_NOT_CANONICAL');
  if(nodeTypes.isProxy(value))deny('CORE_DISPATCH_INPUT_NOT_CANONICAL');
  if(ancestors.has(value))deny('CORE_DISPATCH_INPUT_NOT_CANONICAL');
  const proto=Object.getPrototypeOf(value);
  if(!Array.isArray(value)&&proto!==Object.prototype&&proto!==null)
    deny('CORE_DISPATCH_INPUT_NOT_CANONICAL');
  ancestors.add(value);
  try{
    const descriptors=Object.getOwnPropertyDescriptors(value);
    const keys=Reflect.ownKeys(value);
    if(keys.some(key=>typeof key!=='string'))
      deny('CORE_DISPATCH_INPUT_NOT_CANONICAL');
    if(Array.isArray(value)){
      if(proto!==Array.prototype||!Number.isSafeInteger(value.length))
        deny('CORE_DISPATCH_INPUT_NOT_CANONICAL');
      if(keys.length!==value.length+1)
        deny('CORE_DISPATCH_INPUT_NOT_CANONICAL');
      const items:string[]=[];
      for(let i=0;i<value.length;i++){
        const item=descriptors[String(i)];
        if(!item||!('value' in item))
          deny('CORE_DISPATCH_INPUT_NOT_CANONICAL');
        items.push(canonical(item.value,ancestors));
      }
      return '['+items.join(',')+']';
    }
    return '{'+(keys as string[]).sort().map(key=>{
      const item=descriptors[key];
      if(!item||!('value' in item))
        deny('CORE_DISPATCH_INPUT_NOT_CANONICAL');
      return JSON.stringify(key)+':'+canonical(item.value,ancestors);
    }).join(',')+'}';
  }finally{ancestors.delete(value)}
}

function frozenJsonCopy<T>(value:T):T{
  // JSON.parse creates an independent tree even when the caller later mutates
  // the original object while remote CAS and native readbacks are awaited.
  const result=JSON.parse(canonical(value)) as T;
  const freeze=(item:unknown):void=>{
    if(item===null||typeof item!=='object')return;
    if(Array.isArray(item)){
      for(const child of item)freeze(child);
    }else{
      // A null prototype prevents inherited toJSON methods from changing the
      // exact bytes that PrivilegedBrokerClient.execute will serialize.
      Object.setPrototypeOf(item,null);
      for(const child of Object.values(item))freeze(child);
    }
    Object.freeze(item);
  };
  freeze(result);
  return result;
}

export interface PreparedCoreWindowsMutation {
  readonly capability:string;
  readonly input:unknown;
  readonly fingerprint:string;
  /** Exact JSON that the legacy Broker client will serialize on /execute. */
  readonly brokerBody:string;
}

/**
 * Snapshot BEFORE any async CAS. One immutable value supplies the fingerprint
 * and the exact capability/input sent to #02's separate Broker admission.
 * No caller-owned input reference survives in the callback.
 */
export function prepareCoreWindowsMutation(
  capability:string,input:unknown,
):PreparedCoreWindowsMutation{
  if(typeof capability!=='string'||capability.length<1||
     capability.length>128)deny('CORE_DISPATCH_CAPABILITY_INVALID');
  const snapshot=frozenJsonCopy(input);
  const brokerBody=canonical({capability,input:snapshot});
  if(Buffer.byteLength(brokerBody,'utf8')>4*1024*1024)
    deny('CORE_DISPATCH_INPUT_TOO_LARGE');
  if(JSON.stringify({capability,input:snapshot})!==brokerBody)
    deny('CORE_DISPATCH_WIRE_FINGERPRINT_MISMATCH');
  return Object.freeze({capability,input:snapshot,
    fingerprint:createHash('sha256').update(brokerBody).digest('hex'),
    brokerBody});
}

/** Bind the same exact JSON bytes the Broker client sends over the wire. */
export function coreWindowsEffectFingerprint(
  capability:string,input:unknown,
):string{
  return prepareCoreWindowsMutation(capability,input).fingerprint;
}

/**
 * A frozen object may still contain an accessor property. Treat only exact
 * own enumerable data descriptors as an authenticated callback payload.
 * Reject Proxy wrappers before any reflective operation executes traps.
 */
function assertFrozenPlainDispatchRecord(
  value:unknown,fields:readonly string[],
):void{
  if(!value||typeof value!=='object'||Array.isArray(value)||
     nodeTypes.isProxy(value))
    deny('CORE_DISPATCH_APPROVED_REQUEST_MISMATCH');
  let descriptors:PropertyDescriptorMap;
  let keys:PropertyKey[];
  let prototype:unknown;
  try{
    descriptors=Object.getOwnPropertyDescriptors(value);
    keys=Reflect.ownKeys(value);
    prototype=Object.getPrototypeOf(value);
  }catch{return deny('CORE_DISPATCH_APPROVED_REQUEST_MISMATCH')}
  if((prototype!==Object.prototype&&prototype!==null)||
     keys.length!==fields.length||
     fields.some(key=>!Object.prototype.hasOwnProperty.call(descriptors,key)||
       !('value' in descriptors[key]!)||
       descriptors[key]!.enumerable!==true)||
     !Object.isFrozen(value))
    deny('CORE_DISPATCH_APPROVED_REQUEST_MISMATCH');
}

/**
 * #947's detached and frozen approved request is the only post-CAS source of
 * identity. #916's older #910 fence has no approved callback argument: if
 * called with that older implementation, deny rather than use a mutable
 * caller-owned request or run a privileged effect.
 */
export function assertCoreApprovedDispatchRequest(
  approved:BrokerDispatchRequest|undefined,
  expected:Readonly<BrokerDispatchRequest>,
  prepared:PreparedCoreWindowsMutation,
):void{
  if(!approved)deny('CORE_DISPATCH_APPROVED_REQUEST_MISMATCH');
  assertFrozenPlainDispatchRecord(approved,
    ['requestId','capability','fingerprint','scope']);
  assertFrozenPlainDispatchRecord(approved!.scope,
    ['ownerId','deviceId','deviceEpoch','sessionEpoch','ownerEpoch',
      'expectedGeneration','requiredPrivilege']);
  if(approved!.requestId!==expected.requestId||
     approved.capability!==prepared.capability||
     approved.fingerprint!==prepared.fingerprint||
     expected.capability!==prepared.capability||
     expected.fingerprint!==prepared.fingerprint)
    deny('CORE_DISPATCH_APPROVED_REQUEST_MISMATCH');
  const a=approved.scope,b=expected.scope;
  if(a.ownerId!==b.ownerId||a.deviceId!==b.deviceId||
     a.deviceEpoch!==b.deviceEpoch||a.sessionEpoch!==b.sessionEpoch||
     a.ownerEpoch!==b.ownerEpoch||a.expectedGeneration!==b.expectedGeneration||
     a.requiredPrivilege!==b.requiredPrivilege)
    deny('CORE_DISPATCH_APPROVED_REQUEST_MISMATCH');
  if(!Object.isFrozen(prepared.input) && typeof prepared.input==='object' &&
     prepared.input!==null)
    deny('CORE_DISPATCH_INPUT_NOT_IMMUTABLE');
  if(JSON.stringify({capability:prepared.capability,input:prepared.input})!==
     prepared.brokerBody||
     createHash('sha256').update(prepared.brokerBody).digest('hex')!==
       prepared.fingerprint)
    deny('CORE_DISPATCH_WIRE_FINGERPRINT_MISMATCH');
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
  run:(immutableApprovedInput:unknown)=>Promise<T>,
):Promise<T>{
  if(!CORE_EXECUTOR_DISPATCH_ENABLED)
    deny('CORE_EXECUTOR_DISPATCH_NOT_INSTALLED');
  if(!admission||!(admission.fence instanceof BrokerExternalDispatchFence))
    deny('CORE_DISPATCH_TRUSTED_FENCE_REQUIRED');
  // All input and scope snapshots happen synchronously BEFORE the first CAS
  // await. The source input object may change afterwards without affecting
  // the approved bytes or the Broker callback.
  const prepared=prepareCoreWindowsMutation(capability,input);
  const source=admission.request;
  if(!source||!source.scope)deny('CORE_DISPATCH_REQUEST_BINDING_MISMATCH');
  const request=Object.freeze({
    requestId:source.requestId,capability:source.capability,
    fingerprint:source.fingerprint,scope:Object.freeze({...source.scope}),
  }) as BrokerDispatchRequest;
  if(request.scope.requiredPrivilege!=='CORE'||
     request.capability!==prepared.capability||
     request.fingerprint!==prepared.fingerprint||
     privilegeRequirement(capability,prepared.input)!=='elevated')
    deny('CORE_DISPATCH_REQUEST_BINDING_MISMATCH');
  // #947 forwards the detached, frozen approved request to the callback.
  // #910 does not. A missing approved request cannot authorize an effect.
  return await admission.fence.execute(request,async(
    approved?:BrokerDispatchRequest,
  )=>{
    assertCoreApprovedDispatchRequest(approved,request,prepared);
    const state:ActiveEffect={capability:prepared.capability,
      fingerprint:prepared.fingerprint,active:true};
    try{
      return await activeEffect.run(state,()=>run(prepared.input));
    }finally{state.active=false}
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
 * CORE authority is not a blanket Windows GUI, file, update, or process
 * mutation permit. A shell/graph can also hide arbitrarily many writes.
 * No #02 native per-effect callback is installed for these #03 routes.
 * Keep the separate owner-console/private-GUI checks; this denies earlier.
 */
export const CORE_OTHER_UNADMITTED_EFFECT_CAPABILITIES:ReadonlySet<string>=new Set([
  'files.write','files.mkdir','files.copy','files.move','files.delete',
  'files.patch','nexowire.update.apply','process.stop','process.prune',
  // Even HKCU/user/process-scoped writes are effects; CORE is not an
  // exemption from per-effect provenance just because OS elevation is absent.
  'windows.registry.set','windows.registry.delete',
  'windows.environment.set','windows.environment.delete',
  'task.graph.prune','runbook.prune',
  'windows.window.focus','windows.clipboard.write','windows.clipboard.clear',
  'windows.keyboard.type','windows.keyboard.hotkey',
  'windows.accessibility.invoke','windows.accessibility.set_value',
  'windows.pointer.move','windows.pointer.click','windows.pointer.scroll',
  'windows.virtual_pointer.start','windows.virtual_pointer.move',
  'windows.virtual_pointer.style','windows.virtual_pointer.visibility',
  'windows.private_display.profile.set','windows.private_display.profile.reset',
  'windows.private_clipboard.write','windows.private_clipboard.clear',
  'windows.private_clipboard.paste',
  'windows.private_desktop.start','windows.private_desktop.launch',
  'windows.private_desktop.window.close','windows.private_desktop.show',
  'windows.private_pointer.move','windows.private_pointer.click',
  'windows.private_pointer.scroll','windows.private_keyboard.type',
  'windows.private_keyboard.hotkey',
  'windows.private_desktop.accessibility.invoke_button',
  'windows.private_desktop.accessibility.set_edit_value',
  'windows.private_desktop.accessibility.set_checkbox',
  'windows.private_desktop.accessibility.select_radio',
]);

export function assertCoreOtherNativeEffectUnavailable(
  capability:string,
  coreOrBrokerRouted:boolean,
  input?:unknown,
):void{
  // Privileged registry/machine-environment writes already have the stricter
  // native guard and existing exact error codes. Non-elevated variants must
  // not bypass CORE just because HKCU/user/process needs no HIGH token.
  const separatelyFenced=('windows.registry.set'===capability||
    'windows.registry.delete'===capability||
    'windows.environment.set'===capability||
    'windows.environment.delete'===capability) &&
    privilegeRequirement(capability,input)==='elevated';
  if(coreOrBrokerRouted && !separatelyFenced &&
     CORE_OTHER_UNADMITTED_EFFECT_CAPABILITIES.has(capability))
    deny('CORE_NATIVE_EFFECT_ADMISSION_REQUIRED');
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
