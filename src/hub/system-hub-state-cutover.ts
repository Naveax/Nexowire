/**
 * SYSTEM Hub source/target cutover. This read-only proof is NOT an issuer or
 * a live migration. Only a separately prepared, private ProgramData receipt
 * can bind the original launcher to the protected destination.
 */
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {promises as fs, type BigIntStats} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as z from 'zod';
import {
  verifyWindowsPrivateAcl,
  verifyWindowsStackOuterAncestorAcl,
} from '../security/windows-programdata-acl.js';

export const SYSTEM_STATE_ROOT='C:\\ProgramData\\Nexowire\\hub-state';
export const SYSTEM_CUTOVER_RECEIPT='C:\\ProgramData\\Nexowire\\hub-state-cutover.receipt.json';
const PRIVATE_PARENT='C:\\ProgramData\\Nexowire';
const MAX_RECEIPT_BYTES=1024*1024;
const MAX_FILE_BYTES=4n*1024n*1024n*1024n;
const required=new Set(['audit.jsonl','credentials.json','devices.json',
  'idempotency-records.json','idempotency-records.sqlite']);
const extras=new Set(['idempotency-records.sqlite-wal','idempotency-records.sqlite-shm']);
const workspace=/^workspace-[a-f0-9]{64}\.json$/;
const legacy=/^idempotency-records\.json\.pre-sqlite-[0-9]+$/;
const sha=z.string().regex(/^[0-9a-f]{64}$/);
const ReceiptSchema=z.object({
  version:z.literal(1),
  host:z.string().min(1).max(255),
  sourceRoot:z.string().min(4).max(4096),
  destinationRoot:z.literal(SYSTEM_STATE_ROOT),
  treeSha256:sha,
  fileCount:z.number().int().min(5).max(20000),
  totalBytes:z.number().int().nonnegative().safe(),
  sqliteRecords:z.number().int().nonnegative().safe(),
  recoveryDirectoryPresent:z.boolean(),
}).strict();
export type SystemHubStateCutoverReceipt=z.infer<typeof ReceiptSchema>;

export function assertCanonicalHubStateSourcePath(value:string|undefined):string{
  if(!value||!path.win32.isAbsolute(value)||value.startsWith('\\\\')||
    path.win32.normalize(value)!==value||
    value.endsWith('\\')||value.toLowerCase()===SYSTEM_STATE_ROOT.toLowerCase()||
    value.toLowerCase().startsWith(SYSTEM_STATE_ROOT.toLowerCase()+'\\')||
    SYSTEM_STATE_ROOT.toLowerCase().startsWith(value.toLowerCase()+'\\')){
    throw new Error('HUB_BOOT_SOURCE_STATE_UNTRUSTED');
  }
  return value;
}

