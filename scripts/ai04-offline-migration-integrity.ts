/**
 * AI-04: read-only source/destination content and protected ACL verification.
 * Comparing bytes is NOT a transfer, quiescence receipt, DPAPI conversion,
 * rollback acceptance or authorization to install a SYSTEM task.
 */
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  verifyWindowsPrivateAcl,
  verifyWindowsStackOuterAncestorAcl,
} from '../src/security/windows-programdata-acl.js';
import {
  captureLegacyHubStateSnapshotProof,
  compareLegacyHubStateSnapshotProofs,
  type StateSnapshotProof,
} from './ai04-state-snapshot-proof.js';
import {
  SYSTEM_HUB_STATE_PATH,
  scanLegacyHubStateReadOnly,
} from './ai04-system-state-inventory.js';

function canonicalWindowsRoot(root:string):string{
  if(!root||!path.win32.isAbsolute(root)||
     root.startsWith('\\\\')||root.startsWith('\\\\?\\')||
     path.win32.normalize(root).toLowerCase()!==root.toLowerCase()){
    throw new Error('AI04_MIGRATION_ROOT_NONCANONICAL');
  }
  return path.win32.normalize(root);
}

/** Strictly derived from the allowlisted, fingerprinted file inventory. */
export function protectedStateAclTargets(proof:StateSnapshotProof):string[]{
  const root=canonicalWindowsRoot(proof.root);
  const targets=[path.win32.dirname(root),root];
  let includesRecovery=false;
  for(const file of proof.files){
    const parts=file.relativePath.split('/');
    if(parts.length>2||parts.some(x=>!x||x==='.'||x==='..'||
       x.includes('\\')||x.includes(':')||x.includes('\0'))||
       (parts.length===2&&parts[0]!=='ai04-recovery-backups')){
      throw new Error('AI04_MIGRATION_RELATIVE_PATH_UNTRUSTED');
    }
    if(parts.length===2)includesRecovery=true;
    targets.push(path.win32.join(root,...parts));
  }
  if(includesRecovery)targets.push(path.win32.join(root,'ai04-recovery-backups'));
  return [...new Set(targets)].sort();
}

export interface OfflineMigrationIntegrityReport {
  kind:'READ_ONLY_OFFLINE_COPY_COMPARISON';
  sourceRoot:string;
  destinationRoot:string;
  sourceFileCount:number;
  destinationFileCount:number;
  sourceSqliteRecords:number;
  destinationSqliteRecords:number;
  contentIdentical:boolean;
  differingPaths:string[];
  /** No authority is inferred from comparing matching bytes. */
  writerQuiescenceVerified:false;
  localMachineDpapiTransferVerified:false;
  protectedAclVerified:false;
  rebootRecoveryVerified:false;
  readyForSystemCutover:false;
}

/** Can inspect disposable fixture trees as well as future real offline copies. */
export async function compareOfflineHubStateCopyReadOnly(
  sourceRoot:string,
  destinationRoot:string,
):Promise<OfflineMigrationIntegrityReport>{
  const source=canonicalWindowsRoot(sourceRoot);
  const destination=canonicalWindowsRoot(destinationRoot);
  const foldedSource=source.toLowerCase(),foldedDestination=destination.toLowerCase();
  if(foldedSource===foldedDestination||
     foldedDestination.startsWith(foldedSource+'\\')||
     foldedSource.startsWith(foldedDestination+'\\')){
    throw new Error('AI04_MIGRATION_SOURCE_DESTINATION_OVERLAP');
  }
  // The independently verified content proofs also catch WAL/journal changes,
  // renamed recovery backups, hardlinks, substituted files and SQLite drift.
  const sourceInventory=await scanLegacyHubStateReadOnly(source);
  const destinationInventory=await scanLegacyHubStateReadOnly(destination);
  const first=await captureLegacyHubStateSnapshotProof(source);
  const second=await captureLegacyHubStateSnapshotProof(destination);
  const compared=compareLegacyHubStateSnapshotProofs(first,second);
  // Empty recovery folders are not included in a file-only tree hash.
  // Preserving the complete directory layout matters for rollback as well.
  const recoveryDirectoryMatches=
    sourceInventory.nestedRecoveryBackupsPresent===
    destinationInventory.nestedRecoveryBackupsPresent;
  const differingPaths=[...compared.differingPaths];
  if(!recoveryDirectoryMatches)differingPaths.push('ai04-recovery-backups/');
  differingPaths.sort();
  return {
    kind:'READ_ONLY_OFFLINE_COPY_COMPARISON',
    sourceRoot:source,destinationRoot:destination,
    sourceFileCount:first.fileCount,destinationFileCount:second.fileCount,
    sourceSqliteRecords:first.sqliteRecords,
    destinationSqliteRecords:second.sqliteRecords,
    contentIdentical:compared.matches&&recoveryDirectoryMatches,
    differingPaths,
    writerQuiescenceVerified:false,
    localMachineDpapiTransferVerified:false,
    protectedAclVerified:false,
    rebootRecoveryVerified:false,
    readyForSystemCutover:false,
  };
}

