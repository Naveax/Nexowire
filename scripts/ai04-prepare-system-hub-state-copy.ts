/**
 * AI-04: explicit OFFLINE, elevated, fail-closed SYSTEM Hub state preparation.
 * This script NEVER stops a process, changes a task, unseals secrets or
 * generates a cutover receipt. An incomplete protected staging tree is
 * preserved for operator inspection. The original user state is never edited.
 */
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {constants as fsConstants,promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {isWindowsProcessElevated} from '../src/agent/privileged-broker.js';
import {
  hardenWindowsProgramDataAcl,
  protectedWindowsAclEnvironment,
  verifyWindowsPrivateAcl,
  verifyWindowsStackOuterAncestorAcl,
  windowsProgramDataAclArguments,
} from '../src/security/windows-programdata-acl.js';
import {
  assertCanonicalHubStateSourcePath,
  assertNoSourceWriterReadOnly,
  captureHubStateDigestReadOnly,
  SYSTEM_CUTOVER_RECEIPT,
  SYSTEM_STATE_ROOT,
} from '../src/hub/system-hub-state-cutover.js';
import {parsePersistedHubLauncherEnvironment} from '../src/hub/hub-boot-lifecycle.js';
import {
  captureLegacyHubStateSnapshotProof,
  compareLegacyHubStateSnapshotProofs,
  type StateSnapshotProof,
} from './ai04-state-snapshot-proof.js';
import {inspectProtectedMigrationDiskBudgetReadOnly} from './ai04-offline-migration-integrity.js';
import {assertLegacyHubPortNotListening} from './ai04-issue-system-state-receipt.js';

const PARENT='C:\\ProgramData\\Nexowire';
const ICACLS='C:\\Windows\\System32\\icacls.exe';
const STAGING_NAME=/^hub-state-staging-[a-f0-9-]{36}$/;
const BACKUP='ai04-recovery-backups';

type StageHooks={
  afterRootFilesCopied?:(directory:string,files:readonly string[])=>Promise<void>;
  afterRecoveryDirectoryCreated?:(directory:string)=>Promise<void>;
  afterRecoveryFilesCopied?:(directory:string,files:readonly string[])=>Promise<void>;
};
export interface OfflineStageCopyProof {
  sourceRoot:string;
  stagingRoot:string;
  durableFileCount:number;
  durableTreeSha256:string;
  sqliteRecords:number;
  recoveryDirectoryPresent:boolean;
  /** An offline file copy is never a SYSTEM privilege or reboot acceptance. */
  receiptIssued:false;
  readyForSystemCutover:false;
}

function canonicalDirectory(value:string):string{
  if(!value||!path.win32.isAbsolute(value)||value.startsWith('\\\\')||
     path.win32.normalize(value)!==value||value.endsWith('\\')){
    throw new Error('AI04_COPY_DIRECTORY_NONCANONICAL');
  }
  return value;
}
function assertIndependentDirectories(source:string,target:string):void{
  const a=canonicalDirectory(source).toLowerCase();
  const b=canonicalDirectory(target).toLowerCase();
  if(a===b||a.startsWith(b+'\\')||b.startsWith(a+'\\'))
    throw new Error('AI04_COPY_SOURCE_TARGET_OVERLAP');
}
function relativeParts(value:string):string[]{
  const parts=value.split('/');
  if(parts.length>2||parts.some(part=>!part||part==='.'||part==='..'||
     part.includes('\\')||part.includes(':')||part.includes('\0'))||
     (parts.length===2&&parts[0]!==BACKUP)){
    throw new Error('AI04_COPY_RELATIVE_NAME_UNTRUSTED');
  }
  return parts;
}
async function assertSafeExistingDirectory(dir:string,empty=false):Promise<void>{
  const stat=await fs.lstat(dir,{bigint:true});
  if(!stat.isDirectory()||stat.isSymbolicLink())
    throw new Error('AI04_COPY_DIRECTORY_UNTRUSTED');
  if(empty&&(await fs.readdir(dir)).length>0)
    throw new Error('AI04_COPY_TARGET_NOT_EMPTY');
}
async function sourceRecoveryDirectoryPresent(root:string):Promise<boolean>{
  try{
    await assertSafeExistingDirectory(path.win32.join(root,BACKUP));
    return true;
  }catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT')return false;
    throw error;
  }
}
async function assertRegularFile(pathname:string):Promise<void>{
  const stat=await fs.lstat(pathname,{bigint:true});
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n)
    throw new Error('AI04_COPY_SOURCE_FILE_UNTRUSTED');
}
async function copyExclusivePlainFile(source:string,target:string):Promise<void>{
  await assertRegularFile(source);
  // COPYFILE_EXCL prevents overwriting any previously staged evidence.
  await fs.copyFile(source,target,fsConstants.COPYFILE_EXCL);
  await assertRegularFile(target);
}
function sameFullDurableProof(a:StateSnapshotProof,b:StateSnapshotProof):boolean{
  return a.treeSha256===b.treeSha256&&a.fileCount===b.fileCount&&
    a.totalBytes===b.totalBytes&&a.workspaceFileCount===b.workspaceFileCount&&
    a.sqliteRecords===b.sqliteRecords;
}