function stable(a:BigIntStats,b:BigIntStats):boolean{
  return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&
    a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&
    a.nlink===b.nlink&&a.mode===b.mode;
}
async function hashPlain(file:string):Promise<{bytes:number;sha256:string;stat:BigIntStats}>{
  const before=await fs.lstat(file,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||
    before.size>MAX_FILE_BYTES)throw new Error('HUB_BOOT_STATE_FILE_UNTRUSTED');
  const handle=await fs.open(file,'r');
  try{
    const first=await handle.stat({bigint:true});
    if(!stable(first,before))throw new Error('HUB_BOOT_STATE_FILE_CHANGED');
    const digest=createHash('sha256');
    const buffer=Buffer.allocUnsafe(128*1024);
    let offset=0;
    for(;;){
      const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);
      if(!bytesRead)break;
      offset+=bytesRead;
      if(BigInt(offset)>MAX_FILE_BYTES)throw new Error('HUB_BOOT_STATE_FILE_TOO_LARGE');
      digest.update(buffer.subarray(0,bytesRead));
    }
    const after=await handle.stat({bigint:true});
    const named=await fs.lstat(file,{bigint:true});
    if(!stable(first,after)||!stable(first,named)||BigInt(offset)!==first.size)
      throw new Error('HUB_BOOT_STATE_FILE_CHANGED');
    return {bytes:offset,sha256:digest.digest('hex'),stat:before};
  }finally{await handle.close()}
}
function isPlainName(name:string):boolean{
  return !!name&&name!=='.'&&name!=='..'&&name.length<=240&&
    !name.includes('/')&&!name.includes('\\')&&!name.includes('\0')&&
    !name.includes(':');
}
function cmp(a:string,b:string):number{return a<b?-1:a>b?1:0}
export interface ReadOnlyHubStateDigest {
  root:string;
  treeSha256:string;
  fileCount:number;
  totalBytes:number;
  sqliteRecords:number;
  recoveryDirectoryPresent:boolean;
}
/** No writes, and no implicit assertion that the writer has stopped. */
export async function captureHubStateDigestReadOnly(
  root:string,verifyProtectedFiles=false,
):Promise<ReadOnlyHubStateDigest>{
  // The protected destination is the one exception to the legacy-source rule.
  if(root!==SYSTEM_STATE_ROOT)assertCanonicalHubStateSourcePath(root);
  const initial=await fs.lstat(root,{bigint:true});
  if(!initial.isDirectory()||initial.isSymbolicLink())
    throw new Error('HUB_BOOT_STATE_ROOT_NOT_DIRECTORY');
  const items=await fs.readdir(root,{withFileTypes:true});
  const original=items.map(x=>x.name).sort(cmp);
  let initialRecoveryNames:string[]|null=null;
  const paths:string[]=[];
  let recoveryDirectoryPresent=false;
  const seen=new Set<string>();
  for(const entry of items){
    if(!isPlainName(entry.name))throw new Error('HUB_BOOT_STATE_NAME_INVALID');
    if(entry.name==='ai04-recovery-backups'){
      if(!entry.isDirectory()||entry.isSymbolicLink())
        throw new Error('HUB_BOOT_RECOVERY_DIRECTORY_UNTRUSTED');
      recoveryDirectoryPresent=true;
      const backup=path.win32.join(root,entry.name);
      const backupStat=await fs.lstat(backup,{bigint:true});
      if(!backupStat.isDirectory()||backupStat.isSymbolicLink())
        throw new Error('HUB_BOOT_RECOVERY_DIRECTORY_UNTRUSTED');
      if(verifyProtectedFiles)verifyWindowsPrivateAcl(backup);
      const backupNames=await fs.readdir(backup,{withFileTypes:true});
      initialRecoveryNames=backupNames.map(x=>x.name).sort(cmp);
      for(const file of backupNames){
        if(!isPlainName(file.name)||!file.isFile()||file.isSymbolicLink())
          throw new Error('HUB_BOOT_RECOVERY_FILE_UNTRUSTED');
        paths.push('ai04-recovery-backups/'+file.name);
      }
    }else{
      if(!required.has(entry.name)&&!extras.has(entry.name)&&
         !workspace.test(entry.name)&&!legacy.test(entry.name))
        throw new Error('HUB_BOOT_UNKNOWN_STATE_ENTRY');
      if(!entry.isFile()||entry.isSymbolicLink())
        throw new Error('HUB_BOOT_STATE_FILE_UNTRUSTED');
      paths.push(entry.name);
    }
  }
  for(const name of required){
    if(!original.includes(name))throw new Error('HUB_BOOT_REQUIRED_STATE_MISSING');
  }
  const snapshot=new Map<string,BigIntStats>();
  for(const rel of paths){
    const key=rel.toLowerCase();
    if(seen.has(key))throw new Error('HUB_BOOT_DUPLICATE_STATE_NAME');
    seen.add(key);
    const full=path.win32.join(root,...rel.split('/'));
    const state=await fs.lstat(full,{bigint:true});
    if(!state.isFile()||state.isSymbolicLink()||state.nlink!==1n)
      throw new Error('HUB_BOOT_STATE_FILE_UNTRUSTED');
    snapshot.set(rel,state);
  }
  const tree=createHash('sha256');
  let totalBytes=0;
  for(const rel of paths.sort(cmp)){
    const full=path.win32.join(root,...rel.split('/'));
    if(verifyProtectedFiles)verifyWindowsPrivateAcl(full);
    const file=await hashPlain(full);
    totalBytes+=file.bytes;
    tree.update(rel+'\0'+file.bytes+'\0'+file.sha256+'\n','utf8');
  }
  const sqlite=path.win32.join(root,'idempotency-records.sqlite');
  const db=new DatabaseSync(sqlite,{readOnly:true});
  let sqliteRecords:number;
  try{
    const check=db.prepare('PRAGMA quick_check').get() as {quick_check?:unknown};
    if(check?.quick_check!=='ok')throw new Error('HUB_BOOT_SQLITE_QUICK_CHECK_FAILED');
    const row=db.prepare('SELECT COUNT(*) AS n FROM idempotency_records').get() as {n?:unknown};
    if(typeof row?.n!=='number'||!Number.isSafeInteger(row.n))
      throw new Error('HUB_BOOT_SQLITE_COUNT_UNTRUSTED');
    sqliteRecords=row.n;
  }finally{db.close()}
  const current=(await fs.readdir(root)).sort(cmp);
  if(JSON.stringify(current)!==JSON.stringify(original))
    throw new Error('HUB_BOOT_STATE_MEMBERSHIP_CHANGED');
  if(initialRecoveryNames){
    const recoveryNow=(await fs.readdir(path.win32.join(root,'ai04-recovery-backups'))).sort(cmp);
    if(JSON.stringify(recoveryNow)!==JSON.stringify(initialRecoveryNames))
      throw new Error('HUB_BOOT_RECOVERY_MEMBERSHIP_CHANGED');
  }
  for(const [rel,before] of snapshot){
    const after=await fs.lstat(path.win32.join(root,...rel.split('/')),{bigint:true});
    if(!stable(before,after))throw new Error('HUB_BOOT_STATE_CHANGED_DURING_HASH');
  }
  const final=await fs.lstat(root,{bigint:true});
  if(!stable(initial,final))throw new Error('HUB_BOOT_STATE_ROOT_CHANGED');
  if(verifyProtectedFiles&&recoveryDirectoryPresent)
    verifyWindowsPrivateAcl(path.win32.join(root,'ai04-recovery-backups'));
  return {
    root,treeSha256:tree.digest('hex'),fileCount:paths.length,
    totalBytes,sqliteRecords,recoveryDirectoryPresent,
  };
}
export function assertHubStateReceiptBoundToLegacyLauncher(
  raw:unknown,launcherStateRoot:string,source:ReadOnlyHubStateDigest,
  destination:ReadOnlyHubStateDigest,
):SystemHubStateCutoverReceipt{
  const r=ReceiptSchema.parse(raw);
  const original=assertCanonicalHubStateSourcePath(launcherStateRoot);
  if(r.host!==os.hostname())throw new Error('HUB_BOOT_MIGRATION_RECEIPT_HOST_MISMATCH');
  if(r.sourceRoot!==original||source.root!==original||
     destination.root!==SYSTEM_STATE_ROOT||
     r.destinationRoot!==SYSTEM_STATE_ROOT)
    throw new Error('HUB_BOOT_MIGRATION_RECEIPT_PATH_MISMATCH');
  for(const proof of [source,destination]){
    if(proof.treeSha256!==r.treeSha256||proof.fileCount!==r.fileCount||
       proof.totalBytes!==r.totalBytes||proof.sqliteRecords!==r.sqliteRecords||
       proof.recoveryDirectoryPresent!==r.recoveryDirectoryPresent){
      throw new Error('HUB_BOOT_MIGRATION_RECEIPT_CONTENT_MISMATCH');
    }
  }
  return r;
}
export async function assertNoSourceWriterReadOnly(sourceRoot:string):Promise<void>{
  const db=new DatabaseSync(path.win32.join(sourceRoot,'idempotency-records.sqlite'),{readOnly:true});
  try{
    const row=db.prepare("SELECT value FROM idempotency_meta WHERE key='hub_writer'").get() as
      {value?:unknown}|undefined;
    if(typeof row?.value!=='string')throw new Error('HUB_BOOT_WRITER_IDENTITY_UNKNOWN');
    const identity=JSON.parse(row.value) as Record<string,unknown>;
    if(identity.host!==os.hostname()||
       typeof identity.pid!=='number'||!Number.isSafeInteger(identity.pid)||
       identity.pid<1||typeof identity.incarnation!=='string'||!identity.incarnation)
      throw new Error('HUB_BOOT_WRITER_IDENTITY_UNKNOWN');
    try{
      process.kill(identity.pid,0);
      throw new Error('HUB_BOOT_SOURCE_WRITER_STILL_RUNNING');
    }catch(error){
      if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;
    }
  }finally{db.close()}
}
async function assertProtectedTargetDiskBudget(bytes:number):Promise<void>{
  const usage=await fs.statfs('C:\\ProgramData',{bigint:true});
  const free=usage.bavail*usage.bsize;
  const required=4n*1024n*1024n*1024n+2n*BigInt(bytes);
  if(free<required)throw new Error('HUB_BOOT_SYSTEM_STATE_DISK_SPACE_INSUFFICIENT');
}
/**
 * Physical install gate. A private receipt is required and independently
 * validated, including source and destination state. No receipt issuer here.
 */
