import {promises as fs} from 'node:fs';
import {endianness} from 'node:os';

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
async function assertStablePath(file:string,opened:FileSnapshot):Promise<void>{
  let current;
  try{current=await fs.lstat(file)}catch{fail();}
  if(!current.isFile()||current.isSymbolicLink()||
     current.dev!==opened.dev||current.ino!==opened.ino||
     current.size!==opened.size||current.mtimeMs!==opened.mtimeMs||
     current.ctimeMs!==opened.ctimeMs)fail();
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
  const handle=await fs.open(dbFile+'-shm','r');
  try{
    const opened=await handle.stat();
    if(!opened.isFile()||opened.dev!==prior.dev||opened.ino!==prior.ino||
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
  const walFile=dbFile+'-wal';
  let prior;
  try{prior=await fs.lstat(walFile)}catch(e){
    if((e as NodeJS.ErrnoException).code==='ENOENT')return;
    throw e;
  }
  if(!prior.isFile()||prior.isSymbolicLink()){
    throw new AgentJournalWalError('SQLite WAL path is not a regular file.');
  }
  const handle=await fs.open(walFile,'r');
  try{
    const opened=await handle.stat();
    if(!opened.isFile()||opened.dev!==prior.dev||
       opened.ino!==prior.ino)fail();
    // An empty WAL is legitimate, but it must still resolve to the opened
    // inode. Do not let the short-circuit omit the namespace readback.
    if(opened.size===0){
      await assertStablePath(walFile,opened);
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
    const frame=Buffer.allocUnsafe(frameBytes);
    let currentFrames=0,lastCommitPages=0;
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
    }
    // A checksummed but uncommitted current-generation suffix may be ignored
    // during SQLite recovery. Do not silently discard possible reservation
    // history: every nonempty current generation must end at a commit frame.
    // Ordinary RESTART/reuse tails remain valid after their committed prefix.
    if(currentFrames>0&&lastCommitPages===0)fail();
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
    }
  }finally{
    await handle.close();
  }
}