/**
 * Physical preflight: refuse observed/unknown writer occupancy, then verify
 * every destination ACL. Even PASS only proves content and ACL at this instant.
 * A separate trusted quiescence, machine DPAPI and reboot acceptance is needed.
 */
export async function auditProtectedSystemHubCopyReadOnly(
  sourceRoot:string,
):Promise<OfflineMigrationIntegrityReport & {aclEntriesChecked:number}>{
  if(process.platform!=='win32')throw new Error('AI04_WINDOWS_ONLY');
  const source=canonicalWindowsRoot(sourceRoot);
  const target=SYSTEM_HUB_STATE_PATH;
  if(source.toLowerCase()===target.toLowerCase())
    throw new Error('AI04_MIGRATION_SOURCE_DESTINATION_OVERLAP');
  const inventory=await scanLegacyHubStateReadOnly(source);
  if(inventory.sqliteWriterPidPresence!=='not-found'||
     inventory.sqliteWriterRecordStatus!=='valid'||
     inventory.sqliteWriterHostMatchesLocal!==true){
    throw new Error('AI04_WRITER_QUIESCENCE_UNVERIFIED');
  }
  // Private Nexowire ACLs are not enough if C:\\ or ProgramData can be
  // replaced, retargeted, or have their owner/DACL changed by an untrusted SID.
  // Shared ancestors may allow unrelated sibling creation, but not replacement.
  verifyWindowsStackOuterAncestorAcl('C:\\');
  verifyWindowsStackOuterAncestorAcl('C:\\ProgramData');
  verifyWindowsPrivateAcl(path.win32.dirname(target));
  verifyWindowsPrivateAcl(target);
  const before=await compareOfflineHubStateCopyReadOnly(source,target);
  if(!before.contentIdentical)throw new Error('AI04_MIGRATED_CONTENT_DIFFERENT');
  // Recheck every nested backup and SQLite/WAL/file, not only the root ACL.
  const destination=await captureLegacyHubStateSnapshotProof(target);
  const destinationInventory=await scanLegacyHubStateReadOnly(target);
  const aclTargets=protectedStateAclTargets(destination);
  // An empty recovery directory has no fingerprinted files but still needs
  // the same protected ACL as the root and each copied backup.
  if(destinationInventory.nestedRecoveryBackupsPresent){
    const backupDir=path.win32.join(target,'ai04-recovery-backups');
    if(!aclTargets.includes(backupDir))aclTargets.push(backupDir);
  }
  for(const file of aclTargets)verifyWindowsPrivateAcl(file);
  // Recheck the trusted ancestors after the entire multi-file inspection.
  // A private file result alone does not prove its containing tree stayed safe.
  verifyWindowsStackOuterAncestorAcl('C:\\');
  verifyWindowsStackOuterAncestorAcl('C:\\ProgramData');
  verifyWindowsPrivateAcl(path.win32.dirname(target));
  verifyWindowsPrivateAcl(target);
  const after=await compareOfflineHubStateCopyReadOnly(source,target);
  if(!after.contentIdentical||
     after.sourceSqliteRecords!==before.sourceSqliteRecords||
     after.sourceFileCount!==before.sourceFileCount||
     after.destinationFileCount!==before.destinationFileCount){
    throw new Error('AI04_MIGRATED_CONTENT_CHANGED_DURING_ACL_AUDIT');
  }
  const writerAfter=await scanLegacyHubStateReadOnly(source);
  if(writerAfter.sqliteWriterPidPresence!=='not-found'||
     writerAfter.sqliteWriterRecordStatus!=='valid'||
     writerAfter.sqliteWriterHostMatchesLocal!==true){
    throw new Error('AI04_WRITER_REAPPEARED_DURING_ACL_AUDIT');
  }
  // Still not a physical cutover receipt. No secrets/filenames printed by CLI.
  return {...after,aclEntriesChecked:aclTargets.length};
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  if(process.argv.length!==3)throw new Error(
    'Usage: node --import tsx scripts/ai04-offline-migration-integrity.ts ABSOLUTE_SOURCE_STATE_ROOT');
  const report=await auditProtectedSystemHubCopyReadOnly(process.argv[2]!);
  const {differingPaths:_privatePaths,...summary}=report;
  process.stdout.write(JSON.stringify(summary,null,2)+'\n');
}