export async function verifyProtectedSystemHubCutoverReadOnly(
  launcherStateRoot:string,
):Promise<string>{
  if(process.platform!=='win32')throw new Error('HUB_BOOT_WINDOWS_ONLY');
  const source=assertCanonicalHubStateSourcePath(launcherStateRoot);
  verifyWindowsStackOuterAncestorAcl('C:\\');
  verifyWindowsStackOuterAncestorAcl('C:\\ProgramData');
  verifyWindowsPrivateAcl(PRIVATE_PARENT);
  verifyWindowsPrivateAcl(SYSTEM_STATE_ROOT);
  verifyWindowsPrivateAcl(SYSTEM_CUTOVER_RECEIPT);
  verifyWindowsPrivateAcl(path.win32.join(SYSTEM_STATE_ROOT,'idempotency-records.sqlite'));
  const stat=await fs.lstat(SYSTEM_CUTOVER_RECEIPT);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||
    stat.size>MAX_RECEIPT_BYTES)
    throw new Error('HUB_BOOT_MIGRATION_RECEIPT_UNTRUSTED');
  const raw=ReceiptSchema.parse(JSON.parse(await fs.readFile(SYSTEM_CUTOVER_RECEIPT,'utf8')));
  if(raw.sourceRoot!==source)throw new Error('HUB_BOOT_MIGRATION_RECEIPT_PATH_MISMATCH');
  await assertProtectedTargetDiskBudget(raw.totalBytes);
  // Reject a writer that remains present before any unseal or task mutation.
  await assertNoSourceWriterReadOnly(source);
  const firstSource=await captureHubStateDigestReadOnly(source);
  const firstDestination=await captureHubStateDigestReadOnly(SYSTEM_STATE_ROOT,true);
  assertHubStateReceiptBoundToLegacyLauncher(raw,source,firstSource,firstDestination);
  const nextSource=await captureHubStateDigestReadOnly(source);
  const nextDestination=await captureHubStateDigestReadOnly(SYSTEM_STATE_ROOT,true);
  assertHubStateReceiptBoundToLegacyLauncher(raw,source,nextSource,nextDestination);
  await assertNoSourceWriterReadOnly(source);
  await assertProtectedTargetDiskBudget(raw.totalBytes);
  verifyWindowsStackOuterAncestorAcl('C:\\');
  verifyWindowsStackOuterAncestorAcl('C:\\ProgramData');
  verifyWindowsPrivateAcl(PRIVATE_PARENT);
  verifyWindowsPrivateAcl(SYSTEM_STATE_ROOT);
  verifyWindowsPrivateAcl(SYSTEM_CUTOVER_RECEIPT);
  return SYSTEM_STATE_ROOT;
}
