import * as z from 'zod';
import path from 'node:path';
import type {NativeTransferPublisher} from './native-transfer-publisher.js';
import type {PathPolicy} from './path-policy.js';
import {nativeHashPolicy,NATIVE_MAX_FILE_OFFSET} from './native-transfer-io.js';

export const NATIVE_TRANSFER_CAPABILITIES=['files.transfer.limits','files.transfer.write_fenced','files.transfer.publish_fenced'] as const;
export function isNativeTransferCapability(capability:string):boolean{return (NATIVE_TRANSFER_CAPABILITIES as readonly string[]).includes(capability);}
const id=z.string().min(1).max(256),file=z.string().min(1).max(4096),uuid=z.string().uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/);
const size=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),epoch=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const binding=z.strictObject({ownerId:id,projectId:id,sourceDeviceId:id,targetDeviceId:id,id:uuid,sourcePath:file,targetPath:file,stagePath:file,size,sha256:sha});
const lease=z.strictObject({epoch,token:z.string().min(32).max(256)});
const intent=z.strictObject({kind:z.enum(['write','publish']),requestId:uuid,epoch,offset:size,length:z.number().int().min(0).max(65536),sha256:sha,dispatched:z.literal(true)});
export const NativeTransferWriteSchema=z.strictObject({binding,lease,intent,contentBase64:z.string().max(87384),first:z.boolean()});
export const NativeTransferPublishSchema=z.strictObject({binding,lease,intent});
export const NativeTransferLimitsSchema=z.strictObject({maxHashBytes:size,maxOffsetBytes:size});
export const NativeTransferWriteReceiptSchema=z.strictObject({requestId:uuid,epoch,offset:size,length:z.number().int().min(0).max(65536),sha256:sha});
export const NativeTransferFinalReceiptSchema=z.strictObject({jobId:uuid,requestId:uuid,epoch,targetDeviceId:id,targetPath:file,size,sha256:sha,proof:z.string().regex(/^[A-Za-z0-9_-]{86}$/)});

/** Called only INSIDE runNativeAgent's existing protected mutation admission.
 * There is no shell, ordinary files.write or files.move fallback. */
export async function executeNativeTransferWire(publisher:NativeTransferPublisher|undefined,deviceId:string,requestId:string,capability:string,input:unknown,policy:PathPolicy){
  if(!publisher||!isNativeTransferCapability(capability))throw Error('NATIVE_TRANSFER_AUTHORITY_REQUIRED');
  if(capability==='files.transfer.limits'){
    z.strictObject({}).parse(input);
    return {data:{maxHashBytes:nativeHashPolicy(),maxOffsetBytes:NATIVE_MAX_FILE_OFFSET}};
  }
  const a=NativeTransferPublishSchema.parse(capability==='files.transfer.write_fenced'
    ? (()=>{const w=NativeTransferWriteSchema.parse(input);return {binding:w.binding,lease:w.lease,intent:w.intent};})()
    : input);
  if(a.intent.requestId!==requestId||a.binding.targetDeviceId!==deviceId||a.intent.epoch!==a.lease.epoch)throw Error('NATIVE_TRANSFER_WIRE_SCOPE_MISMATCH');
  // Existing allowlist is mandatory in addition to the protected provider's
  // namespace admission. Reject aliases/reparse redirection of either path.
  for(const file of [a.binding.stagePath,a.binding.targetPath]){
    if(!path.isAbsolute(file)||await policy.resolveForCreate(file)!==path.resolve(file))throw Error('NATIVE_TRANSFER_PATH_DENIED');
  }
  if(capability==='files.transfer.write_fenced'){
    const w=NativeTransferWriteSchema.parse(input);
    if(a.intent.kind!=='write')throw Error('NATIVE_TRANSFER_WIRE_SCOPE_MISMATCH');
    return {data:await publisher.writeFenced(a.binding,a.lease,a.intent,w.contentBase64,w.first)};
  }
  if(a.intent.kind!=='publish')throw Error('NATIVE_TRANSFER_WIRE_SCOPE_MISMATCH');
  return {data:await publisher.publishFenced(a.binding,a.lease,a.intent)};
}
