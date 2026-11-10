/**
 * AI-04 OFFLINE ONLY. Requires an authorized, elevated, independently
 * recoverable Windows maintenance session. Never copies or stops the Hub.
 * Receipt is exclusive-create and refuses stale/mixed-time snapshots.
 */
import {spawnSync} from 'node:child_process';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {isWindowsProcessElevated} from '../src/agent/privileged-broker.js';
import {
  assertCanonicalHubStateSourcePath,
  assertHubStateReceiptBoundToLegacyLauncher,
  assertNoSourceWriterReadOnly,
  captureHubStateDigestReadOnly,
  SYSTEM_STATE_ROOT,
  SYSTEM_CUTOVER_RECEIPT,
  type ReadOnlyHubStateDigest,
  type SystemHubStateCutoverReceipt,
} from '../src/hub/system-hub-state-cutover.js';
import {parsePersistedHubLauncherEnvironment} from '../src/hub/hub-boot-lifecycle.js';
import {
  verifyWindowsPrivateAcl,
  verifyWindowsStackOuterAncestorAcl,
} from '../src/security/windows-programdata-acl.js';

export function createSystemCutoverReceiptFromProof(
  source:ReadOnlyHubStateDigest,target:ReadOnlyHubStateDigest,
):SystemHubStateCutoverReceipt{
  if(target.root!==SYSTEM_STATE_ROOT)throw new Error('AI04_RECEIPT_DESTINATION_NOT_CANONICAL');
  const receipt:SystemHubStateCutoverReceipt={
    version:1,host:os.hostname(),sourceRoot:source.root,
    destinationRoot:SYSTEM_STATE_ROOT,treeSha256:source.treeSha256,
    fileCount:source.fileCount,totalBytes:source.totalBytes,
    sqliteRecords:source.sqliteRecords,
    recoveryDirectoryPresent:source.recoveryDirectoryPresent,
  };
  return assertHubStateReceiptBoundToLegacyLauncher(
    receipt,source.root,source,target,
  );
}
function assertLegacyHubPortNotListening(port:number):void{
  if(!Number.isInteger(port)||port<1||port>65535)
    throw new Error('AI04_LEGACY_HUB_PORT_INVALID');
  const code=[
    "$ErrorActionPreference='Stop'",
    // Query all listeners with Stop: AccessDenied/query errors are NOT absence.
    '$ports=@(Get-NetTCPConnection -State Listen -ErrorAction Stop | '+
      'Where-Object { $_.LocalPort -eq '+port+' })',
    "if($ports.Count -gt 0){throw 'AI04_LEGACY_HUB_PORT_STILL_LISTENING'}",
  ].join('\n');
  const r=spawnSync(
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoProfile','-NoLogo','-NonInteractive','-EncodedCommand',
      Buffer.from(code,'utf16le').toString('base64')],
    {encoding:'utf8',windowsHide:true,timeout:15000,env:{
      SystemRoot:'C:\\Windows',windir:'C:\\Windows',
      PATH:'C:\\Windows\\System32;C:\\Windows',
      PSModulePath:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
    }},
  );
  if(r.status!==0||r.error){
    throw new Error('AI04_LEGACY_HUB_PORT_QUIESCENCE_UNVERIFIED');
  }
}

