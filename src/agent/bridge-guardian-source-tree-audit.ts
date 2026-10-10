import { lstatSync } from 'node:fs';
import {
  inventoryReadOnlySourceTree,
  type ReadOnlySourceTreeInventory,
} from '../security/privileged-stack-tree-audit.js';
import { verifyWindowsPrivateAcl } from '../security/windows-programdata-acl.js';
import {
  BRIDGE_GUARDIAN_SOURCE_ROOT,
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
  // The launcher plus existing protected ancestor checks are mandatory.
  verifyBridgeGuardianSourceAcl();
  const parent = 'C:\\ProgramData\\Nexowire';
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('GUARDIAN_SOURCE_TREE_PARENT_INVALID');
  }
  verifyWindowsPrivateAcl(parent);

  // This is a static release/maintenance audit, not an OS execution permit.
  // Every nested source file, dependency, directory, symlink or junction
  // must be inspected, with conservative size/depth limits.
  const inventory=inventoryReadOnlySourceTree(
    BRIDGE_GUARDIAN_SOURCE_ROOT,verifyWindowsPrivateAcl,
    {maxEntries:12000,maxDepth:24},
  );
  return Object.freeze({
    root:BRIDGE_GUARDIAN_SOURCE_ROOT,
    inventory,auditOnly:true as const,
    deploymentAttested:false as const,
    processIntegrityAttested:false as const,
    remoteActuationAuthorized:false as const,
  });
}
