import {runNativeAgent} from './native-agent.js';
import {ProtectedRuntimeDrain} from './protected-runtime-drain.js';
import type {TrustedNativeMutationProvider} from './native-atomic-effect-admission.js';
import type {NativeCoreConsentAuthority} from './windows-core-console-provider.js';
import {getWindowsPreloginAgentMode} from './windows-prelogin-bootstrap.js';
import {createWindowsProtectedTransferPublisher,type WindowsProtectedTransferConfig} from './windows-protected-transfer-publisher.js';
import {createWindowsTransferHelperArtifactStore,readVerifiedTransferHelperBinding,type TransferHelperDeploymentAuthority,type TransferHelperArtifactStore} from '../installer/protected-transfer-helper-lifecycle.js';
import {ProtectedTransferAuthorityClient,createProtectedNativeTransferAdmission,type ProtectedTransferAuthorityTlsConfig} from '../security/protected-transfer-authority.js';

import {createHelperSelectionLeaseProvider,type HelperSelectionLeaseTransport} from '../security/postgres-helper-selection-authority.js';
import {ProtectedHelperSelectionClient,type HelperSelectionTlsConfig} from '../security/protected-helper-selection-transport.js';

type Binding=Awaited<ReturnType<typeof readVerifiedTransferHelperBinding>>;
/** Independently protected read lease. The deployment authority must exclude
 * selection changes for the entire callback; deployment must quiesce/stop
 * this runtime before upgrade, detach or rollback. Not a local mutex. */
export interface TransferHelperRuntimeAuthority extends Pick<TransferHelperDeploymentAuthority,'readSelection'> {
  withActiveSelection<T>(effect:(lease:TransferHelperActiveLease)=>Promise<T>):Promise<T>;
}

/** Live read-only witness issued by the same independent deployment
 * authority that serializes #1307 selection commits. Runtime has no commit
 * permission; a local mutex, cached selection or bare callback is insufficient. */
export interface TransferHelperActiveLease {
  readonly signal:AbortSignal;
  assertActive():Promise<void>;
}
export interface VerifiedTransferHelperScope {
  readonly signal:AbortSignal;
  assertActive():Promise<void>;
}

/** Shared with the startup acceptance fixture; the production caller below
 * always constructs the real ACL/AuthentiCode artifact store. */
export async function withVerifiedTransferHelper<T>(authority:TransferHelperRuntimeAuthority,store:TransferHelperArtifactStore,activate:(binding:Binding,scope:VerifiedTransferHelperScope)=>Promise<T>):Promise<T>{
  if(typeof authority?.withActiveSelection!=='function'||typeof authority.readSelection!=='function'||typeof activate!=='function')
    throw Error('TRANSFER_HELPER_RUNTIME_LEASE_REQUIRED');
  let active=true,entered=false,done=false,result!:T;
  const lifetime=new AbortController();
  let unsubscribe:(()=>void)|undefined;
  try{
    await authority.withActiveSelection(async lease=>{
      if(!active||entered)throw Error('TRANSFER_HELPER_RUNTIME_CALLBACK_INVALID');
      entered=true;
      if(!lease||!(lease.signal instanceof AbortSignal)||typeof lease.assertActive!=='function')
        throw Error('TRANSFER_HELPER_RUNTIME_LEASE_WITNESS_REQUIRED');
      const lost=()=>lifetime.abort();
      lease.signal.addEventListener('abort',lost,{once:true});
      unsubscribe=()=>lease.signal.removeEventListener('abort',lost);
      if(lease.signal.aborted)lost();
      const local=()=>{if(!active||lifetime.signal.aborted)throw Error('TRANSFER_HELPER_RUNTIME_LEASE_RELEASED');};
      const scope:VerifiedTransferHelperScope=Object.freeze({signal:lifetime.signal,async assertActive(){
        local();try{await lease.assertActive();}catch(error){lost();throw error;}local();
      }});
      await scope.assertActive();
      const binding=await readVerifiedTransferHelperBinding(authority,store);
      await scope.assertActive();
      result=await activate(binding,scope);
      await scope.assertActive();
      done=true;return result;
    });
    if(!entered||!done)throw Error('TRANSFER_HELPER_RUNTIME_ACTIVATION_UNCONFIRMED');
    return result;
  }finally{active=false;lifetime.abort();unsubscribe?.();}
}
export async function assertSelectedTransferHelper(authority:Pick<TransferHelperRuntimeAuthority,'readSelection'>,binding:Binding){
  const current=await authority.readSelection();
  if(!current||current.revision!==binding.revision||current.pin?.sha256!==binding.flushHelperSha256||current.pin?.signerSha256!==binding.flushHelperSignerSha256)
    throw Error('TRANSFER_HELPER_SELECTION_CHANGED');
}
/** Adapt the reviewed AI-05 provider, not a local selection cache. Any
 * failed live read permanently aborts this runtime; never retry admission.
 * The periodic witness stops idle Agents as well as per-effect checks. */
