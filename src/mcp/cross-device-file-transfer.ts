import {createHash,randomUUID} from 'node:crypto';

export const CROSS_DEVICE_CHUNK_BYTES=48*1024;
export const CROSS_DEVICE_MAX_BYTES=64*1024*1024;
export class CrossDeviceTransferError extends Error {
  constructor(public readonly code:string,message:string){
    super(message);
    this.name='CrossDeviceTransferError';
  }
}
export interface TransferStat {size:number;type:string}
export interface TransferRead {sourceBytes:number;offsetBytes:number;bytesRead:number;content:string}
export interface CrossDeviceFileTransferOps {
  statSource():Promise<TransferStat>;
  hashSource():Promise<string>;
  readSource(offsetBytes:number,maxBytes:number):Promise<TransferRead>;
  writeStage(stage:string,content:string,offsetBytes:number,first:boolean):Promise<number>;
  hashStage(stage:string):Promise<string>;
  commitStage(stage:string,destination:string):Promise<void>;
  cleanupStage(stage:string):Promise<void>;
}
const hex=/^[0-9a-f]{64}$/i;
export async function transferCrossDeviceFile(
  destinationPath:string,
  ops:CrossDeviceFileTransferOps,
  options:{chunkBytes?:number;maxBytes?:number;newId?:()=>string}={}
){
  if(typeof destinationPath!=='string'||destinationPath.length<1||destinationPath.length>4000){
    throw new CrossDeviceTransferError('TRANSFER_DESTINATION_INVALID','Destination path is invalid.');
  }
  const chunkBytes=options.chunkBytes??CROSS_DEVICE_CHUNK_BYTES;
  const maxBytes=options.maxBytes??CROSS_DEVICE_MAX_BYTES;
  if(!Number.isSafeInteger(chunkBytes)||chunkBytes<1||chunkBytes>64*1024||
     !Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>CROSS_DEVICE_MAX_BYTES){
    throw new CrossDeviceTransferError('TRANSFER_LIMIT_INVALID','Transfer bounds are invalid.');
  }
  const stat=await ops.statSource();
  if(stat?.type!=='file'||!Number.isSafeInteger(stat.size)||stat.size<0||
     stat.size>maxBytes){
    throw new CrossDeviceTransferError('TRANSFER_SOURCE_INVALID',
      'The source is not a regular file within the transfer size limit.');
  }
  const startingHash=(await ops.hashSource()).toLowerCase();
  if(!hex.test(startingHash)){
    throw new CrossDeviceTransferError('TRANSFER_SOURCE_HASH_UNAVAILABLE',
      'The source did not provide a valid SHA-256 digest.');
  }
  const id=options.newId?.()??randomUUID();
  if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id))
    throw new CrossDeviceTransferError('TRANSFER_ID_INVALID','Invalid transfer ID.');
  const stage=destinationPath+'.nexowire-upload-'+id+'.tmp';
  let created=false,bytesTransferred=0;
  try{
    for(let offset=0;offset<stat.size||offset===0;){
      const expected=Math.min(chunkBytes,stat.size-offset);
      const part=expected===0
        ? {sourceBytes:0,offsetBytes:0,bytesRead:0,content:''}
        : await ops.readSource(offset,expected);
      if(part.sourceBytes!==stat.size||part.offsetBytes!==offset||
         part.bytesRead!==expected||typeof part.content!=='string'){
        throw new CrossDeviceTransferError('TRANSFER_SOURCE_CHANGED',
          'The source file changed during chunked reading.');
      }
      const buf=Buffer.from(part.content,'base64');
      if(buf.length!==expected||buf.toString('base64')!==part.content){
        throw new CrossDeviceTransferError('TRANSFER_CHUNK_INVALID',
          'The returned source chunk is not valid canonical Base64.');
      }
      // Only clean up a stage we know was created by this transfer.
      // In particular, a failed exclusive create may mean the stage already
      // belonged to another writer; deleting it would destroy their data.
      const wrote=await ops.writeStage(stage,part.content,offset,offset===0);
      created=true;
      if(wrote!==expected){
        throw new CrossDeviceTransferError('TRANSFER_WRITE_INCOMPLETE',
          'The destination accepted an incomplete chunk.');
      }
      bytesTransferred+=wrote;
      if(stat.size===0)break;
      offset+=expected;
    }
    if((await ops.hashSource()).toLowerCase()!==startingHash){
      throw new CrossDeviceTransferError('TRANSFER_SOURCE_CHANGED',
        'The source SHA-256 changed while transferring.');
    }
    if((await ops.hashStage(stage)).toLowerCase()!==startingHash){
      throw new CrossDeviceTransferError('TRANSFER_HASH_MISMATCH',
        'The destination staging digest does not match the source.');
    }
    await ops.commitStage(stage,destinationPath);
    created=false;
    return {state:'COMPLETE' as const,bytesTransferred,
      sha256:startingHash,chunkBytes,chunkCount:Math.max(1,Math.ceil(stat.size/chunkBytes)),
      destination:destinationPath};
  }finally{
    if(created)await ops.cleanupStage(stage).catch(()=>undefined);
  }
}
