import {type KeyObject} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {verifyNativeTransferReceipt} from './native-transfer-publisher.js';
import type {LargeTransferBinding,LargeTransferIntent,LargeTransferFinalReceipt} from '../mcp/durable-large-transfer.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const deny=(code:string):never=>{throw Error(code);};
const MAX_RECEIPT=16384;
function receiptFor(b:Readonly<LargeTransferBinding>,p:Readonly<LargeTransferIntent>,r:LargeTransferFinalReceipt,key:KeyObject){
  return p.kind==='publish'&&p.dispatched===true&&p.offset===b.size&&p.length===0&&p.sha256===b.sha256&&
    p.requestId===r.requestId&&p.epoch===r.epoch&&verifyNativeTransferReceipt(b,r,key);
}

/** Immutable receipts, original request UUID only. The caller must protect the
 * namespace for the whole operation and provide a real namespace flush. */
export class ProtectedTransferReceiptStore {
  constructor(private readonly root:string,private readonly publicKey:KeyObject,
    private readonly flush:(directory:string)=>Promise<void>){
    if(!path.isAbsolute(root)||publicKey.type!=='public'||publicKey.asymmetricKeyType!=='ed25519'||typeof flush!=='function')deny('TRANSFER_RECEIPT_STORE_CONFIG_INVALID');
  }
  private file(p:Readonly<LargeTransferIntent>){if(!uuid.test(p.requestId))return deny('TRANSFER_RECEIPT_ID_INVALID');return path.join(this.root,p.requestId+'.json');}
  async persist(b:Readonly<LargeTransferBinding>,p:Readonly<LargeTransferIntent>,r:Readonly<LargeTransferFinalReceipt>){
    if(!receiptFor(b,p,r,this.publicKey))deny('TRANSFER_RECEIPT_INVALID');
    const file=this.file(p),data=Buffer.from(JSON.stringify(r),'utf8');
    if(data.length>MAX_RECEIPT)deny('TRANSFER_RECEIPT_TOO_LARGE');
    // Never overwrite an existing receipt or repair an ambiguous partial file.
    const fd=await fs.open(file,'wx',0o600);
    try{await fd.writeFile(data);await fd.sync();const s=await fd.stat({bigint:true}),c=await fs.lstat(file,{bigint:true});
      if(!s.isFile()||!c.isFile()||s.nlink!==1n||c.nlink!==1n||s.dev!==c.dev||s.ino!==c.ino||s.size!==BigInt(data.length))deny('TRANSFER_RECEIPT_STORE_CHANGED');
    }finally{await fd.close();}
    await this.flush(this.root);
  }
  async lookup(b:Readonly<LargeTransferBinding>,p:Readonly<LargeTransferIntent>):Promise<LargeTransferFinalReceipt|undefined>{
    const file=this.file(p);let before;
    try{before=await fs.lstat(file,{bigint:true});}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}
    if(!before.isFile()||before.nlink!==1n||before.size<1n||before.size>BigInt(MAX_RECEIPT))return deny('TRANSFER_RECEIPT_STORE_CHANGED');
    const fd=await fs.open(file,'r');let bytes:Buffer;
    try{
      const opened=await fd.stat({bigint:true});
      if(opened.dev!==before.dev||opened.ino!==before.ino||opened.nlink!==1n||opened.size!==before.size)return deny('TRANSFER_RECEIPT_STORE_CHANGED');
      bytes=Buffer.alloc(Number(opened.size));let offset=0;
      while(offset<bytes.length){const n=await fd.read(bytes,offset,bytes.length-offset,offset);if(!n.bytesRead)return deny('TRANSFER_RECEIPT_STORE_CHANGED');offset+=n.bytesRead;}
      const after=await fd.stat({bigint:true}),current=await fs.lstat(file,{bigint:true});
      for(const s of [after,current])if(!s.isFile()||s.dev!==opened.dev||s.ino!==opened.ino||s.nlink!==1n||s.size!==opened.size||s.mtimeNs!==opened.mtimeNs||s.ctimeNs!==opened.ctimeNs)return deny('TRANSFER_RECEIPT_STORE_CHANGED');
    }finally{await fd.close();}
    const r=JSON.parse(bytes.toString('utf8')) as LargeTransferFinalReceipt;
    if(!r||Object.keys(r).sort().join(',')!=='epoch,jobId,proof,requestId,sha256,size,targetDeviceId,targetPath'||!receiptFor(b,p,r,this.publicKey))return deny('TRANSFER_RECEIPT_INVALID');
    // A previous persist may have failed AFTER writing the signed bytes but
    // BEFORE the namespace flush. Re-establish that barrier before returning
    // any recoverable receipt; never turn a failed flush into durable proof.
    await this.flush(this.root);
    return Object.freeze({...r});
  }
}