export function createTransferRuntimeLeaseAuthority(transport:HelperSelectionLeaseTransport,intervalMs=5000):TransferHelperRuntimeAuthority {
  if(!Number.isSafeInteger(intervalMs)||intervalMs<250||intervalMs>30000)throw Error('TRANSFER_HELPER_WITNESS_INTERVAL_INVALID');
  const provider=createHelperSelectionLeaseProvider(transport);
  return Object.freeze({
    readSelection:()=>provider.readSelection(),
    async withActiveSelection<T>(effect:(lease:TransferHelperActiveLease)=>Promise<T>):Promise<T>{
      return provider.withActiveSelection(async()=>{
        const ctrl=new AbortController();
        let expected:string|undefined;
        let inFlight:Promise<void>|undefined;
        let timer:ReturnType<typeof setTimeout>|undefined;
        const check=():Promise<void>=>{
          if(ctrl.signal.aborted)return Promise.reject(Error('TRANSFER_HELPER_RUNTIME_LEASE_RELEASED'));
          if(inFlight)return inFlight;
          inFlight=(async()=>{
            try{
              const v=await provider.readSelection();
              if(!v.pin||ctrl.signal.aborted)throw Error('TRANSFER_HELPER_RUNTIME_LEASE_RELEASED');
              const identity=JSON.stringify([v.revision,v.pin.sha256,v.pin.signerSha256]);
              if(expected!==undefined&&identity!==expected)throw Error('TRANSFER_HELPER_SELECTION_CHANGED');
              expected=identity;
            }catch(error){ctrl.abort();throw error;}
          })().finally(()=>{inFlight=undefined;});
          return inFlight;
        };
        const schedule=()=>{
          if(!ctrl.signal.aborted)timer=setTimeout(()=>{void check().then(schedule,()=>{});},intervalMs);
        };
        try{
          await check();schedule();
          const result=await effect(Object.freeze({signal:ctrl.signal,assertActive:check}));
          await check();
          return result;
        }finally{ctrl.abort();if(timer)clearTimeout(timer);await inFlight?.catch(()=>{});}
      });
    },
  });
}

export interface ProtectedTransferNativeStartup {
  publisher:Omit<WindowsProtectedTransferConfig,'flushHelper'|'flushHelperSha256'|'flushHelperSignerSha256'|'authority'>;
  helperSelection:HelperSelectionTlsConfig;
  tls:ProtectedTransferAuthorityTlsConfig;
  nativeMutationProvider:TrustedNativeMutationProvider;
  coreConsentProvider?:NativeCoreConsentAuthority;
  /** Trusted supervisor graceful-stop signal, NOT a revoke/lease proof. */
  shutdownSignal?:AbortSignal;
  withProtectedEffect:Parameters<typeof createProtectedNativeTransferAdmission>[1];
}
/** Explicit trusted owner-runtime entrypoint. No helper pin from CLI/env,
 * no test adapter, no auto-provisioning and no prelogin enablement.
 * The deployment lease spans publisher creation and the Agent lifetime. */
