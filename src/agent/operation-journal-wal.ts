import {promises as fs} from 'node:fs';
import {endianness} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';

/**
 * Conservative, streaming validation of SQLite WAL frames before connecting
 * to an Agent mutation journal. SQLite's own recovery can silently discard an
 * invalid WAL suffix; that is inappropriate when the suffix might have
 * contained an anti-replay reservation. Reject rather than repair.
 *
 * Checksum and frame layout: https://www.sqlite.org/fileformat2.html
 * A raw WAL check is not an adversarial authenticity guarantee: use Windows
 * ACLs and a separately trusted recovery backup as well.
 */
export class AgentJournalWalError extends Error {
  readonly code='AGENT_JOURNAL_WAL_CORRUPT';
  constructor(message:string){
    super(message);
    this.name='AgentJournalWalError';
  }
}

// A volatile ordinary WAL-index timestamp can change as SQLite releases an
// mmap reader even while the same file and durable WAL remain in place.
// This is not a positive corruption finding, nor proof of a live owner.
export class AgentJournalWalUnstableError extends Error {
  readonly code='AGENT_JOURNAL_WAL_UNSTABLE';
  constructor(){
    super('SQLite WAL-index snapshot remained unstable; mutation dispatch denied.');
    this.name='AgentJournalWalUnstableError';
  }
}

type Checksum={s0:number;s1:number};
function fail():never {
  throw new AgentJournalWalError(
    'SQLite WAL structural or checksum validation failed; mutation dispatch denied.',
  );
}

function fold(bytes:Buffer,length:number,bigEndian:boolean,seed:Checksum):Checksum {
  let {s0,s1}=seed;
  for(let offset=0;offset<length;offset+=8){
    const a=bigEndian?bytes.readUInt32BE(offset):bytes.readUInt32LE(offset);
    const b=bigEndian?bytes.readUInt32BE(offset+4):bytes.readUInt32LE(offset+4);
    s0=(s0+a+s1)>>>0;
    s1=(s1+b+s0)>>>0;
  }
  return {s0,s1};
}

async function readExactly(handle:fs.FileHandle,buf:Buffer,length:number,at:number):
  Promise<void>{
  let consumed=0;
  while(consumed<length){
    const result=await handle.read(buf,consumed,length-consumed,at+consumed);
    if(result.bytesRead===0)fail();
    consumed+=result.bytesRead;
  }
}

// Re-check the pathname, not merely the opened file handle. A replaced WAL
// or SHM pathname may otherwise pass validation against the previous inode.
// These checks do not replace native-singleton ownership or an atomic SQLite
// open/verify handoff in the journal owner.
type FileSnapshot={dev:number;ino:number;size:number;mtimeMs:number;ctimeMs:number};
function assertSnapshotIdentity(current:FileSnapshot,opened:FileSnapshot):void{
  if(current.dev!==opened.dev||current.ino!==opened.ino||
     current.size!==opened.size)fail();
}
function assertSnapshotMetadata(current:FileSnapshot,opened:FileSnapshot,
  retryIndexTimestamp:boolean):void{
  // Identity and size changes are not the narrow retryable condition.
  assertSnapshotIdentity(current,opened);
  if(current.mtimeMs!==opened.mtimeMs||current.ctimeMs!==opened.ctimeMs){
    if(retryIndexTimestamp)throw new AgentJournalWalUnstableError();
    fail();
  }
}
async function assertStablePath(file:string,opened:FileSnapshot,
  retryIndexTimestamp=false):Promise<void>{
  let current;
  try{current=await fs.lstat(file)}catch{fail();}
  if(!current.isFile()||current.isSymbolicLink())fail();
  assertSnapshotMetadata(current,opened,retryIndexTimestamp);
}


type IndexSnapshot=FileSnapshot&{bytes:Buffer};
type WalWitness={file:FileSnapshot;header:Buffer;currentFrames:number;
  commitPages:number;digest:Checksum};
type RetryAnchor={wal:WalWitness;index:FileSnapshot;indexHeaders:Buffer};
type RetryState={anchor?:RetryAnchor};
type RetryRead={state:RetryState;wal:WalWitness;priorClaimsVerified:boolean};

