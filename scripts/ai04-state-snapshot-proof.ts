/**
 * AI-04: read-only full-state content fingerprint for future offline migration.
 * Does not copy data, stop writers, change a task, or attest physical cutover.
 */
import {createHash} from 'node:crypto';
import {promises as fs, type BigIntStats} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {scanLegacyHubStateReadOnly} from './ai04-system-state-inventory.js';

const RECOVERY_DIR='ai04-recovery-backups';
const BUFFER_BYTES=128*1024;
const MAX_FILE_BYTES=4n*1024n*1024n*1024n; // refuse unexpected huge files

export interface StateSnapshotFile {
  relativePath:string;
  bytes:number;
  sha256:string;
}

export interface StateSnapshotProof {
  kind:'READ_ONLY_FULL_STATE_FINGERPRINT';
  root:string;
  fileCount:number;
  totalBytes:number;
  workspaceFileCount:number;
  sqliteRecords:number;
  sqliteQuickCheck:'ok';
  treeSha256:string;
  files:StateSnapshotFile[];
  writerQuiescenceVerified:false;
  aclProtectedDestinationVerified:false;
  dpapiScopeTransferVerified:false;
  readyForSystemCutover:false;
}

function cmp(a:string,b:string):number{return a<b?-1:a>b?1:0;}

function stableStat(a:BigIntStats,b:BigIntStats):boolean{
  return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&
    a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&
    a.nlink===b.nlink;
}

/** Bound data reads, reject hardlinks/reparse points and detect replacement. */
async function hashStableRegularFile(file:string):Promise<{bytes:number;sha256:string}>{
  const before=await fs.lstat(file,{bigint:true});
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n){
    throw new Error('AI04_SOURCE_FILE_NOT_PLAIN');
  }
  if(before.size>MAX_FILE_BYTES)throw new Error('AI04_STATE_FILE_TOO_LARGE');
  const handle=await fs.open(file,'r');
  try{
    const first=await handle.stat({bigint:true});
    if(!stableStat(first,before))throw new Error('AI04_SOURCE_REPLACED_BEFORE_HASH');
    const hasher=createHash('sha256');
    const buffer=Buffer.allocUnsafe(BUFFER_BYTES);
    let offset=0;
    for(;;){
      const read=await handle.read(buffer,0,buffer.length,offset);
      if(read.bytesRead===0)break;
      offset+=read.bytesRead;
      if(BigInt(offset)>MAX_FILE_BYTES)throw new Error('AI04_STATE_FILE_TOO_LARGE');
      hasher.update(buffer.subarray(0,read.bytesRead));
    }
    const after=await handle.stat({bigint:true});
    const nameAfter=await fs.lstat(file,{bigint:true});
    if(!stableStat(first,after)||!stableStat(first,nameAfter)||
       BigInt(offset)!==first.size){
      throw new Error('AI04_SOURCE_CHANGED_DURING_HASH');
    }
    return {bytes:offset,sha256:hasher.digest('hex')};
  }finally{await handle.close();}
}

function onlyValidRelativeName(name:string):void{
  if(!name||name==='.'||name==='..'||name.length>240||
      name.includes('/')||name.includes('\\')||name.includes('\0')){
    throw new Error('AI04_STATE_FILENAME_UNTRUSTED');
  }
}

/**
 * Inventory is included first to keep a strict allowlist for the top-level
 * Hub state; the recovery directory is also walked so no backup disappears.
 */
