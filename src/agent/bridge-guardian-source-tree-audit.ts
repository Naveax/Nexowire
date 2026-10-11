import {
  inventoryReadOnlySourceTree,
  type ReadOnlySourceTreeInventory,
} from '../security/privileged-stack-tree-audit.js';
import { verifyWindowsPrivateAcl } from '../security/windows-programdata-acl.js';
import {
  BRIDGE_GUARDIAN_SOURCE_ROOT,
  BRIDGE_GUARDIAN_LAUNCHER,
  inspectGuardianSourceChainSnapshotOnly,
  verifyBridgeGuardianSourceAcl,
} from './bridge-guardian-task-preflight.js';

/**
 * Full pinned protected Guardian tree inspection for pre-installation/release
 * acceptance only. Never invoke on every command, especially while the
 * local SQLite journal is being written.
 */
export interface GuardianSourceTreeAudit {
  readonly root:typeof BRIDGE_GUARDIAN_SOURCE_ROOT;
  readonly inventory:ReadOnlySourceTreeInventory;
  readonly auditOnly:true;
  readonly deploymentAttested:false;
  readonly processIntegrityAttested:false;
  readonly remoteActuationAuthorized:false;
}

export function auditBridgeGuardianFullSourceTree():GuardianSourceTreeAudit {
  if (process.platform !== 'win32') {
    throw new Error('GUARDIAN_SOURCE_TREE_WINDOWS_ONLY');
  }
  // Keep the protected ancestors and launcher under a single snapshot
  // while the potentially long full-tree dependency inventory runs.
  // A previously verified parent/launcher may change after its own ACL
  // check; the enclosing snapshot rejects observable changes on return.
  verifyBridgeGuardianSourceAcl();
  const parent='C:\\ProgramData\\Nexowire';
  const observed:{inventory?:ReadOnlySourceTreeInventory}={};
  inspectGuardianSourceChainSnapshotOnly([
    parent,BRIDGE_GUARDIAN_SOURCE_ROOT,BRIDGE_GUARDIAN_LAUNCHER,
  ],verifyWindowsPrivateAcl,()=>{
    // Static release/maintenance audit, never an OS execution permit.
    observed.inventory=inventoryReadOnlySourceTree(
      BRIDGE_GUARDIAN_SOURCE_ROOT,verifyWindowsPrivateAcl,
      {maxEntries:12000,maxDepth:24},
    );
  });
  if(!observed.inventory){
    throw new Error('GUARDIAN_SOURCE_TREE_INVENTORY_UNVERIFIED');
  }
  const inventory=observed.inventory;
  return Object.freeze({
    root:BRIDGE_GUARDIAN_SOURCE_ROOT,
    inventory,auditOnly:true as const,
    deploymentAttested:false as const,
    processIntegrityAttested:false as const,
    remoteActuationAuthorized:false as const,
  });
}