/**
 * Testable, source-safe copy into an EXISTING, EXCLUSIVE, EMPTY directory.
 * The caller owns destination security and physical offline admission.
 * There is no automatic cleanup on failure: evidence remains inspectable.
 */
export async function copyVerifiedDurableStateToEmptyStage(
  sourceRoot:string,stagingRoot:string,hooks:StageHooks={},
):Promise<OfflineStageCopyProof>{
  assertIndependentDirectories(sourceRoot,stagingRoot);
  await assertSafeExistingDirectory(sourceRoot);
  await assertSafeExistingDirectory(stagingRoot,true);
  const sourceBackupInitiallyPresent=await sourceRecoveryDirectoryPresent(sourceRoot);
  const initial=await captureLegacyHubStateSnapshotProof(sourceRoot);
  const rootFiles=initial.files.filter(file=>!file.relativePath.includes('/'));
  const backupFiles=initial.files.filter(file=>file.relativePath.includes('/'));
  for(const file of rootFiles){
    const parts=relativeParts(file.relativePath);
    await copyExclusivePlainFile(
      path.win32.join(sourceRoot,...parts),
      path.win32.join(stagingRoot,...parts),
    );
  }
  await hooks.afterRootFilesCopied?.(
    stagingRoot,rootFiles.map(file=>file.relativePath),
  );
  const recoveryDirectoryPresent=await sourceRecoveryDirectoryPresent(sourceRoot);
  if(recoveryDirectoryPresent!==sourceBackupInitiallyPresent)
    throw new Error('AI04_COPY_RECOVERY_DIRECTORY_CHANGED');
  if(recoveryDirectoryPresent){
    const backupTarget=path.win32.join(stagingRoot,BACKUP);
    await fs.mkdir(backupTarget);
    await hooks.afterRecoveryDirectoryCreated?.(backupTarget);
    for(const file of backupFiles){
      const parts=relativeParts(file.relativePath);
      await copyExclusivePlainFile(
        path.win32.join(sourceRoot,...parts),
        path.win32.join(stagingRoot,...parts),
      );
    }
    await hooks.afterRecoveryFilesCopied?.(
      backupTarget,backupFiles.map(file=>relativeParts(file.relativePath)[1]!),
    );
  }else if(backupFiles.length){
    throw new Error('AI04_COPY_RECOVERY_DIRECTORY_MISSING');
  }
  const sourceAfter=await captureLegacyHubStateSnapshotProof(sourceRoot);
  const staged=await captureLegacyHubStateSnapshotProof(stagingRoot);
  if(await sourceRecoveryDirectoryPresent(sourceRoot)!==sourceBackupInitiallyPresent)
    throw new Error('AI04_COPY_RECOVERY_DIRECTORY_CHANGED');
  if(!sameFullDurableProof(initial,sourceAfter)||
     !sameFullDurableProof(initial,staged)||
     !compareLegacyHubStateSnapshotProofs(initial,staged).matches){
    throw new Error('AI04_COPY_DURABLE_TREE_CHANGED_OR_MISMATCHED');
  }
  return {
    sourceRoot,stagingRoot,durableFileCount:initial.fileCount,
    durableTreeSha256:initial.treeSha256,sqliteRecords:initial.sqliteRecords,
    recoveryDirectoryPresent,receiptIssued:false,readyForSystemCutover:false,
  };
}
function icaclsTrusted(args:string[]):void{
  const result=spawnSync(ICACLS,args,{
    encoding:'utf8',windowsHide:true,shell:false,
    cwd:'C:\\Windows\\System32',
    env:protectedWindowsAclEnvironment(),
    timeout:20000,maxBuffer:256*1024,
  });
  if(result.error||result.status!==0)
    throw new Error('AI04_PROTECTED_COPY_ACL_MUTATION_FAILED');
}
function setAdministratorsOwner(file:string):void{
  // No /T recursion: every file and directory was pre-validated independently.
  icaclsTrusted([file,'/setowner','*S-1-5-32-544']);
}
function hardenFlatDirectory(directory:string):void{
  setAdministratorsOwner(directory);
  hardenWindowsProgramDataAcl(directory);
  verifyWindowsPrivateAcl(directory);
}
async function protectFile(file:string):Promise<void>{
  await assertRegularFile(file);
  setAdministratorsOwner(file);
  icaclsTrusted(windowsProgramDataAclArguments(file,false));
  verifyWindowsPrivateAcl(file);
}
async function assertTargetAndReceiptAbsent():Promise<void>{
  for(const pathname of [SYSTEM_STATE_ROOT,SYSTEM_CUTOVER_RECEIPT]){
    try{
      await fs.lstat(pathname);
      throw new Error('AI04_EXISTING_SYSTEM_STATE_OR_RECEIPT_DENIED');
    }catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    }
  }
}
function auditProtectedOuterAncestors():void{
  verifyWindowsStackOuterAncestorAcl('C:\\');
  verifyWindowsStackOuterAncestorAcl('C:\\ProgramData');
  verifyWindowsPrivateAcl(PARENT);
}
async function auditProtectedDurableTree(root:string):Promise<void>{
  verifyWindowsPrivateAcl(root);
  const names=await fs.readdir(root,{withFileTypes:true});
  for(const entry of names){
    const child=path.win32.join(root,entry.name);
    if(entry.name===BACKUP){
      await assertSafeExistingDirectory(child);
      verifyWindowsPrivateAcl(child);
      for(const backup of await fs.readdir(child,{withFileTypes:true})){
        if(!backup.isFile()||backup.isSymbolicLink())
          throw new Error('AI04_PROTECTED_BACKUP_NOT_REGULAR');
        await assertRegularFile(path.win32.join(child,backup.name));
        verifyWindowsPrivateAcl(path.win32.join(child,backup.name));
      }
    }else{
      await assertRegularFile(child);
      verifyWindowsPrivateAcl(child);
    }
  }
}
/** A ready/running/hidden user Hub task can start a writer during the copy. */
export function assertInteractiveHubTaskDisabledReadOnly():void{
  if(process.platform!=='win32')throw new Error('AI04_WINDOWS_ONLY');
  const command=String.raw`
$ErrorActionPreference='Stop'
$task=Get-ScheduledTask -TaskName 'Nexowire Hub' -TaskPath '\' -ErrorAction Stop
if(@($task).Count -ne 1 -or [string]$task.State -cne 'Disabled'){
  throw 'AI04_INTERACTIVE_HUB_TASK_NOT_DISABLED'
}
`;
  const result=spawnSync(
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',
      Buffer.from(command,'utf16le').toString('base64')],
    {windowsHide:true,encoding:'utf8',shell:false,timeout:15000,
      cwd:'C:\\Windows\\System32',
      env:protectedWindowsAclEnvironment()},
  );
  if(result.error||result.status!==0)
    throw new Error('AI04_INTERACTIVE_HUB_TASK_NOT_CONFIRMED_DISABLED');
}