// A stable index snapshot is corroboration, not a trusted rollback witness.
// A complete WAL may legitimately outlive a missing/uninitialized index.
async function readIndexSnapshot(dbFile:string,strictShape:boolean,
  retry?:RetryRead):Promise<IndexSnapshot|undefined>{
  const file=dbFile+'-shm';
  const anchor=retry?.state.anchor;
  let prior;
  try{prior=await fs.lstat(file);}catch(e){
    if((e as NodeJS.ErrnoException).code==='ENOENT'){
      if(anchor)fail();
      return undefined;
    }
    throw e;
  }
  if(!prior.isFile()||prior.isSymbolicLink())fail();
  if(anchor)assertSnapshotIdentity(prior,anchor.index);
  let handle:fs.FileHandle;
  try{handle=await fs.open(file,'r');}catch(e){
    if((e as NodeJS.ErrnoException).code==='ENOENT')fail();
    throw e;
  }
  try{
    const opened=await handle.stat();
    if(!opened.isFile())fail();
    // No retry before the index headers have been read. The ordinary
    // WAL retry must retain positive evidence across attempts.
    assertSnapshotMetadata(opened,prior,false);
    if(opened.size<32768||opened.size%32768!==0){
      if(strictShape)fail();
      return undefined;
    }
    const bytes=Buffer.alloc(136);
    await readExactly(handle,bytes,bytes.length,0);
    if(anchor&&!bytes.subarray(0,96).equals(anchor.indexHeaders)){
      // A lagging or split index may finish publishing the already durable
      // commit while a reader releases its mapping. Byte equality is too
      // strict for that transition, but never discard observed commit claims.
      // Every valid old header must have been proved against its actual WAL
      // commit frame during this full scan. Both new copies must coherently
      // describe the exact same terminal WAL commit, not an older prefix.
      if(!retry?.priorClaimsVerified||!coherentIndexHeader(bytes)||
        !indexHeaderMatchesCommit(bytes.subarray(0,48),retry.wal.header,
          retry.wal.currentFrames,retry.wal.commitPages,retry.wal.digest))fail();
      // Preserve the stronger witness even if this attempt is also unstable.
      anchor.indexHeaders=Buffer.from(bytes.subarray(0,96));
    }
    if(retry&&!anchor){
      // Preserve both commit-header copies and the fully verified WAL.
      // Reader marks may legitimately move; commit evidence may not vanish.
      retry.state.anchor={wal:retry.wal,index:opened,
        indexHeaders:Buffer.from(bytes.subarray(0,96))};
    }
    const after=await handle.stat();
    assertSnapshotMetadata(after,opened,Boolean(retry));
    await assertStablePath(file,opened,Boolean(retry));
    return {bytes,dev:opened.dev,ino:opened.ino,size:opened.size,
      mtimeMs:opened.mtimeMs,ctimeMs:opened.ctimeMs};
  }finally{await handle.close();}
}

function validIndexHeader(bytes:Buffer):boolean{
  const nativeBig=endianness()==='BE';
  const u32=(at:number)=>nativeBig?bytes.readUInt32BE(at):bytes.readUInt32LE(at);
  const checksum=fold(bytes,40,nativeBig,{s0:0,s1:0});
  const encodedPage=nativeBig?bytes.readUInt16BE(14):bytes.readUInt16LE(14);
  const pageSize=encodedPage===1?65536:encodedPage;
  return u32(0)===3007000&&u32(4)===0&&bytes[12]===1&&
    (bytes[13]===0||bytes[13]===1)&&
    (pageSize===0||(pageSize>=512&&pageSize<=65536&&
      (pageSize&(pageSize-1))===0))&&
    u32(40)===checksum.s0&&u32(44)===checksum.s1;
}

