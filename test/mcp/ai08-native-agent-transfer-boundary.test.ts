import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,stat,rm} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import {WebSocketServer,type WebSocket,type RawData} from 'ws';
import {AgentHelloSchema,AgentResponseSchema} from '../../src/protocol/agent.js';
import {NATIVE_TRANSFER_CAPABILITIES} from '../../src/agent/native-transfer-wire.js';
import {isolatedRemoteCas} from '../fixtures/agent-remote-cas-fixture.js';

async function fixture(t:TestContext,withCas:boolean){
 const root=await mkdtemp(path.join(os.tmpdir(),'nx-ai08-native-boundary-'));
 const cleanup:Array<()=>void|Promise<void>>=[];
 t.after(async()=>{try{for(const f of cleanup.reverse())await f();}finally{await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});}});
 const home=path.join(root,'home');await mkdir(home);
 const id=randomUUID(),identity=path.join(root,'identity.json');
 await writeFile(identity,JSON.stringify({id}));
 const cas=withCas?await isolatedRemoteCas(root,id):undefined;
 if(cas)cleanup.push(()=>cas.stop());
 const server=new WebSocketServer({host:'127.0.0.1',port:0});
 cleanup.push(async()=>{for(const s of server.clients)s.terminate();await new Promise<void>(r=>server.close(()=>r()));});
 await once(server,'listening',{signal:AbortSignal.timeout(10000)});
 const addr=server.address();assert(addr&&typeof addr!=='string');
 const helloPromise=new Promise<{socket:WebSocket;hello:ReturnType<typeof AgentHelloSchema.parse>}>((resolve,reject)=>{
   server.once('connection',socket=>{socket.once('message',raw=>{try{resolve({socket,hello:AgentHelloSchema.parse(JSON.parse(raw.toString()))});}catch(e){reject(e);}});});
 });
 // The child has no inherited Nexowire credentials/configuration or injected Native providers.
 const env:NodeJS.ProcessEnv=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.toUpperCase().startsWith('NEXOWIRE_')&&k.toUpperCase()!=='NODE_EXTRA_CA_CERTS'));
 Object.assign(env,cas?.env??{},{
   HOME:home,USERPROFILE:home,NEXOWIRE_AGENT_IDENTITY_FILE:identity,NEXOWIRE_ALLOWED_ROOTS:root,
   NEXOWIRE_HUB_WS_URL:'ws://127.0.0.1:'+addr.port+'/agent',NEXOWIRE_DEVICE_NAME:'AI08 isolated transfer boundary',
   NEXOWIRE_PRIVILEGE_MODE:'direct',NEXOWIRE_AGENT_REQUIRE_ATOMIC_EFFECT_ADMISSION:'1',
   NEXOWIRE_AGENT_OPERATION_JOURNAL_FILE:path.join(root,'agent.sqlite'),
   NEXOWIRE_PROCESS_STATE_FILE:path.join(root,'process-sessions.json'),
   NEXOWIRE_TASK_GRAPH_STATE_FILE:path.join(root,'task-graphs.json'),
   NEXOWIRE_RUNBOOK_STATE_FILE:path.join(root,'runbooks.json'),NEXOWIRE_PROCESS_WORKER_ROOT:path.join(root,'workers')
 });
 const child=spawn(process.execPath,['--import','tsx','src/cli.ts','agent'],{env,stdio:['ignore','ignore','ignore'],windowsHide:true});
 const closed=once(child,'close');
 // Also handles spawn error without leaking an unhandled promise rejection.
 void closed.catch(()=>{});
 cleanup.push(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
  const timer=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},4000);
  try{await closed;}finally{clearTimeout(timer);}
 });
 const deadline=AbortSignal.timeout(30000);
 const {socket,hello}=await Promise.race([helloPromise,closed.then(()=>{throw Error('ISOLATED_AGENT_EXITED_BEFORE_HELLO');}),once(deadline,'abort').then(()=>{throw Error('ISOLATED_AGENT_HELLO_TIMEOUT');})]);
 assert.equal(hello.device.id,id);
 for(const cap of NATIVE_TRANSFER_CAPABILITIES)assert(!hello.device.capabilities.includes(cap),'unprovisioned transfer must not be advertised');
 async function request(capability:string,accessMode:'full'|'safe',input:unknown,requestId=randomUUID()){
  const signal=AbortSignal.timeout(10000);
  const response=new Promise<ReturnType<typeof AgentResponseSchema.parse>>((resolve,reject)=>{
   const finish=()=>{socket.off('message',onMessage);signal.removeEventListener('abort',onAbort);};
   const onAbort=()=>{finish();reject(Error('ISOLATED_AGENT_RESPONSE_TIMEOUT'));};
   const onMessage=(raw:RawData)=>{try{const parsed=JSON.parse(raw.toString());if(parsed.requestId!==requestId||parsed.type!=='response')return;finish();resolve(AgentResponseSchema.parse(parsed));}catch(e){finish();reject(e);}};
   socket.on('message',onMessage);signal.addEventListener('abort',onAbort,{once:true});
  });
  socket.send(JSON.stringify({type:'request',requestId,capability,input,accessMode}));
  return response;
 }
 const targetPath=path.join(root,'must-not-publish.bin'),jobId=randomUUID(),stagePath=targetPath+'.nexowire-upload-'+jobId+'.part';
 const sha256=createHash('sha256').digest('hex');
 const binding={id:jobId,ownerId:'fixture-owner',projectId:'fixture-project',sourceDeviceId:'fixture-source',targetDeviceId:id,sourcePath:path.join(root,'source.bin'),targetPath,stagePath,size:0,sha256};
 const lease={epoch:1,token:'fixture-only-no-production-authority-token'};
 for(const accessMode of ['safe','full'] as const){
  for(const capability of NATIVE_TRANSFER_CAPABILITIES){
   const requestId=randomUUID();
   const intent={kind:capability.endsWith('publish_fenced')?'publish':'write',requestId,epoch:1,offset:0,length:0,sha256,dispatched:true};
   const input=capability.endsWith('limits')?{}:capability.endsWith('write_fenced')?{binding,lease,intent,contentBase64:'',first:true}:{binding,lease,intent};
   const response=await request(capability,accessMode,input,requestId);
   assert.equal(response.ok,false);assert.equal(response.error?.code,'NATIVE_TRANSFER_AUTHORITY_REQUIRED');
  }
 }
 await assert.rejects(stat(targetPath),{code:'ENOENT'});await assert.rejects(stat(stagePath),{code:'ENOENT'});
 if(cas){const db=new DatabaseSync(cas.dbFile,{readOnly:true});try{
  assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM reservations').get() as {n:number|bigint}).n),0,'deny before remote CAS reservation');
 }finally{db.close();}}
 const snapshot=await request('machine.snapshot','safe',{});assert.equal(snapshot.ok,true,'ordinary diagnostic connectivity preserved');
}
test('actual unprovisioned Native Agent rejects all protected transfer capabilities even with forged full access',{timeout:90000},t=>fixture(t,false));
test('actual Native Agent with isolated CAS but missing trusted providers denies transfer before reservation',{timeout:120000},t=>fixture(t,true));
