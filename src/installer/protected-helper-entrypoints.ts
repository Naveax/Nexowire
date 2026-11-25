import {runProtectedTransferNativeAgent,createTransferRuntimeLeaseAuthority,type ProtectedTransferNativeStartup} from '../agent/protected-transfer-startup.js';
import {createWindowsTransferHelperArtifactStore,runTransferHelperLifecycle,type HelperRequest} from './protected-transfer-helper-lifecycle.js';
import {createHelperSelectionLeaseProvider} from '../security/postgres-helper-selection-authority.js';
import {ProtectedHelperSelectionClient,type HelperSelectionTlsConfig} from '../security/protected-helper-selection-transport.js';

type NativeConfig=Omit<ProtectedTransferNativeStartup,'helperSelection'>;
type NativeBinding=Pick<NativeConfig,'publisher'|'tls'>;
/** Trusted launcher only: exact native scope, no local DB or arbitrary provider. */
function assertBoundRuntimeScope(config:NativeBinding,selection:HelperSelectionTlsConfig){
  if(selection?.role!=='runtime'||config?.tls?.role!=='native'||
    !config.publisher?.deviceId||selection.scope?.deviceId!==config.publisher.deviceId||
    selection.scope.deviceId!==config.tls.scope?.targetDeviceId||
    selection.scope.ownerId!==config.tls.scope.ownerId||
    selection.scope.authorityId!==config.tls.authorityId)throw Error('HELPER_STARTUP_SCOPE_MISMATCH');
}
export function createBoundHelperRuntimeAuthority(config:NativeBinding,selection:HelperSelectionTlsConfig){
  assertBoundRuntimeScope(config,selection);
  return createTransferRuntimeLeaseAuthority(new ProtectedHelperSelectionClient(selection));
}
export async function runSelectionBoundProtectedTransferAgent(config:NativeConfig,selection:HelperSelectionTlsConfig,env:NodeJS.ProcessEnv=process.env):Promise<void>{
  // Validate through the same exact scope contract. The Agent startup owns
  // the single real mTLS runtime lease; do not acquire a second lease here.
  assertBoundRuntimeScope(config,selection);
  return runProtectedTransferNativeAgent({...config,helperSelection:selection},env);
}
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