export async function runProtectedTransferNativeAgent(config:ProtectedTransferNativeStartup,env:NodeJS.ProcessEnv=process.env):Promise<void>{
  if(config?.shutdownSignal?.aborted)throw Error('PROTECTED_RUNTIME_STOPPED');
  if(process.platform!=='win32'||getWindowsPreloginAgentMode(env)||env.NEXOWIRE_AGENT_REQUIRE_ATOMIC_EFFECT_ADMISSION!=='1'||
     !env.NEXOWIRE_AGENT_RESERVATION_CAS_URL?.trim()||!env.NEXOWIRE_AGENT_RESERVATION_CAS_TOKEN?.trim()||
     !env.NEXOWIRE_AGENT_RESERVATION_CAS_AUTHORITY_ID?.trim()||!env.NEXOWIRE_AGENT_RESERVATION_CAS_EPOCH?.trim()||
     !config?.nativeMutationProvider?.authority||typeof config.nativeMutationProvider.resolveTrustedReservation!=='function'||
     config.tls?.role!=='native'||config.tls.scope.targetDeviceId!==config.publisher?.deviceId||
     config.helperSelection?.role!=='runtime'||config.helperSelection.scope.deviceId!==config.publisher?.deviceId||
     config.helperSelection.scope.ownerId!==config.tls.scope.ownerId||config.helperSelection.scope.authorityId!==config.tls.authorityId||
     typeof config.withProtectedEffect!=='function'||typeof config.publisher?.assertInstalledRuntime!=='function')
    throw Error('PROTECTED_NATIVE_TRANSFER_STARTUP_REQUIRED');
  const store=createWindowsTransferHelperArtifactStore(config.publisher.assertInstalledRuntime);
  const client=new ProtectedTransferAuthorityClient(config.tls);
  const runtimeDrain=new ProtectedRuntimeDrain();
  const admission=createProtectedNativeTransferAdmission(client,async (b,l,p,claim,effect)=>{
    let called=false,completed=false,active=true,invalid=false;
    try{
      await config.withProtectedEffect(b,l,p,claim,async()=>{
        if(!active||called){invalid=true;runtimeDrain.markUnknown();throw Error('PROTECTED_RUNTIME_CALLBACK_INVALID');}
        called=true;
        await runtimeDrain.run(effect);
        completed=true;
      });
      if(!called||!completed||invalid)throw Error('PROTECTED_RUNTIME_EFFECT_UNCONFIRMED');
    }catch(error){runtimeDrain.markUnknown();throw error;}
    finally{active=false;}
  });
  const helperAuthority=createTransferRuntimeLeaseAuthority(new ProtectedHelperSelectionClient(config.helperSelection));
  return withVerifiedTransferHelper(helperAuthority,store,async (binding,scope)=>{
    const check=async()=>{
      await scope.assertActive();
      await assertSelectedTransferHelper(helperAuthority,binding);
      await scope.assertActive();
    };
    const runtime=await createWindowsProtectedTransferPublisher({...config.publisher,...binding,
      async assertInstalledRuntime(){await check();await config.publisher.assertInstalledRuntime();await check();},
      authority:{async admit(b,l,p,effect){
        // Count the complete admission and the actual callback separately:
        // a provider that detaches an in-flight callback cannot fake drain.
        await runtimeDrain.run(async()=>{
          await check();
          try{
            await admission.admit(b,l,p,async()=>{
              await check();
              await effect();
              await check();
            });
            await check();
          }catch(error){runtimeDrain.markUnknown();throw error;}
        });
      }},
    });
    await check();
    try{
      await runNativeAgent(env,config.nativeMutationProvider,config.coreConsentProvider,runtime.publisher,config.publisher.deviceId,scope.signal,()=>runtimeDrain.seal(),config.shutdownSignal);
      await runtimeDrain.wait();
      // A local return never releases the lease itself. The exact mTLS
      // selection provider asks the independent observer for RELEASE proof.
      await scope.assertActive();
    }finally{runtimeDrain.seal();}
  });
}
