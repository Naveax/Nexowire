import {randomUUID} from 'node:crypto';
import type {AgentBroker} from '../core/agent-broker.js';
import type {LargeTransferRemote} from './durable-large-transfer.js';
import {NATIVE_TRANSFER_CAPABILITIES,NativeTransferLimitsSchema,NativeTransferWriteSchema,NativeTransferPublishSchema,NativeTransferWriteReceiptSchema,NativeTransferFinalReceiptSchema} from '../agent/native-transfer-wire.js';

type Broker=Pick<AgentBroker,'isMandatoryMutationReauthorizationEnabled'|'isMandatoryAtomicMutationAuthorityEnabled'|'has'|'list'|'request'>;
type NativeClient=Pick<LargeTransferRemote,'limits'|'writeFenced'|'publishFenced'>;
function data(raw:unknown):unknown{
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||!Object.hasOwn(raw,'data'))throw Error('NATIVE_TRANSFER_RESPONSE_INVALID');
  return (raw as {data:unknown}).data;
}
/** The existing broker retains the original UUID and exact serialized frame.
 * Require strict remote reauthorization AND external atomic admission. */
export function brokerNativeTransferClient(broker:Broker):NativeClient|undefined{
  if(!broker.isMandatoryMutationReauthorizationEnabled()||!broker.isMandatoryAtomicMutationAuthorityEnabled())return undefined;
  const call=async(device:string,capability:string,body:unknown,requestId:string)=>{
    const agent=broker.list().find(a=>a.id===device);
    if(!broker.has(device)||!agent||!NATIVE_TRANSFER_CAPABILITIES.every(c=>agent.capabilities.includes(c)))throw Error('NATIVE_TRANSFER_PROVIDER_UNAVAILABLE');
    return data(await broker.request(device,capability,body,120_000,requestId,'full'));
  };
  return {
    async limits(device){return NativeTransferLimitsSchema.parse(await call(device,'files.transfer.limits',{},randomUUID()));},
    async writeFenced(b,l,p,contentBase64,first){
      const body=NativeTransferWriteSchema.parse({binding:b,lease:l,intent:p,contentBase64,first});
      return NativeTransferWriteReceiptSchema.parse(await call(b.targetDeviceId,'files.transfer.write_fenced',body,p.requestId));
    },
    async publishFenced(b,l,p){
      const body=NativeTransferPublishSchema.parse({binding:b,lease:l,intent:p});
      return NativeTransferFinalReceiptSchema.parse(await call(b.targetDeviceId,'files.transfer.publish_fenced',body,p.requestId));
    },
  };
}
