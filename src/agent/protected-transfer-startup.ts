import {runNativeAgent} from './native-agent.js';
import type {TrustedNativeMutationProvider} from './native-atomic-effect-admission.js';
import type {NativeCoreConsentAuthority} from './windows-core-console-provider.js';
import {getWindowsPreloginAgentMode} from './windows-prelogin-bootstrap.js';
import {createWindowsProtectedTransferPublisher,type WindowsProtectedTransferConfig} from './windows-protected-transfer-publisher.js';
import {createWindowsTransferHelperArtifactStore,readVerifiedTransferHelperBinding,type TransferHelperDeploymentAuthority,type TransferHelperArtifactStore} from '../installer/protected-transfer-helper-lifecycle.js';
import {ProtectedTransferAuthorityClient,createProtectedNativeTransferAdmission,type ProtectedTransferAuthorityTlsConfig} from '../security/protected-transfer-authority.js';

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
export interface ProtectedTransferNativeStartup {
  publisher:Omit<WindowsProtectedTransferConfig,'flushHelper'|'flushHelperSha256'|'flushHelperSignerSha256'|'authority'>;
  helperAuthority:TransferHelperRuntimeAuthority;
  tls:ProtectedTransferAuthorityTlsConfig;
  nativeMutationProvider:TrustedNativeMutationProvider;
  coreConsentProvider?:NativeCoreConsentAuthority;
  withProtectedEffect:Parameters<typeof createProtectedNativeTransferAdmission>[1];
}
/** Explicit trusted owner-runtime entrypoint. No helper pin from CLI/env,
 * no test adapter, no auto-provisioning and no prelogin enablement.
 * The deployment lease spans publisher creation and the Agent lifetime. */
export async function runProtectedTransferNativeAgent(config:ProtectedTransferNativeStartup,env:NodeJS.ProcessEnv=process.env):Promise<never>{
  if(process.platform!=='win32'||getWindowsPreloginAgentMode(env)||env.NEXOWIRE_AGENT_REQUIRE_ATOMIC_EFFECT_ADMISSION!=='1'||
     !env.NEXOWIRE_AGENT_RESERVATION_CAS_URL?.trim()||!env.NEXOWIRE_AGENT_RESERVATION_CAS_TOKEN?.trim()||
     !env.NEXOWIRE_AGENT_RESERVATION_CAS_AUTHORITY_ID?.trim()||!env.NEXOWIRE_AGENT_RESERVATION_CAS_EPOCH?.trim()||
     !config?.nativeMutationProvider?.authority||typeof config.nativeMutationProvider.resolveTrustedReservation!=='function'||
     config.tls?.role!=='native'||config.tls.scope.targetDeviceId!==config.publisher?.deviceId||
     typeof config.withProtectedEffect!=='function'||typeof config.publisher.assertInstalledRuntime!=='function')
    throw Error('PROTECTED_NATIVE_TRANSFER_STARTUP_REQUIRED');
  const store=createWindowsTransferHelperArtifactStore(config.publisher.assertInstalledRuntime);
  const client=new ProtectedTransferAuthorityClient(config.tls);
  const admission=createProtectedNativeTransferAdmission(client,config.withProtectedEffect);
  return withVerifiedTransferHelper(config.helperAuthority,store,async (binding,scope)=>{
    const check=async()=>{
      await scope.assertActive();
      await assertSelectedTransferHelper(config.helperAuthority,binding);
      await scope.assertActive();
    };
    const runtime=await createWindowsProtectedTransferPublisher({...config.publisher,...binding,
      async assertInstalledRuntime(){await check();await config.publisher.assertInstalledRuntime();await check();},
      authority:{async admit(b,l,p,effect){
        // No new claim/effect after lease release or selection drift.
        await check();
        await admission.admit(b,l,p,async()=>{
          await check();
          await effect();
          // Lease loss during effect is UNKNOWN, never a completed settlement.
          await check();
        });
        await check();
      }},
    });
    await check();
    return runNativeAgent(env,config.nativeMutationProvider,config.coreConsentProvider,runtime.publisher,config.publisher.deviceId,scope.signal);
  });
}
