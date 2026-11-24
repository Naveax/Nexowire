import {createHash} from 'node:crypto';
import {promises as fs,type BigIntStats} from 'node:fs';
import type {FileHandle} from 'node:fs/promises';

// Total file size and single-response size are separate limits. Offsets use
// exact JS safe integers; reads retain the existing bounded payload ceiling.
export const NATIVE_MAX_FILE_OFFSET=Number.MAX_SAFE_INTEGER;
export const NATIVE_MAX_READ_BYTES=16_777_216;
export const NATIVE_DEFAULT_HASH_POLICY_BYTES=4*1024**3;
const HASH_BUFFER_BYTES=1024*1024;

/** The Agent owner can provision a larger or smaller explicit I/O budget.
 * The legacy per-request default remains 64 MiB in the capability schema. */
export function nativeHashPolicy(raw=process.env.NEXOWIRE_NATIVE_FILE_HASH_MAX_BYTES):number{
  if(raw===undefined)return NATIVE_DEFAULT_HASH_POLICY_BYTES;
  if(!/^[1-9][0-9]*$/.test(raw))throw Error('Invalid native file hash policy.');
  const limit=Number(raw);
  if(!Number.isSafeInteger(limit)||limit<1)throw Error('Invalid native file hash policy.');
  return limit;
}
function sameRegular(a:BigIntStats,b:BigIntStats):boolean{
  return a.isFile()&&b.isFile()&&a.dev===b.dev&&a.ino===b.ino&&
    a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
}
async function pinned<T>(target:string,run:(file:FileHandle,size:number,stat:BigIntStats)=>Promise<T>):Promise<T>{
  const before=await fs.lstat(target,{bigint:true});
  if(!before.isFile())throw Error('Requested path is not a regular file.');
  const file=await fs.open(target,'r');
  try{
    const opened=await file.stat({bigint:true});
    if(!sameRegular(before,opened))throw Error('File changed between validation and open.');
    if(opened.size<0n||opened.size>BigInt(NATIVE_MAX_FILE_OFFSET))throw Error('File size exceeds exact offset representation.');
    const result=await run(file,Number(opened.size),opened);
    const after=await file.stat({bigint:true});
    const current=await fs.lstat(target,{bigint:true});
    if(!sameRegular(opened,after)||!sameRegular(opened,current))throw Error('File changed during pinned read.');
    return result;
  }finally{await file.close();}
}
async function fill(file:FileHandle,buffer:Buffer,offset:number,length:number):Promise<void>{
  let done=0;
  while(done<length){
    const result=await file.read(buffer,done,length-done,offset+done);
    if(result.bytesRead<=0)throw Error('File truncated during bounded read.');
    done+=result.bytesRead;
  }
}

/** Full reads remain size-capped. A range may address a large ordinary file
 * but never allocates beyond the requested, existing per-response limit. */
export async function readNativeTransferRange(target:string,offset:number|undefined,maxBytes:number){
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>NATIVE_MAX_READ_BYTES)
    throw Error('Invalid bounded read max_bytes.');
  if(offset!==undefined&&(!Number.isSafeInteger(offset)||offset<0))throw Error('Invalid read offset.');
  return pinned(target,async(file,size)=>{
    if(offset===undefined&&size>maxBytes)throw Error(`File size ${size} exceeds max_bytes ${maxBytes}.`);
    const start=offset??0;
    if(start>size)throw Error('Read offset exceeds file size.');
    const length=Math.min(maxBytes,size-start);
    const content=Buffer.alloc(length);
    await fill(file,content,start,length);
    return {size,offsetBytes:start,bytesRead:length,content};
  });
}

/** Hash exactly the pinned initial file size, with a bounded reusable buffer.
 * Growth, truncation, replacement and ordinary metadata changes fail closed;
 * no file is read beyond the caller's explicit and owner-provisioned budget. */
export async function hashNativeTransferFile(target:string,maxBytes:number,policyBytes=nativeHashPolicy()){
  if(!Number.isSafeInteger(policyBytes)||policyBytes<1)throw Error('Invalid native file hash policy.');
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>policyBytes)
    throw Error('Requested hash max_bytes exceeds native file hash policy.');
  return pinned(target,async(file,size,stat)=>{
    if(size>maxBytes)throw Error(`File size ${size} exceeds hash max_bytes ${maxBytes}.`);
    const hash=createHash('sha256');
    const buffer=Buffer.alloc(Math.min(HASH_BUFFER_BYTES,size));
    for(let offset=0;offset<size;){
      const length=Math.min(buffer.length,size-offset);
      await fill(file,buffer,offset,length);
      hash.update(buffer.subarray(0,length));
      offset+=length;
    }
    return {size,sha256:hash.digest('hex'),modifiedAt:new Date(Number(stat.mtimeMs)).toISOString()};
  });
}