export async function captureLegacyHubStateSnapshotProof(
  root:string,
):Promise<StateSnapshotProof>{
  const inventory=await scanLegacyHubStateReadOnly(root);
  const blocking=new Set(['REQUIRED_STATE_FILE_MISSING',
    'UNRECOGNIZED_STATE_CONTENT','STATE_LINK_OR_HARDLINK_UNTRUSTED',
    'SQLITE_QUICK_CHECK_NOT_OK']);
  if(inventory.blockers.some(x=>blocking.has(x))||
     inventory.sqliteQuickCheck!=='ok'||inventory.sqliteRecords===null){
    throw new Error('AI04_STATE_INVENTORY_UNTRUSTED');
  }
  const items=await fs.readdir(root,{withFileTypes:true});
  const relative:string[]=[];
  let topLevelCount=0;
  let recoveryInitialNames:string[]|null=null;
  for(const entry of items){
    onlyValidRelativeName(entry.name);
    if(entry.name===RECOVERY_DIR){
      if(!entry.isDirectory()||entry.isSymbolicLink()){
        throw new Error('AI04_RECOVERY_DIRECTORY_UNTRUSTED');
      }
      const nested=await fs.readdir(path.join(root,RECOVERY_DIR),{withFileTypes:true});
      recoveryInitialNames=nested.map(x=>x.name).sort(cmp);
      for(const item of nested){
        onlyValidRelativeName(item.name);
        if(!item.isFile()||item.isSymbolicLink()){
          throw new Error('AI04_RECOVERY_ENTRY_NOT_REGULAR_FILE');
        }
        relative.push(RECOVERY_DIR+'/'+item.name);
      }
    }else{
      if(!entry.isFile()||entry.isSymbolicLink()){
        throw new Error('AI04_TOP_LEVEL_ENTRY_NOT_REGULAR_FILE');
      }
      relative.push(entry.name);
      topLevelCount++;
    }
  }
  if(topLevelCount!==inventory.rootFileCount){
    throw new Error('AI04_STATE_FILE_SET_CHANGED');
  }
  const seen=new Set<string>();
  const files:StateSnapshotFile[]=[];
  let totalBytes=0;
  for(const rel of relative.sort(cmp)){
    const folded=rel.toLowerCase();
    if(seen.has(folded))throw new Error('AI04_DUPLICATE_CASEFOLDED_STATE_NAME');
    seen.add(folded);
    const full=path.join(root,...rel.split('/'));
    const hashed=await hashStableRegularFile(full);
    totalBytes+=hashed.bytes;
    files.push({relativePath:rel,...hashed});
  }
  // Compare root contents again after hashing to reject concurrent insert/delete.
  const finalNames=(await fs.readdir(root)).sort(cmp);
  const initialNames=items.map(x=>x.name).sort(cmp);
  if(JSON.stringify(finalNames)!==JSON.stringify(initialNames)){
    throw new Error('AI04_STATE_DIRECTORY_CHANGED_DURING_HASH');
  }
  if(recoveryInitialNames){
    const recoveryFinalNames=(await fs.readdir(path.join(root,RECOVERY_DIR))).sort(cmp);
    if(JSON.stringify(recoveryFinalNames)!==JSON.stringify(recoveryInitialNames)){
      throw new Error('AI04_RECOVERY_DIRECTORY_CHANGED_DURING_HASH');
    }
  }
  const digest=createHash('sha256');
  for(const file of files){
    digest.update(file.relativePath+'\0'+file.bytes+'\0'+file.sha256+'\n','utf8');
  }
  return {
    kind:'READ_ONLY_FULL_STATE_FINGERPRINT',
    root,fileCount:files.length,totalBytes,
    workspaceFileCount:inventory.workspaceFileCount,
    sqliteRecords:inventory.sqliteRecords,sqliteQuickCheck:'ok',
    treeSha256:digest.digest('hex'),files,
    writerQuiescenceVerified:false,
    aclProtectedDestinationVerified:false,
    dpapiScopeTransferVerified:false,
    readyForSystemCutover:false,
  };
}

/** Comparing content never implies machine ACL / DPAPI or writer handoff PASS. */
export function compareLegacyHubStateSnapshotProofs(
  source:StateSnapshotProof,destination:StateSnapshotProof,
):{matches:boolean;differingPaths:string[];readyForSystemCutover:false}{
  const a=new Map(source.files.map(x=>[x.relativePath.toLowerCase(),x]));
  const b=new Map(destination.files.map(x=>[x.relativePath.toLowerCase(),x]));
  const all=[...new Set([...a.keys(),...b.keys()])].sort(cmp);
  const differingPaths=all.filter(p=>{
    const x=a.get(p),y=b.get(p);
    return !x||!y||x.bytes!==y.bytes||x.sha256!==y.sha256;
  });
  return {
    matches:differingPaths.length===0&&source.treeSha256===destination.treeSha256,
    differingPaths,readyForSystemCutover:false,
  };
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  if(process.platform!=='win32')throw new Error('WINDOWS_STATE_SNAPSHOT_ONLY');
  if(process.argv.length!==3)throw new Error('Usage: node --import tsx scripts/ai04-state-snapshot-proof.ts ABSOLUTE_STATE_ROOT');
  const proof=await captureLegacyHubStateSnapshotProof(process.argv[2]!);
  // Intentionally do not print per-file hashes or credential contents.
  const {files:_privateFiles,...summary}=proof;
  process.stdout.write(JSON.stringify(summary,null,2)+'\n');
}