function indexU32(bytes:Buffer,at:number):number{
  return endianness()==='BE'?bytes.readUInt32BE(at):bytes.readUInt32LE(at);
}
function indexHeaderSameGeneration(bytes:Buffer,walHeader:Buffer):boolean{
  const nativeBig=endianness()==='BE';
  const encodedPage=nativeBig?bytes.readUInt16BE(14):bytes.readUInt16LE(14);
  const rawPage=walHeader.readUInt32BE(8);
  const pageSize=rawPage===1?65536:rawPage;
  return bytes.subarray(32,40).equals(walHeader.subarray(16,24))&&
    encodedPage===(pageSize===65536?1:pageSize)&&
    bytes[13]===Number(walHeader.readUInt32BE(0)===0x377f0683);
}
function indexHeaderMatchesCommit(bytes:Buffer,walHeader:Buffer,frames:number,
  commitPages:number,digest:Checksum):boolean{
  return commitPages>0&&validIndexHeader(bytes)&&
    indexHeaderSameGeneration(bytes,walHeader)&&indexU32(bytes,16)===frames&&
    indexU32(bytes,20)===commitPages&&indexU32(bytes,24)===digest.s0&&
    indexU32(bytes,28)===digest.s1;
}

function coherentIndexHeader(bytes:Buffer):boolean{
  return bytes.subarray(0,48).equals(bytes.subarray(48,96))&&
    validIndexHeader(bytes.subarray(0,48));
}

// A zero-byte WAL or a valid header without frames can be legitimate after
// TRUNCATE or before the first write. But a retained index reporting committed
// frames contradicts an empty WAL: SQLite can silently ignore that history.
async function readFramelessIndex(dbFile:string):Promise<IndexSnapshot|undefined>{
  const index=await readIndexSnapshot(dbFile,true);
  if(!index)return undefined;
  const {bytes}=index;
  const nativeBig=endianness()==='BE';
  const u32=(at:number)=>nativeBig?bytes.readUInt32BE(at):bytes.readUInt32LE(at);
  // An all-zero header is uninitialized, not evidence of durable history.
  if(!bytes.subarray(0,96).every(value=>value===0)&&
    (!coherentIndexHeader(bytes)||u32(16)!==0))fail();
  if(u32(96)!==0||u32(128)!==0)fail();
  return index;
}

// For a fully checksummed nonempty WAL, SQLite may recover even if its
// volatile index is absent, uninitialized, torn, or behind the durable WAL.
// Inspect both header copies independently. SQLite can be interrupted during
// its index-header update; disagreement does not erase positive evidence from
// a structurally valid, checksummed header of the SAME WAL generation.
// A greater commit count or different terminal checksum at the same count
// is a contradiction, not proof of authenticity. A torn or lagging index
// without such evidence must still permit a fully checksummed WAL.
async function rejectContradictoryCommitIndex(dbFile:string,walHeader:Buffer,
  pageSize:number,currentFrames:number,commitPages:number,digest:Checksum,
  retry:RetryRead):Promise<void>{
  const index=await readIndexSnapshot(dbFile,false,retry);
  if(!index)return;
  const nativeBig=endianness()==='BE';
  for(const offset of [0,48]){
    const bytes=index.bytes.subarray(offset,offset+48);
    if(!validIndexHeader(bytes))continue;
    const u32=(at:number)=>nativeBig?bytes.readUInt32BE(at):bytes.readUInt32LE(at);
    const encodedPage=nativeBig?bytes.readUInt16BE(14):bytes.readUInt16LE(14);
    if(!bytes.subarray(32,40).equals(walHeader.subarray(16,24))||
      encodedPage!==(pageSize===65536?1:pageSize)||
      bytes[13]!==Number(walHeader.readUInt32BE(0)===0x377f0683))continue;
    const committed=u32(16);
    if(committed>currentFrames||
      (committed===currentFrames&&(u32(20)!==commitPages||
        u32(24)!==digest.s0||u32(28)!==digest.s1)))fail();
  }
}

async function assertFramelessWal(dbFile:string,walFile:string,opened:FileSnapshot,
  handle:fs.FileHandle,header?:Buffer):Promise<void>{
  const first=await readFramelessIndex(dbFile);
  await assertStablePath(walFile,opened);
  if(header){
    const checked=Buffer.alloc(32);
    await readExactly(handle,checked,checked.length,0);
    if(!checked.equals(header))fail();
  }
  const second=await readFramelessIndex(dbFile);
  if(Boolean(first)!==Boolean(second))fail();
  if(first&&second&&(first.dev!==second.dev||first.ino!==second.ino||
    first.size!==second.size||first.mtimeMs!==second.mtimeMs||
    first.ctimeMs!==second.ctimeMs||!first.bytes.equals(second.bytes)))fail();
  await assertStablePath(walFile,opened);
}

