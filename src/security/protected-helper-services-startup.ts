import {startProtectedTransferAndCoreServices,type ProtectedTransferServicesStartup} from './protected-transfer-services-startup.js';
import type {createRollbackGuardedHelperSelectionService} from './protected-helper-rollback-guard.js';
export {composeHelperSelectionRevokeDrain} from './protected-helper-revoke-drain.js';

type SelectionConfig=Parameters<typeof createRollbackGuardedHelperSelectionService>[0];
export interface ProtectedHelperTransferServicesStartup {
  transferAndCore:Omit<ProtectedTransferServicesStartup,'selection'|'selectionHost'|'selectionPort'>;
  selection:SelectionConfig;
  selectionHost:string;
  selectionPort:number;
}
/** Compatibility entrypoint for AI05 callers. Exactly one selection service,
 * one protected transfer service and one CORE service; no duplicated binds. */
export async function startProtectedHelperTransferAndCoreServices(config:ProtectedHelperTransferServicesStartup){
  if(!config?.transferAndCore||!config.selection)throw Error('HELPER_SHARED_AUTHORITY_STARTUP_REQUIRED');
  return startProtectedTransferAndCoreServices({...config.transferAndCore,selection:config.selection,
    selectionHost:config.selectionHost,selectionPort:config.selectionPort});
}
