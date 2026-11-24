import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {createServer} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {AgentBroker} from '../../src/core/agent-broker.js';
import {AtomicMutationCoordinator,type AtomicMutationAuthority,type MutationReservation} from '../../src/core/atomic-mutation-authority.js';
import {attachAgentWebSocketServer} from '../../src/hub/agent-websocket.js';
import {AGENT_PROTOCOL_VERSION,HubRequestSchema} from '../../src/protocol/agent.js';
import {isReadOnlyCapability} from '../../src/protocol/capabilities.js';
import {ProviderRegistry} from '../../src/core/provider-registry.js';
import {AgentProvider} from '../../src/providers/agent-provider.js';
import {WorkspaceStore} from '../../src/workspace/store.js';
import {SkillRegistry} from '../../src/skills/registry.js';
import {createNexowireMcpServer} from '../../src/mcp/create-server.js';
import {executeCapability,normalizeAgentError} from '../../src/agent/executors.js';
import {PathPolicy} from '../../src/agent/path-policy.js';
import {executeTrustedNativeMutation,type TrustedNativeMutationProvider} from '../../src/agent/native-atomic-effect-admission.js';
import {NATIVE_TRANSFER_CAPABILITIES,isNativeTransferCapability,executeNativeTransferWire} from '../../src/agent/native-transfer-wire.js';
import {NativeTransferPublisher,verifyNativeTransferReceipt,type NativeTransferAdmission} from '../../src/agent/native-transfer-publisher.js';
import type {LargeTransferAuthority,LargeTransferLease,LargeTransferFinalReceipt,LargeTransferCommit} from '../../src/mcp/durable-large-transfer.js';
const digest=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const delay=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
async function until(predicate:()=>boolean){for(let i=0;i<300;i++){if(predicate())return;await delay(10);}throw Error('fixture connection deadline');}

