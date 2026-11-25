import {createWindowsTransferHelperArtifactStore,runTransferHelperLifecycle,type HelperRequest} from './protected-transfer-helper-lifecycle.js';
import {createHelperSelectionLeaseProvider} from '../security/postgres-helper-selection-authority.js';
import {ProtectedHelperSelectionClient,type HelperSelectionTlsConfig} from '../security/protected-helper-selection-transport.js';

// Runtime startup is owned by AI-07 runProtectedTransferNativeAgent.
/** Separate deployment credential. Actual protected artifact store, no test adapter. */
export async function runSelectionBoundHelperDeployment(config:{
  selection:HelperSelectionTlsConfig;deviceId:string;ownerId:string;authorityId:string;assertInstalledRuntime:()=>Promise<void>;
},request:Readonly<HelperRequest>){
  if(config?.selection?.role!=='deployment'||config.selection.scope?.deviceId!==config.deviceId||
    config.selection.scope?.ownerId!==config.ownerId||config.selection.scope?.authorityId!==config.authorityId||
    typeof config.assertInstalledRuntime!=='function')throw Error('HELPER_DEPLOYMENT_SCOPE_MISMATCH');
  return runTransferHelperLifecycle(request,createHelperSelectionLeaseProvider(new ProtectedHelperSelectionClient(config.selection)),
    createWindowsTransferHelperArtifactStore(config.assertInstalledRuntime));
}
