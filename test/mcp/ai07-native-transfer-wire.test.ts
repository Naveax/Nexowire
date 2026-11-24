import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {brokerNativeTransferClient} from '../../src/mcp/broker-native-transfer-client.js';
import {NATIVE_TRANSFER_CAPABILITIES,executeNativeTransferWire} from '../../src/agent/native-transfer-wire.js';
import {NativeTransferPublisher,type NativeTransferAdmission} from '../../src/agent/native-transfer-publisher.js';
import {PathPolicy} from '../../src/agent/path-policy.js';
import type {AgentBroker} from '../../src/core/agent-broker.js';
import type {LargeTransferBinding,LargeTransferIntent} from '../../src/mcp/durable-large-transfer.js';
const id=randomUUID(),target=path.join(os.tmpdir(),'target');
const b:LargeTransferBinding={id,ownerId:'owner',projectId:'project',sourceDeviceId:'source',targetDeviceId:'target',sourcePath:'source',targetPath:target,stagePath:target+'.nexowire-upload-'+id+'.part',size:0,sha256:createHash('sha256').digest('hex')};
const lease={epoch:1,token:'test-only-token-at-least-thirty-two-characters'};
const intent:LargeTransferIntent={kind:'write',requestId:randomUUID(),epoch:1,offset:0,length:0,sha256:b.sha256,dispatched:true};
type Broker=Parameters<typeof brokerNativeTransferClient>[0];
function fixture(atomic=true,caps:readonly string[]=NATIVE_TRANSFER_CAPABILITIES){
  const calls:unknown[][]=[];
  const broker:Broker={
    isMandatoryMutationReauthorizationEnabled:()=>true,isMandatoryAtomicMutationAuthorityEnabled:()=>atomic,
    has:()=>true,list:()=>[{id:'target',capabilities:[...caps]} as ReturnType<AgentBroker['list']>[number]],
    async request(...args){calls.push(args);return {data:{requestId:intent.requestId,epoch:1,offset:0,length:0,sha256:b.sha256}};},
  };
  return {broker,calls};
}
test('broker transfer client requires strict authorization and explicit Native advertisement',async()=>{
  assert.equal(brokerNativeTransferClient(fixture(false).broker),undefined);
  const f=fixture(true,['files.write','files.move']);
  await assert.rejects(brokerNativeTransferClient(f.broker)!.writeFenced(b,lease,intent,'',true),/PROVIDER_UNAVAILABLE/);
  assert.equal(f.calls.length,0);
});
test('broker preserves original mutation UUID, full access mode, and fenced capability',async()=>{
  const f=fixture();
  const r=await brokerNativeTransferClient(f.broker)!.writeFenced(b,lease,intent,'',true);
  assert.equal(r.requestId,intent.requestId);
  assert.deepEqual(f.calls[0],['target','files.transfer.write_fenced',{binding:b,lease,intent,contentBase64:'',first:true},120000,intent.requestId,'full']);
});
test('Native wire rejects absent provider, foreign outer UUID and mismatched target before admission',async()=>{
  let admitted=0;
  const admission:NativeTransferAdmission={async admit(){admitted++;throw Error('unexpected admission');},async resolveProtectedPaths(){throw Error('unexpected paths');},async flushDirectory(){},async signFinal(){throw Error('unexpected sign');},async persistFinalReceipt(){}};
  const publisher=new NativeTransferPublisher('target',admission),policy=new PathPolicy([os.tmpdir()]);
  const input={binding:b,lease,intent,contentBase64:'',first:true};
  await assert.rejects(executeNativeTransferWire(undefined,'target',intent.requestId,'files.transfer.write_fenced',input,policy),/AUTHORITY_REQUIRED/);
  await assert.rejects(executeNativeTransferWire(publisher,'target',randomUUID(),'files.transfer.write_fenced',input,policy),/SCOPE_MISMATCH/);
  await assert.rejects(executeNativeTransferWire(publisher,'foreign',intent.requestId,'files.transfer.write_fenced',input,policy),/SCOPE_MISMATCH/);
  assert.equal(admitted,0);
});
