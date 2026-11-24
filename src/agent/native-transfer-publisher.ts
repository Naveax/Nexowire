import {createHash,verify,type KeyObject} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {hashNativeTransferFile,nativeHashPolicy} from './native-transfer-io.js';
import type {LargeTransferBinding,LargeTransferLease,LargeTransferIntent,LargeTransferFinalReceipt,LargeTransferWriteReceipt} from '../mcp/durable-large-transfer.js';

// Only a protected native bootstrap may install this authority. It must
// enforce current owner/device grant, exact epoch/offset/request CAS and
// exclusive protection of the two canonical paths from other mutations for
// the entire callback. Local locks, an ACK, or Hub checks cannot implement it.
export interface NativeTransferAdmission {
  admit(binding:Readonly<LargeTransferBinding>,lease:Readonly<LargeTransferLease>,intent:Readonly<LargeTransferIntent>,effect:()=>Promise<void>):Promise<void>;
  resolveProtectedPaths(binding:Readonly<LargeTransferBinding>):Promise<{stage:string;target:string}>;
  // OS-specific durable namespace flush (including Windows); no best-effort fallback.
  flushDirectory(directory:string):Promise<void>;
  signFinal(bytes:Buffer):Promise<string>;
  // Immutable, durable protected receipt storage, keyed by original intent.
  persistFinalReceipt(binding:Readonly<LargeTransferBinding>,intent:Readonly<LargeTransferIntent>,receipt:Readonly<LargeTransferFinalReceipt>):Promise<void>;
}
const digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const hex=/^[a-f0-9]{64}$/;
const uuid=/^[0-9a-f]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const safe=(n:number)=>Number.isSafeInteger(n)&&n>=0;
const deny=(code:string):never=>{throw Error(code);};
export function finalTransferSigningBytes(b:Readonly<LargeTransferBinding>,r:Omit<LargeTransferFinalReceipt,'proof'>):Buffer{
  return Buffer.from(JSON.stringify(['nexowire.native-transfer.final.v1',b.ownerId,b.projectId,b.sourceDeviceId,b.sourcePath,b.targetDeviceId,b.targetPath,b.stagePath,b.id,b.size,b.sha256,r.jobId,r.requestId,r.epoch,r.targetDeviceId,r.targetPath,r.size,r.sha256]),'utf8');
}
export function verifyNativeTransferReceipt(b:Readonly<LargeTransferBinding>,r:LargeTransferFinalReceipt,registeredKey:KeyObject):boolean{
  if(!r||registeredKey.type!=='public'||registeredKey.asymmetricKeyType!=='ed25519'||r.jobId!==b.id||!uuid.test(r.requestId)||!safe(r.epoch)||r.epoch<1||r.targetDeviceId!==b.targetDeviceId||r.targetPath!==b.targetPath||r.size!==b.size||r.sha256!==b.sha256||typeof r.proof!=='string'||r.proof.length!==86)return false;
  const signature=Buffer.from(r.proof,'base64url');
  return signature.length===64&&signature.toString('base64url')===r.proof&&verify(null,finalTransferSigningBytes(b,r),registeredKey,signature);
}
export class NativeTransferPublisher {
  constructor(private readonly deviceId:string,private readonly admission:NativeTransferAdmission){
    if(!deviceId||!admission||!['admit','resolveProtectedPaths','flushDirectory','signFinal','persistFinalReceipt'].every(k=>typeof (admission as unknown as Record<string,unknown>)[k]==='function'))deny('NATIVE_TRANSFER_AUTHORITY_REQUIRED');
  }
  private validate(b:Readonly<LargeTransferBinding>,l:Readonly<LargeTransferLease>,p:Readonly<LargeTransferIntent>,kind:'write'|'publish'){
    if(!b||!l||!p||b.targetDeviceId!==this.deviceId||b.sourceDeviceId===b.targetDeviceId||!uuid.test(b.id)||!uuid.test(p.requestId)||!safe(b.size)||b.size>nativeHashPolicy()||!hex.test(b.sha256)||!safe(l.epoch)||l.epoch<1||typeof l.token!=='string'||l.token.length<32||l.token.length>256||p.epoch!==l.epoch||p.kind!==kind||p.dispatched!==true||!safe(p.offset)||p.offset>b.size||!safe(p.length)||p.length>65536||p.length>b.size-p.offset||!hex.test(p.sha256)||b.stagePath!==b.targetPath+'.nexowire-upload-'+b.id+'.part')deny('NATIVE_TRANSFER_INTENT_INVALID');
  }
  private async execute<T>(b:Readonly<LargeTransferBinding>,l:Readonly<LargeTransferLease>,p:Readonly<LargeTransferIntent>,effect:(stage:string,target:string)=>Promise<T>):Promise<T>{
    let active=true,called=false,done=false,result!:T;
    try{
      await this.admission.admit(b,l,p,async()=>{
        if(!active||called)deny('NATIVE_TRANSFER_CALLBACK_INVALID');called=true;
        const paths=await this.admission.resolveProtectedPaths(b);
        if(!active||!path.isAbsolute(paths.stage)||!path.isAbsolute(paths.target)||paths.stage!==path.resolve(b.stagePath)||paths.target!==path.resolve(b.targetPath)||path.dirname(paths.stage)!==path.dirname(paths.target)||paths.stage===paths.target)deny('NATIVE_TRANSFER_PATH_DENIED');
        result=await effect(paths.stage,paths.target);done=true;
      });
      if(!called||!done)deny('NATIVE_TRANSFER_EFFECT_UNCONFIRMED');
      return result;
    }finally{active=false;}
  }
  async writeFenced(binding:Readonly<LargeTransferBinding>,lease:Readonly<LargeTransferLease>,intent:Readonly<LargeTransferIntent>,base64:string,first:boolean):Promise<LargeTransferWriteReceipt>{
    const b=Object.freeze({...binding}),l=Object.freeze({...lease}),p=Object.freeze({...intent});
    this.validate(b,l,p,'write');
    if(typeof first!=='boolean'||first!==(p.offset===0)||p.length===0&&(b.size!==0||!first)||typeof base64!=='string'||base64.length!==4*Math.ceil(p.length/3))deny('NATIVE_TRANSFER_CHUNK_INVALID');
    const bytes=Buffer.from(base64,'base64');
    if(bytes.length!==p.length||bytes.toString('base64')!==base64||digest(bytes)!==p.sha256)deny('NATIVE_TRANSFER_CHUNK_INVALID');
    return this.execute(b,l,p,async stage=>{
      const before=first?undefined:await fs.lstat(stage,{bigint:true});
      if(before&&(!before.isFile()||before.size!==BigInt(p.offset)||before.nlink!==1n))deny('NATIVE_TRANSFER_OFFSET_MISMATCH');
      const fd=await fs.open(stage,first?'wx':'r+',0o600);
      try{
        const opened=await fd.stat({bigint:true});
        if(!opened.isFile()||opened.size!==BigInt(p.offset)||opened.nlink!==1n||before&&(before.dev!==opened.dev||before.ino!==opened.ino))deny('NATIVE_TRANSFER_OFFSET_MISMATCH');
        for(let n=0;n<bytes.length;){const r=await fd.write(bytes,n,bytes.length-n,p.offset+n);if(r.bytesWritten<=0)deny('NATIVE_TRANSFER_SHORT_WRITE');n+=r.bytesWritten;}
        await fd.sync();
        const after=await fd.stat({bigint:true}),current=await fs.lstat(stage,{bigint:true});
        if(after.size!==BigInt(p.offset+p.length)||after.dev!==current.dev||after.ino!==current.ino||after.nlink!==1n||current.nlink!==1n)deny('NATIVE_TRANSFER_STAGE_CHANGED');
      }finally{await fd.close();}
      if(first)await this.admission.flushDirectory(path.dirname(stage));
      return {requestId:p.requestId,epoch:p.epoch,offset:p.offset,length:p.length,sha256:p.sha256};
    });
  }
  async publishFenced(binding:Readonly<LargeTransferBinding>,lease:Readonly<LargeTransferLease>,intent:Readonly<LargeTransferIntent>):Promise<LargeTransferFinalReceipt>{
    const b=Object.freeze({...binding}),l=Object.freeze({...lease}),p=Object.freeze({...intent});
    this.validate(b,l,p,'publish');
    if(p.offset!==b.size||p.length!==0||p.sha256!==b.sha256)deny('NATIVE_TRANSFER_PUBLISH_INVALID');
    return this.execute(b,l,p,async(stage,target)=>{
      const s=await fs.lstat(stage,{bigint:true});
      if(!s.isFile()||s.nlink!==1n||s.size!==BigInt(b.size))deny('NATIVE_TRANSFER_STAGE_CHANGED');
      const hash=await hashNativeTransferFile(stage,Math.max(1,b.size));
      if(hash.size!==b.size||hash.sha256!==b.sha256)deny('NATIVE_TRANSFER_STAGE_CHANGED');
      // Atomic no-replace namespace operation. Never unlink an existing target.
      // If any later step fails, keep the original intent UNKNOWN, never retry.
      await fs.link(stage,target);
      const linked=await fs.lstat(target,{bigint:true}),current=await fs.lstat(stage,{bigint:true});
      if(linked.dev!==s.dev||linked.ino!==s.ino||current.dev!==s.dev||current.ino!==s.ino||linked.nlink!==2n)deny('NATIVE_TRANSFER_PUBLISH_CHANGED');
      await fs.unlink(stage);
      await this.admission.flushDirectory(path.dirname(target));
      const final=await hashNativeTransferFile(target,Math.max(1,b.size));
      const info=await fs.lstat(target,{bigint:true});
      if(info.dev!==s.dev||info.ino!==s.ino||info.nlink!==1n||final.size!==b.size||final.sha256!==b.sha256)deny('NATIVE_TRANSFER_PUBLISH_CHANGED');
      const receipt={jobId:b.id,requestId:p.requestId,epoch:p.epoch,targetDeviceId:b.targetDeviceId,targetPath:b.targetPath,size:b.size,sha256:b.sha256};
      const proof=await this.admission.signFinal(finalTransferSigningBytes(b,receipt));
      if(typeof proof!=='string'||proof.length!==86||Buffer.from(proof,'base64url').toString('base64url')!==proof)deny('NATIVE_TRANSFER_SIGNER_INVALID');
      const signed=Object.freeze({...receipt,proof});
      await this.admission.persistFinalReceipt(b,p,signed);
      return signed;
    });
  }
}
