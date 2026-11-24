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
  withActiveSelection<T>(effect:()=>Promise<T>):Promise<T>;
}

/** Shared with the startup acceptance fixture; the production caller below
 * always constructs the real ACL/AuthentiCode artifact store. */
export async function withVerifiedTransferHelper<T>(authority:TransferHelperRuntimeAuthority,store:TransferHelperArtifactStore,activate:(binding:Binding)=>Promise<T>):Promise<T>{
  if(typeof authority?.withActiveSelection!=='function'||typeof authority.readSelection!=='function'||typeof activate!=='function')
    throw Error('TRANSFER_HELPER_RUNTIME_LEASE_REQUIRED');
  let active=true,entered=false,done=false,result!:T;
  try{
    await authority.withActiveSelection(async()=>{
      if(!active||entered)throw Error('TRANSFER_HELPER_RUNTIME_CALLBACK_INVALID');
      entered=true;
      const binding=await readVerifiedTransferHelperBinding(authority,store);
      if(!active)throw Error('TRANSFER_HELPER_RUNTIME_CALLBACK_INVALID');
      result=await activate(binding);done=true;return result;
    });
    if(!entered||!done)throw Error('TRANSFER_HELPER_RUNTIME_ACTIVATION_UNCONFIRMED');
    return result;
  }finally{active=false;}
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
  return withVerifiedTransferHelper(config.helperAuthority,store,async binding=>{
    const runtime=await createWindowsProtectedTransferPublisher({...config.publisher,...binding,
      authority:{async admit(b,l,p,effect){
        // Selection drift or unavailable readback denies BEFORE a new claim.
        await assertSelectedTransferHelper(config.helperAuthority,binding);
        await admission.admit(b,l,p,async()=>{
          await assertSelectedTransferHelper(config.helperAuthority,binding);
          await effect();
        });
      }},
    });
    await assertSelectedTransferHelper(config.helperAuthority,binding);
    return runNativeAgent(env,config.nativeMutationProvider,config.coreConsentProvider,runtime.publisher,config.publisher.deviceId);
  });
}