async function ownerQuiescenceProof(source:string,port:number):Promise<void>{
  assertInteractiveHubTaskDisabledReadOnly();
  await assertNoSourceWriterReadOnly(source);
  assertLegacyHubPortNotListening(port);
  assertInteractiveHubTaskDisabledReadOnly();
}
async function readCanonicalLegacySource(launcher:string):Promise<{root:string;port:number}>{
  const expected=path.win32.join(os.homedir(),'.nexowire','hub-service','launch.ps1');
  if(launcher!==expected)throw new Error('AI04_NONCANONICAL_USER_LAUNCHER_DENIED');
  const launch=await fs.readFile(launcher,'utf8');
  const env=parsePersistedHubLauncherEnvironment(launch);
  const root=assertCanonicalHubStateSourcePath(env.NEXOWIRE_STATE_DIR);
  const port=Number(env.NEXOWIRE_HTTP_PORT??'43110');
  if(!Number.isInteger(port)||port<1||port>65535)
    throw new Error('AI04_LEGACY_HUB_PORT_INVALID');
  return {root,port};
}

/**
 * Approved offline maintenance only. Does not stop Hub, mutate its source,
 * create a cutover receipt or install SYSTEM tasks. Failure leaves an owned
 * staging/target directory for explicit reconciliation, never an auto-delete.
 */
