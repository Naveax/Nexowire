import {promises as fs} from 'node:fs';

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

/**
 * Call while holding the native singleton; the journal must not be opened
 * concurrently from another path. Reads frame-by-frame to avoid loading the
 * entire WAL into memory. An invalid/torn tail also denies mutation startup.
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
    if(opened.size===0)return;
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
    for(let position=32;position<opened.size;position+=frameBytes){
      await readExactly(handle,frame,frameBytes,position);
      if(frame.readUInt32BE(0)===0)fail();
      if(frame.readUInt32BE(8)!==header.readUInt32BE(16)||
         frame.readUInt32BE(12)!==header.readUInt32BE(20))fail();
      digest=fold(frame,8,bigEndian,digest);
      digest=fold(frame.subarray(24),pageSize,bigEndian,digest);
      if(frame.readUInt32BE(16)!==digest.s0||
         frame.readUInt32BE(20)!==digest.s1)fail();
    }
    const after=await handle.stat();
    if(after.size!==opened.size||after.mtimeMs!==opened.mtimeMs)fail();
  }finally{
    await handle.close();
  }
}