// SQLite reuses WAL allocation after RESTART without truncating old frames.
// The volatile WAL-index only corroborates a clean current commit boundary.
// It is NOT an authenticity/rollback witness or a replacement for external CAS.
async function readReuseIndex(dbFile:string,walHeader:Buffer,pageSize:number,
  currentFrames:number,commitPages:number,digest:Checksum):Promise<{
    bytes:Buffer;dev:number;ino:number;size:number;mtimeMs:number;ctimeMs:number;
  }>{
  let prior;
  try{prior=await fs.lstat(dbFile+'-shm');}catch{fail();}
  if(!prior.isFile()||prior.isSymbolicLink())fail();
  // If the WAL-index disappears between lstat and open, this is an
  // inconsistent snapshot, not a generic startup I/O failure.
  let handle:fs.FileHandle;
  try{handle=await fs.open(dbFile+'-shm','r');}
  catch(e){
    if((e as NodeJS.ErrnoException).code==='ENOENT')fail();
    throw e;
  }
  try{
    const opened=await handle.stat();
    // Inode identity alone does not catch an in-place SHM rewrite between
    // lstat and open. Native singleton ownership is still required.
    if(!opened.isFile()||opened.dev!==prior.dev||opened.ino!==prior.ino||
       opened.size!==prior.size||opened.mtimeMs!==prior.mtimeMs||
       opened.ctimeMs!==prior.ctimeMs||
       opened.size<32768||opened.size%32768!==0)fail();
    const bytes=Buffer.alloc(136);
    await readExactly(handle,bytes,bytes.length,0);
    const nativeBig=endianness()==='BE';
    const u32=(at:number)=>nativeBig?bytes.readUInt32BE(at):bytes.readUInt32LE(at);
    const szPage=nativeBig?bytes.readUInt16BE(14):bytes.readUInt16LE(14);
    const checksum=fold(bytes,40,nativeBig,{s0:0,s1:0});
    if(!bytes.subarray(0,48).equals(bytes.subarray(48,96))||
       u32(0)!==3007000||u32(4)!==0||bytes[12]!==1||
       bytes[13]!==Number(walHeader.readUInt32BE(0)===0x377f0683)||
       szPage!==(pageSize===65536?1:pageSize)||
       u32(16)!==currentFrames||u32(20)!==commitPages||
       u32(24)!==digest.s0||u32(28)!==digest.s1||
       !bytes.subarray(32,40).equals(walHeader.subarray(16,24))||
       u32(40)!==checksum.s0||u32(44)!==checksum.s1||
       u32(96)>currentFrames||u32(128)>currentFrames)fail();
    const after=await handle.stat();
    if(after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||
       after.ctimeMs!==opened.ctimeMs)fail();
    await assertStablePath(dbFile+'-shm',opened);
    return {bytes,dev:opened.dev,ino:opened.ino,size:opened.size,
      mtimeMs:opened.mtimeMs,ctimeMs:opened.ctimeMs};
  }finally{await handle.close();}
}

/**
 * Call while holding the native singleton; the journal must not be opened
 * concurrently from another path. Reads frame-by-frame to avoid loading the
 * entire WAL into memory. An invalid/torn current tail denies startup. A
 * prior-generation allocation tail needs a matching stable WAL-index boundary.
 */
export async function verifyAgentJournalWal(dbFile:string):Promise<void>{
  // Never open SQLite, trust an unstable index, or infer IN_USE from a
  // filesystem race. Discard the entire failed scan and reopen/revalidate
  // both files from byte zero, at most twice. Only the journal's existing
  // OS incarnation + transaction checks can decide ownership.
  const backoff=[10,25] as const;
  const state:RetryState={};
  for(let attempt=0;;attempt++){
    try{await verifyAgentJournalWalOnce(dbFile,state);return;}
    catch(error){
      const wait=backoff[attempt];
      if(!(error instanceof AgentJournalWalUnstableError)||wait===undefined)throw error;
      await delay(wait);
    }
  }
}