export async function prepareProtectedOfflineSystemHubStateCopy(
  launcher:string,approved:boolean,
):Promise<{promoted:true;target:string;durableFiles:number;
  receiptIssued:false;readyForSystemCutover:false}>{
  if(process.platform!=='win32')throw new Error('AI04_WINDOWS_ONLY');
  if(!approved)throw new Error('AI04_OWNER_APPROVAL_REQUIRED');
  if(!isWindowsProcessElevated())throw new Error('AI04_ADMIN_ELEVATION_REQUIRED');
  const {root:source,port}=await readCanonicalLegacySource(launcher);
  auditProtectedOuterAncestors();
  await assertTargetAndReceiptAbsent();
  await ownerQuiescenceProof(source,port);
  const budget=await inspectProtectedMigrationDiskBudgetReadOnly(source);
  if(!budget.sufficient)throw new Error('AI04_PROTECTED_TARGET_DISK_SPACE_INSUFFICIENT');
  const stage=path.win32.join(PARENT,'hub-state-staging-'+randomUUID());
  if(!STAGING_NAME.test(path.win32.basename(stage)))
    throw new Error('AI04_STAGE_NAME_INVALID');
  // New, exclusive staging root under a previously ACL-verified private parent.
  await fs.mkdir(stage,{recursive:false,mode:0o700});
  hardenFlatDirectory(stage);
  const copied=await copyVerifiedDurableStateToEmptyStage(source,stage,{
    afterRootFilesCopied:async(dir,relative)=>{
      for(const name of relative) setAdministratorsOwner(path.win32.join(dir,name));
      hardenFlatDirectory(dir); // still flat: recovery folder not created yet
    },
    afterRecoveryDirectoryCreated:async(dir)=>hardenFlatDirectory(dir),
    afterRecoveryFilesCopied:async(dir,names)=>{
      for(const name of names)setAdministratorsOwner(path.win32.join(dir,name));
      hardenFlatDirectory(dir);
    },
  });
  // SQLite may recreate optional -shm while validating WAL; harden that
  // newly derived file without changing the committed database or WAL.
  const shm=path.win32.join(stage,'idempotency-records.sqlite-shm');
  try{await protectFile(shm)}
  catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  }
  await auditProtectedDurableTree(stage);
  const staged=await captureHubStateDigestReadOnly(stage,true);
  const old=await captureHubStateDigestReadOnly(source);
  if(staged.treeSha256!==copied.durableTreeSha256||
     old.treeSha256!==copied.durableTreeSha256||
     staged.sqliteRecords!==copied.sqliteRecords||
     old.sqliteRecords!==copied.sqliteRecords)
    throw new Error('AI04_STAGE_DURABLE_CONTENT_DRIFT');
  await ownerQuiescenceProof(source,port);
  auditProtectedOuterAncestors();
  const endBudget=await inspectProtectedMigrationDiskBudgetReadOnly(source);
  if(!endBudget.sufficient)throw new Error('AI04_PROTECTED_TARGET_DISK_SPACE_INSUFFICIENT');
  await assertTargetAndReceiptAbsent();
  // Atomic same-volume promotion. Existing target or receipt is never replaced.
  await fs.rename(stage,SYSTEM_STATE_ROOT);
  auditProtectedOuterAncestors();
  await auditProtectedDurableTree(SYSTEM_STATE_ROOT);
  const promoted=await captureHubStateDigestReadOnly(SYSTEM_STATE_ROOT,true);
  const sourceAgain=await captureHubStateDigestReadOnly(source);
  if(promoted.treeSha256!==sourceAgain.treeSha256||
     promoted.treeSha256!==copied.durableTreeSha256)
    throw new Error('AI04_POSTPROMOTION_CONTENT_MISMATCH');
  await ownerQuiescenceProof(source,port);
  return {
    promoted:true,target:SYSTEM_STATE_ROOT,durableFiles:copied.durableFileCount,
    receiptIssued:false,readyForSystemCutover:false,
  };
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  if(process.argv.length!==3||process.argv[2]!=='--approve-offline-copy'){
    throw new Error('Offline elevated maintenance only: --approve-offline-copy. No Hub stop, task changes or receipt issued.');
  }
  const launcher=path.win32.join(os.homedir(),'.nexowire','hub-service','launch.ps1');
  const {target,durableFiles}=await prepareProtectedOfflineSystemHubStateCopy(launcher,true);
  process.stdout.write(JSON.stringify({
    promoted:true,target,durableFiles,receiptIssued:false,
    readyForSystemCutover:false,
  })+'\n');
}
