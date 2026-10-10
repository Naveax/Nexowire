import { lstatSync } from 'node:fs';
import path from 'node:path';

export interface GuardianSqliteSidecarAudit {
  readonly journalPresent:boolean;
  readonly unexpectedWalOrShmPresent:false;
  readonly auditOnly:true;
  readonly storageAttested:false;
  readonly privilegedOperationAuthorized:false;
}

/**
 * Read-only filesystem sanity check for an already provisioned SQLite
 * rollback-journal database. Generic checker exists to test isolated paths;
 * ONLY the production wrapper with verifyWindowsPrivateAcl is authoritative
 * for Windows owner/write ACL acceptance.
 */
export function auditGuardianSqliteSidecars(
  databasePath:string,
  verifyPrivateAcl:(file:string)=>void,
):GuardianSqliteSidecarAudit {
  if(!path.isAbsolute(databasePath) ||
      path.normalize(databasePath)!==databasePath ||
      !databasePath.endsWith('.sqlite')) {
    throw new Error('GUARDIAN_SQLITE_SIDECAR_PATH_INVALID');
  }

  function inspect(sidecarPath:string):boolean {
    let stat;
    try {
      stat=lstatSync(sidecarPath);
    } catch(err) {
      if((err as NodeJS.ErrnoException).code==='ENOENT')return false;
      throw new Error('GUARDIAN_SQLITE_SIDECAR_UNREADABLE');
    }
    if(!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('GUARDIAN_SQLITE_SIDECAR_LINK_OR_NODE_UNTRUSTED');
    }
    try {
      verifyPrivateAcl(sidecarPath);
    } catch {
      throw new Error('GUARDIAN_SQLITE_SIDECAR_UNTRUSTED_ACL');
    }
    return true;
  }

  // DELETE rollback journal is permitted only with trusted file ACL.
  // WAL or SHM contradict the explicitly configured journal_mode=DELETE.
  // Still inspect their ACL before rejecting so no unknown path is trusted.
  const journalPresent=inspect(databasePath+'-journal');
  const walPresent=inspect(databasePath+'-wal');
  const shmPresent=inspect(databasePath+'-shm');
  if(walPresent || shmPresent) {
    throw new Error('GUARDIAN_SQLITE_SIDECAR_UNEXPECTED_WAL_MODE');
  }
  return Object.freeze({
    journalPresent,
    unexpectedWalOrShmPresent:false as const,
    auditOnly:true as const,
    storageAttested:false as const,
    privilegedOperationAuthorized:false as const,
  });
}