async function verifyAgentJournalWalOnce(dbFile:string,state:RetryState):Promise<void>{
  const anchor=state.anchor;
  const walFile=dbFile+'-wal';
  let prior;
  try{prior=await fs.lstat(walFile)}catch(e){
    if((e as NodeJS.ErrnoException).code==='ENOENT'){
      // An observed committed WAL must not become a clean-start case
      // just because both sidecars disappear between retry attempts.
      if(anchor)fail();
      // A missing WAL with an orphaned SHM can conceal committed WAL-only
      // journal entries (including UNKNOWN anti-replay tombstones). SQLite
      // may reopen the base database without those entries. This is not the
      // normal clean-start case where both sidecars are absent.
      try{await fs.lstat(dbFile+'-shm');}
      catch(shmError){
        if((shmError as NodeJS.ErrnoException).code==='ENOENT')return;
        throw shmError;
      }
      fail();
    }
    throw e;
  }
  if(!prior.isFile()||prior.isSymbolicLink()){
    throw new AgentJournalWalError('SQLite WAL path is not a regular file.');
  }
  if(anchor)assertSnapshotMetadata(prior,anchor.wal.file,false);
  // An observed WAL that vanishes before open is not the same as a WAL
  // that was absent at initial lstat. Deny with the journal's fail-closed
  // diagnostic code rather than leaking a raw filesystem ENOENT.
  let handle:fs.FileHandle;
  try{handle=await fs.open(walFile,'r');}
  catch(e){
    if((e as NodeJS.ErrnoException).code==='ENOENT')fail();
    throw e;
  }
  try{
    const opened=await handle.stat();
    // Verify pre-open metadata, not only the inode. An in-place truncate
    // between lstat and open must not be reclassified as a legitimate empty
    // WAL, which would silently discard possible journal reservations.
    if(!opened.isFile()||opened.dev!==prior.dev||
       opened.ino!==prior.ino||opened.size!==prior.size||
       opened.mtimeMs!==prior.mtimeMs||opened.ctimeMs!==prior.ctimeMs)fail();
    // Empty allocation is legitimate only without contradictory index
    // evidence. A retained committed index can reveal a lost WAL-only row.
    if(opened.size===0){
      await assertFramelessWal(dbFile,walFile,opened,handle);
      return;
    }
    if(opened.size<32)fail();
    const header=Buffer.alloc(32);
    await readExactly(handle,header,32,0);
    const magic=header.readUInt32BE(0);
    if(magic!==0x377f0682&&magic!==0x377f0683)fail();
    if(header.readUInt32BE(4)!==3007000)fail();
    const rawPageSize=header.readUInt32BE(8);
    const pageSize=rawPageSize===1?65536:rawPageSize;
    if(pageSize<512||pageSize>65536||(pageSize&(pageSize-1))!==0)fail();
    const bigEndian=magic===0x377f0683;
    let digest=fold(header,24,bigEndian,{s0:0,s1:0});
    if(header.readUInt32BE(24)!==digest.s0||
       header.readUInt32BE(28)!==digest.s1)fail();
    const frameBytes=24+pageSize;
    if((opened.size-32)%frameBytes!==0)fail();
    if(opened.size===32){
      await assertFramelessWal(dbFile,walFile,opened,handle,header);
      return;
    }
    const frame=Buffer.allocUnsafe(frameBytes);
    let currentFrames=0,lastCommitPages=0;
    // At most two anchored, checksummed header claims. Verify each against
    // the actual committed prefix, not just the terminal frame count. Do
    // not retain all frame digests or allocate memory proportional to WAL.
    const priorClaims=anchor?[0,48].map(offset=>
      anchor.indexHeaders.subarray(offset,offset+48)).filter(validIndexHeader):[];
    const unmatchedClaims=new Set(priorClaims);
    let oldSalt:Buffer|undefined;
    let oldGenerationDistance=0;
    let reuseIndex:Awaited<ReturnType<typeof readReuseIndex>>|undefined;
    for(let position=32;position<opened.size;position+=frameBytes){
      await readExactly(handle,frame,frameBytes,position);
      if(frame.readUInt32BE(0)===0)fail();
      const currentSalt=frame.subarray(8,16).equals(header.subarray(16,24));
      if(!currentSalt){
        const distance=(header.readUInt32BE(16)-frame.readUInt32BE(8))>>>0;
        if(distance===0||distance>0x7fffffff)fail();
        if(!oldSalt){
          if(currentFrames===0||lastCommitPages===0)fail();
          oldSalt=Buffer.from(frame.subarray(8,16));
          oldGenerationDistance=distance;
          reuseIndex=await readReuseIndex(dbFile,header,pageSize,
            currentFrames,lastCommitPages,digest);
        }else{
          // Repeated short rewrites can retain several older generations.
          // Moving outward through the allocation cannot become newer again.
          if(distance<oldGenerationDistance)fail();
          if(distance===oldGenerationDistance&&!frame.subarray(8,16).equals(oldSalt))fail();
          if(distance>oldGenerationDistance){
            oldSalt=Buffer.from(frame.subarray(8,16));oldGenerationDistance=distance;
          }
        }
        continue;
      }
      if(oldSalt)fail(); // No new current-generation frames after the old tail.
      digest=fold(frame,8,bigEndian,digest);
      digest=fold(frame.subarray(24),pageSize,bigEndian,digest);
      if(frame.readUInt32BE(16)!==digest.s0||
         frame.readUInt32BE(20)!==digest.s1)fail();
      currentFrames++;
      lastCommitPages=frame.readUInt32BE(4);
      for(const claim of unmatchedClaims){
        if(indexU32(claim,16)===currentFrames&&
          indexHeaderMatchesCommit(claim,header,currentFrames,lastCommitPages,digest))
          unmatchedClaims.delete(claim);
      }
    }
    // A checksummed but uncommitted current-generation suffix may be ignored
    // during SQLite recovery. Do not silently discard possible reservation
    // history: every nonempty current generation must end at a commit frame.
    // Ordinary RESTART/reuse tails remain valid after their committed prefix.
    if(currentFrames>0&&lastCommitPages===0)fail();
    if(anchor&&(reuseIndex||!header.equals(anchor.wal.header)||
      currentFrames!==anchor.wal.currentFrames||lastCommitPages!==anchor.wal.commitPages||
      digest.s0!==anchor.wal.digest.s0||digest.s1!==anchor.wal.digest.s1))fail();
    const after=await handle.stat();
    if(after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||
       after.ctimeMs!==opened.ctimeMs)fail();
    if(reuseIndex){
      const checked=await readReuseIndex(dbFile,header,pageSize,
        currentFrames,lastCommitPages,digest);
      if(checked.dev!==reuseIndex.dev||checked.ino!==reuseIndex.ino||
         checked.size!==reuseIndex.size||checked.mtimeMs!==reuseIndex.mtimeMs||
         checked.ctimeMs!==reuseIndex.ctimeMs||
         !checked.bytes.equals(reuseIndex.bytes))fail();
      const stable=await handle.stat();
      if(stable.size!==opened.size||stable.mtimeMs!==opened.mtimeMs||
         stable.ctimeMs!==opened.ctimeMs)fail();
    }
    // Read back after the scan. This detects a late in-place header rewrite
    // and checks that the path still resolves to the validated inode.
    const finalHeader=Buffer.alloc(32);
    await readExactly(handle,finalHeader,32,0);
    if(!finalHeader.equals(header))fail();
    const finalStat=await handle.stat();
    if(finalStat.size!==opened.size||finalStat.mtimeMs!==opened.mtimeMs||
       finalStat.ctimeMs!==opened.ctimeMs)fail();
    await assertStablePath(walFile,opened);
    if(reuseIndex){
      const finalIndex=await readReuseIndex(dbFile,header,pageSize,
        currentFrames,lastCommitPages,digest);
      if(finalIndex.dev!==reuseIndex.dev||finalIndex.ino!==reuseIndex.ino||
         finalIndex.size!==reuseIndex.size||
         finalIndex.mtimeMs!==reuseIndex.mtimeMs||
         finalIndex.ctimeMs!==reuseIndex.ctimeMs||
         !finalIndex.bytes.equals(reuseIndex.bytes))fail();
    }else{
      await rejectContradictoryCommitIndex(dbFile,header,pageSize,
        currentFrames,lastCommitPages,digest,{state,wal:{file:opened,
          header,currentFrames,commitPages:lastCommitPages,digest},
          priorClaimsVerified:priorClaims.length>0&&unmatchedClaims.size===0});
      await assertStablePath(walFile,opened);
    }
  }finally{
    await handle.close();
  }
}