export async function inspectOfflineSystemCutoverReceiptCandidate(
  sourcePath:string,port:number,
):Promise<SystemHubStateCutoverReceipt>{
  if(process.platform!=='win32')throw new Error('AI04_WINDOWS_ONLY');
  const source=assertCanonicalHubStateSourcePath(sourcePath);
  verifyWindowsStackOuterAncestorAcl('C:\\');
  verifyWindowsStackOuterAncestorAcl('C:\\ProgramData');
  verifyWindowsPrivateAcl('C:\\ProgramData\\Nexowire');
  verifyWindowsPrivateAcl(SYSTEM_STATE_ROOT);
  verifyWindowsPrivateAcl(path.win32.join(SYSTEM_STATE_ROOT,'idempotency-records.sqlite'));
  await assertNoSourceWriterReadOnly(source);
  assertLegacyHubPortNotListening(port);
  const first=await captureHubStateDigestReadOnly(source);
  const second=await captureHubStateDigestReadOnly(SYSTEM_STATE_ROOT,true);
  const receipt=createSystemCutoverReceiptFromProof(first,second);
  const statfs=await fs.statfs('C:\\ProgramData',{bigint:true});
  const remaining=statfs.bavail*statfs.bsize;
  const needed=4n*1024n*1024n*1024n+BigInt(first.totalBytes)*2n;
  if(remaining<needed)throw new Error('AI04_PROTECTED_TARGET_DISK_SPACE_INSUFFICIENT');
  const laterSource=await captureHubStateDigestReadOnly(source);
  const laterTarget=await captureHubStateDigestReadOnly(SYSTEM_STATE_ROOT,true);
  assertHubStateReceiptBoundToLegacyLauncher(receipt,source,laterSource,laterTarget);
  await assertNoSourceWriterReadOnly(source);
  assertLegacyHubPortNotListening(port);
  verifyWindowsStackOuterAncestorAcl('C:\\');
  verifyWindowsStackOuterAncestorAcl('C:\\ProgramData');
  verifyWindowsPrivateAcl('C:\\ProgramData\\Nexowire');
  verifyWindowsPrivateAcl(SYSTEM_STATE_ROOT);
  return receipt;
}

export async function issueOfflineSystemStateCutoverReceipt(
  legacyLauncher:string,approval:boolean,
):Promise<{issued:boolean;stateFiles:number;readyForSystemCutover:false}>{
  if(process.platform!=='win32')throw new Error('AI04_WINDOWS_ONLY');
  if(!approval)throw new Error('AI04_OWNER_APPROVAL_REQUIRED');
  if(!isWindowsProcessElevated())throw new Error('AI04_ADMIN_ELEVATION_REQUIRED');
  const expectedLauncher=path.join(os.homedir(),'.nexowire','hub-service','launch.ps1');
  if(legacyLauncher!==expectedLauncher)
    throw new Error('AI04_NONCANONICAL_USER_LAUNCHER_DENIED');
  const text=await fs.readFile(legacyLauncher,'utf8');
  const env=parsePersistedHubLauncherEnvironment(text);
  const source=assertCanonicalHubStateSourcePath(env.NEXOWIRE_STATE_DIR);
  const port=Number(env.NEXOWIRE_HTTP_PORT??'43110');
  // No existing receipt is ever overwritten, including when a previous
  // attempt failed partway through. Operator recovery remains explicit.
  try{
    await fs.lstat(SYSTEM_CUTOVER_RECEIPT);
    throw new Error('AI04_RECEIPT_ALREADY_EXISTS');
  }catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  }
  const proof=await inspectOfflineSystemCutoverReceiptCandidate(source,port);
  const handle=await fs.open(SYSTEM_CUTOVER_RECEIPT,'wx',0o600);
  try{
    await handle.writeFile(JSON.stringify(proof,null,2)+'\n','utf8');
    await handle.sync();
  }finally{await handle.close()}
  // A failed ACL check intentionally leaves the receipt for manual review,
  // rather than deleting a potentially replaced privileged object.
  verifyWindowsPrivateAcl(SYSTEM_CUTOVER_RECEIPT);
  return {issued:true,stateFiles:proof.fileCount,readyForSystemCutover:false};
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const root=path.join(os.homedir(),'.nexowire','hub-service','launch.ps1');
  if(process.argv.length!==3||process.argv[2]!=='--approve-offline-migration')
    throw new Error('Run only in an independently recoverable ELEVATED OFFLINE maintenance session with --approve-offline-migration. This command does not copy or stop Hub.');
  const result=await issueOfflineSystemStateCutoverReceipt(root,true);
  process.stdout.write(JSON.stringify(result)+'\n');
}
