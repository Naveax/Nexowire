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

  // A path can change between lstat and its (potentially slow) ACL check.
  // Sample identity and write-related metadata without following links.
  function state(sidecarPath:string):string|null {
    let stat;
    try {
      stat=lstatSync(sidecarPath);
    } catch(err) {
      if((err as NodeJS.ErrnoException).code==='ENOENT')return null;
      throw new Error('GUARDIAN_SQLITE_SIDECAR_UNREADABLE');
    }
    if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1) {
      throw new Error('GUARDIAN_SQLITE_SIDECAR_LINK_OR_NODE_UNTRUSTED');
    }
    return JSON.stringify([
      stat.dev,stat.ino,stat.mode,stat.nlink,stat.size,
      stat.mtimeMs,stat.ctimeMs,stat.birthtimeMs,
    ]);
  }

  function assertUnchanged(sidecarPath:string,before:string|null):void {
    let after:string|null;
    try {
      after=state(sidecarPath);
    } catch {
      throw new Error('GUARDIAN_SQLITE_SIDECAR_CHANGED_DURING_AUDIT');
    }
    if(after!==before) {
      throw new Error('GUARDIAN_SQLITE_SIDECAR_CHANGED_DURING_AUDIT');
    }
  }

  function inspect(sidecarPath:string):string|null {
    const before=state(sidecarPath);
    if(before!==null) {
      try {
        verifyPrivateAcl(sidecarPath);
      } catch {
        throw new Error('GUARDIAN_SQLITE_SIDECAR_UNTRUSTED_ACL');
      }
    }
    assertUnchanged(sidecarPath,before);
    return before;
  }

  // DELETE rollback journal is permitted only with trusted file ACL.
  // WAL or SHM contradict the explicitly configured journal_mode=DELETE.
  // Still inspect their ACL before rejecting so no unknown path is trusted.
  const journal=inspect(databasePath+'-journal');
  const wal=inspect(databasePath+'-wal');
  const shm=inspect(databasePath+'-shm');
  // Earlier sidecars, including absent WAL/SHM, must not change while later
  // paths are checked. These are snapshots, not atomic storage attestation.
  assertUnchanged(databasePath+'-journal',journal);
  assertUnchanged(databasePath+'-wal',wal);
  assertUnchanged(databasePath+'-shm',shm);
  if(wal!==null || shm!==null) {
    throw new Error('GUARDIAN_SQLITE_SIDECAR_UNEXPECTED_WAL_MODE');
  }
  return Object.freeze({
    journalPresent:journal!==null,
    unexpectedWalOrShmPresent:false as const,
    auditOnly:true as const,
    storageAttested:false as const,
    privilegedOperationAuthorized:false as const,
  });
}