test('actual MCP / strict AgentBroker / loopback WebSocket / native publisher: lost durable write ACK, offline journal status, reconnect and one publish',{timeout:45000,skip:process.platform==='win32'?'Linux/POSIX directory fsync fixture; Windows protected flush is NOT_RUN':false},async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nx-mcp-wire-e2e-')));
  const sourceRoot=path.join(root,'source'),targetRoot=path.join(root,'target');
  await fs.mkdir(sourceRoot);await fs.mkdir(targetRoot);
  const source=path.join(sourceRoot,'payload.bin'),target=path.join(targetRoot,'payload.bin');
  const bytes=Buffer.alloc(221*1024);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
  await fs.writeFile(source,bytes);
  const sourceId='source-device',targetId='target-device',ownerId='owner-account',authorityId='fixture-authority';
  const scope={source_device_id:sourceId,target_device_id:targetId};
  const reservations=new Map<string,MutationReservation>(),enqueued=new Set<string>(),effects=new Set<string>(),writes=new Set<string>();
  let revoked=false,loseSecond=true,writeCount=0,publishCount=0;
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  let lease:LargeTransferLease|undefined;
  let committed:{receipt:LargeTransferFinalReceipt;commit:LargeTransferCommit}|undefined;
  const epochAuthority:AtomicMutationAuthority={
    async reserveFresh(i){if(revoked)return null;const old=reservations.get(i.requestId);if(old)return {...old,created:false};const r={...i,authorityId,reservationId:randomUUID(),created:true};reservations.set(i.requestId,r);return r;},
    async dispatchIfCurrent(r,enqueue){assert(!revoked);assert(!enqueued.has(r.requestId));assert.equal(reservations.get(r.requestId)?.fingerprint,r.fingerprint);enqueued.add(r.requestId);enqueue();},
    async admitNativeEffectOnce(r,effect){assert(!revoked);assert(enqueued.has(r.requestId));assert(!effects.has(r.requestId));assert.equal(reservations.get(r.requestId)?.fingerprint,r.fingerprint);effects.add(r.requestId);await effect();},
  };
  const nativeProvider:TrustedNativeMutationProvider={authority:epochAuthority,async resolveTrustedReservation(i){const r=reservations.get(i.requestId);return r?.deviceId===i.deviceId&&r.capability===i.capability&&r.fingerprint===i.wireSha256?r:undefined;}};
  const flush=async(dir:string)=>{const fd=await fs.open(dir,'r');try{await fd.sync();}finally{await fd.close();}};
  const admission:NativeTransferAdmission={
    async admit(b,l,p,effect){assert(!revoked);assert.deepEqual(l,lease);assert.equal(b.ownerId,ownerId);assert.equal(b.targetDeviceId,targetId);assert(effects.has(p.requestId));await effect();},
    async resolveProtectedPaths(b){assert.equal(b.targetPath,target);assert.equal(path.dirname(b.stagePath),targetRoot);return {stage:b.stagePath,target:b.targetPath};},
    flushDirectory:flush,
    async signFinal(data){return sign(null,data,privateKey).toString('base64url');},
    async persistFinalReceipt(_b,p,receipt){const fd=await fs.open(path.join(root,p.requestId+'.receipt'),'wx');try{await fd.writeFile(JSON.stringify(receipt));await fd.sync();}finally{await fd.close();}await flush(root);},
  };
  const publisher=new NativeTransferPublisher(targetId,admission);
  const authority:LargeTransferAuthority={
    async assertGrant(s){assert(!revoked);assert.equal(s.ownerId,ownerId);assert.equal(s.sourceDeviceId,sourceId);assert.equal(s.targetDeviceId,targetId);assert.equal(s.projectId,'fixture-project');},
    async acquire(_b,previous){lease={epoch:Math.max(previous,lease?.epoch??0)+1,token:randomUUID()};return lease;},
    async assertCurrent(_b,l){assert(!revoked);assert.deepEqual(l,lease);},async proveWriteNoEffect(){return false;},
    async verifyFinal(b,r){return verifyNativeTransferReceipt(b,r,publicKey);},
    async commitPublished(b,l,r){assert(!revoked);assert(!committed);assert.deepEqual(l,lease);const commit={jobId:b.id,requestId:r.requestId,epoch:r.epoch,sha256:b.sha256,commitId:randomUUID()};committed={receipt:r,commit};return commit;},
    async recoverPublished(){return committed;},async recoverNativeReceipt(){return undefined;},async commitRecoveredPublication(){throw Error('unexpected publication recovery');},
  };
  const broker=new AgentBroker({requireMutationReauthorization:true,requireAtomicMutationAuthority:true,reconnectGraceMs:250});
  const http=createServer();
  const wss=attachAgentWebSocketServer(http,broker,undefined,{remoteOnly:true,
    remoteCredentialVerifier:async h=>{const deviceId=h==='Bearer fixture-source'?sourceId:h==='Bearer fixture-target'?targetId:undefined;return deviceId&&!revoked?{deviceId,ownerId,authorizationEpoch:1,leaseExpiresAtMs:Date.now()+28000}:undefined;},
    remoteMutationAuthorizationFactory:()=>async()=>!revoked,
    remoteAtomicMutationCoordinatorFactory:g=>{
      const binding={ownerId,deviceId:g.deviceId,authorizationEpoch:1,leaseExpiresAtMs:Date.now()+28000};
      return new AtomicMutationCoordinator({...binding,authorityId},async()=>revoked?undefined:{...binding,leaseExpiresAtMs:Date.now()+28000},epochAuthority);
    },
  });
  await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
  const address=http.address();assert(address&&typeof address==='object');
  const sockets:WebSocket[]=[];
  const registry=new ProviderRegistry();registry.register(new AgentProvider(broker));
  const mcp=createNexowireMcpServer({broker,providers:registry,workspaces:new WorkspaceStore(path.join(root,'workspace')),skills:new SkillRegistry(path.join(root,'skills')),
    toolAuthorization:{kind:'control-plane',scope:'mcp',accountId:ownerId,role:'user',allowedDeviceIds:[sourceId,targetId],deviceAccessModes:{[sourceId]:'full',[targetId]:'full'}},
    largeTransferRuntime:{journalPath:path.join(root,'worker.sqlite'),projectId:'fixture-project',authority}});
  const client=new Client({name:'wire-fixture',version:'1.0.0'});
  const [a,b]=InMemoryTransport.createLinkedPair();await Promise.all([client.connect(a),mcp.connect(b)]);
  t.after(async()=>{await client.close();await mcp.close();for(const ws of sockets)ws.terminate();for(const ws of wss.clients)ws.terminate();await new Promise<void>(r=>wss.close(()=>r()));await new Promise<void>(r=>http.close(()=>r()));await fs.rm(root,{recursive:true,force:true});});
  const connect=async(device:string,instanceId:string)=>{
    const dest=device===targetId,policy=new PathPolicy([dest?targetRoot:sourceRoot]);
    const ws=new WebSocket('ws://127.0.0.1:'+address.port+'/agent',{headers:{Authorization:dest?'Bearer fixture-target':'Bearer fixture-source'}});
    sockets.push(ws);await new Promise<void>((r,j)=>{ws.once('open',r);ws.once('error',j);});
    ws.on('message',raw=>{void(async()=>{
      const exactFrame=raw.toString(),p=HubRequestSchema.parse(JSON.parse(exactFrame));
      try{
        let data:unknown;
        if(isNativeTransferCapability(p.capability)){
          if(p.capability==='files.transfer.limits')data={data:{maxHashBytes:4*1024**3,maxOffsetBytes:Number.MAX_SAFE_INTEGER}};
          else{
            assert(dest);assert.equal(p.accessMode,'full');assert(!isReadOnlyCapability(p.capability));
            data=await executeTrustedNativeMutation({provider:nativeProvider,deviceId:device,requestId:p.requestId,capability:p.capability,exactFrame},()=>executeNativeTransferWire(publisher,device,p.requestId,p.capability,p.input,policy));
            if(p.capability==='files.transfer.write_fenced'){
              assert(!writes.has(p.requestId));writes.add(p.requestId);writeCount++;
              if(writeCount===2&&loseSecond){loseSecond=false;ws.terminate();return;}
            }else publishCount++;
          }
        }else data=await executeCapability(p.capability,p.input,policy);
        ws.send(JSON.stringify({type:'response',requestId:p.requestId,ok:true,data}));
      }catch(e){if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'response',requestId:p.requestId,ok:false,error:normalizeAgentError(e)}));}
    })().catch(()=>ws.terminate());});
    ws.send(JSON.stringify({type:'hello',protocolVersion:AGENT_PROTOCOL_VERSION,instanceId,device:{id:device,name:device,platform:process.platform,arch:process.arch,agentVersion:'fixture',capabilities:['files.stat','files.hash','files.read','files.write','files.move',...NATIVE_TRANSFER_CAPABILITIES]}}));
    await until(()=>broker.has(device));return ws;
  };
  const instance=randomUUID();await connect(sourceId,randomUUID());await connect(targetId,instance);
  type ToolResponse={ok:boolean;data?:{id:string;state:string;bytesConfirmed:number;sha256:string};error?:{code:string}};
  const call=async(name:string,args:Record<string,unknown>)=>{const r=await client.callTool({name:'large_file_transfer_'+name,arguments:{...scope,...args}});return r.structuredContent as unknown as ToolResponse;};
  assert((await client.listTools()).tools.some(x=>x.name==='large_file_transfer_start'));
  const start=await call('start',{source_path:source,target_path:target});assert.equal(start.ok,true,JSON.stringify(start));assert(start.data);
  const transfer_id=start.data.id;
  const advance=await call('advance',{transfer_id,max_chunks:2});assert.equal(advance.ok,false,JSON.stringify(advance));assert.equal(advance.error?.code,'TRANSFER_MUTATION_UNKNOWN');
  await until(()=>!broker.has(targetId));assert.equal(writeCount,2);assert.equal(publishCount,0);
  const offline=await call('status',{transfer_id});assert.equal(offline.ok,true,JSON.stringify(offline));assert.equal(offline.data?.state,'UNKNOWN');assert.equal(offline.data?.bytesConfirmed,65536);
  const denied=await call('advance',{transfer_id,max_chunks:1});assert.equal(denied.ok,false);assert.equal(writeCount,2);
  await connect(targetId,instance);
  const recovered=await call('recover',{transfer_id});assert.equal(recovered.ok,true,JSON.stringify(recovered));assert.equal(recovered.data?.bytesConfirmed,131072);assert.equal(writeCount,2);
  const final=await call('advance',{transfer_id,max_chunks:8});assert.equal(final.ok,true,JSON.stringify(final));assert.equal(final.data?.state,'COMPLETE');assert.equal(final.data?.sha256,digest(bytes));
  assert.equal(writeCount,4);assert.equal(writes.size,4);assert.equal(publishCount,1);assert.equal(effects.size,5);assert.deepEqual(await fs.readFile(target),bytes);
  const status=await call('status',{transfer_id});assert.equal(status.data?.state,'COMPLETE');
  revoked=true;const revokedStatus=await call('status',{transfer_id});assert.equal(revokedStatus.ok,false);assert.equal(writeCount,4);
});
