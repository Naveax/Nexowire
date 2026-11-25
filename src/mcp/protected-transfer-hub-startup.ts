import type {NexowireConfig} from '../config.js';
import {createRuntime} from '../runtime.js';
import {runHttpServer} from './http.js';
import {createProtectedHubTransferRuntime,type ProtectedTransferAuthorityTlsConfig} from '../security/protected-transfer-authority.js';
import {brokerNativeTransferClient} from './broker-native-transfer-client.js';
import {type AgentWebSocketServerOptions} from '../hub/agent-websocket.js';

export interface ProtectedTransferHubStartup {
  authority:ProtectedTransferAuthorityTlsConfig&{journalPath:string};
  assertProtectedJournal:(absolutePath:string)=>Promise<void>;
  remoteAtomicMutationCoordinatorFactory:NonNullable<AgentWebSocketServerOptions['remoteAtomicMutationCoordinatorFactory']>;
}
/** Trusted bootstrap, not a remote MCP parameter or ambient env feature flag.
 * Verify the preprovisioned journal and live grant before creating/listening
 * on the strict Hub. The factory must bind each authenticated socket to the
 * independent CORE atomic coordinator. No local/legacy fallback. */
export async function runProtectedTransferHub(config:NexowireConfig,startup:ProtectedTransferHubStartup):Promise<void>{
  if(config.remoteAgentAuthOnly!==true||!config.controlPlaneAgentAuth||!config.mcpResourceUrl||
     startup?.authority?.role!=='hub'||typeof startup.assertProtectedJournal!=='function'||
     typeof startup.remoteAtomicMutationCoordinatorFactory!=='function')
    throw Error('PROTECTED_TRANSFER_HUB_STARTUP_REQUIRED');
  const transfer=createProtectedHubTransferRuntime(startup.authority);
  await startup.assertProtectedJournal(transfer.journalPath);
  await transfer.authority.assertGrant(startup.authority.scope);
  const {broker,context}=await createRuntime(config,{requireAtomicMutationAuthority:true});
  if(!brokerNativeTransferClient(broker))throw Error('PROTECTED_TRANSFER_HUB_BROKER_REQUIRED');
  return runHttpServer(config,broker,{...context,largeTransferRuntime:transfer},
    {remoteAtomicMutationCoordinatorFactory:startup.remoteAtomicMutationCoordinatorFactory});
}
