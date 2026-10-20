import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AgentBroker} from '../src/core/agent-broker.js';
import {attachAgentWebSocketServer} from '../src/hub/agent-websocket.js';

test('real native Agent without remote CAS permits read-only, rejects mutations',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'nw-cas-readonly-'));
 const home=path.join(root,'home');
 await mkdir(home,{recursive:true});
 const id=randomUUID();
 const identity=path.join(root,'identity.json');
 await writeFile(identity,JSON.stringify({id}));
 const broker=new AgentBroker();
 const http=createServer();
 const wss=attachAgentWebSocketServer(http,broker);
 await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
 const addr=http.address();
 assert.ok(addr&&typeof addr==='object');
 const env:NodeJS.ProcessEnv={...process.env,
  HOME:home,USERPROFILE:home,
  NEXOWIRE_AGENT_IDENTITY_FILE:identity,
  NEXOWIRE_AGENT_OPERATION_JOURNAL_FILE:path.join(root,'agent.sqlite'),
  NEXOWIRE_HUB_WS_URL:'ws://127.0.0.1:'+addr.port+'/agent',
  NEXOWIRE_DEVICE_NAME:'Isolated Readonly '+id.slice(0,8),
  NEXOWIRE_PROCESS_STATE_FILE:path.join(root,'process-sessions.json'),
  NEXOWIRE_TASK_GRAPH_STATE_FILE:path.join(root,'task-graphs.json'),
  NEXOWIRE_RUNBOOK_STATE_FILE:path.join(root,'runbooks.json'),
  NEXOWIRE_PROCESS_WORKER_ROOT:path.join(root,'workers'),
  NEXOWIRE_AGENT_RESERVATION_CAS_URL:undefined,
  NEXOWIRE_AGENT_RESERVATION_CAS_TOKEN:undefined,
  NEXOWIRE_AGENT_RESERVATION_CAS_AUTHORITY_ID:undefined,
  NEXOWIRE_AGENT_RESERVATION_CAS_EPOCH:undefined,
  NEXOWIRE_AGENT_JOURNAL_AUTHORITY_FILE:undefined,
  NEXOWIRE_AGENT_JOURNAL_AUTHORITY_ID:undefined,
  NEXOWIRE_AGENT_JOURNAL_AUTHORITY_GENERATION:undefined,
 };
 let agent:ChildProcess|undefined;
 const errors:string[]=[];
 try{
  agent=spawn(process.execPath,['--import','tsx','src/cli.ts','agent'],{
   cwd:process.cwd(),env,stdio:['ignore','pipe','pipe'],
  });
  agent.stderr?.on('data',d=>errors.push(String(d)));
  let connected=false;
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){
   if(broker.list().some(e=>e.id===id)){connected=true;break}
   if(agent.exitCode!==null)throw new Error('Agent exited: '+errors.join('').slice(-500));
   await new Promise(r=>setTimeout(r,50));
  }
  assert.equal(connected,true,'Expected real Agent diagnostic connection');
  const snapshot=await broker.request(id,'machine.snapshot',{},10000);
  assert.equal((snapshot as {data?:{platform?:string}}).data?.platform,process.platform);
  const denied=await broker.request(id,'files.write',{
   path:path.join(root,'MUST_NOT_BE_WRITTEN.txt'),content:'should never execute',
   mode:'overwrite',
  },10000).then(value=>value,err=>({error:String(err)}));
  assert.match(JSON.stringify(denied),/Remote mutation reservation unavailable/);
  await assert.rejects(import('node:fs/promises').then(fs=>fs.stat(
   path.join(root,'MUST_NOT_BE_WRITTEN.txt'))),{code:'ENOENT'});
 }finally{
  if(agent&&agent.exitCode===null){
   agent.kill('SIGTERM');
   await new Promise<void>(resolve=>{
    if(agent!.exitCode!==null)return resolve();
    const wait=setTimeout(()=>{agent!.kill('SIGKILL');resolve()},4000);
    agent!.once('exit',()=>{clearTimeout(wait);resolve()});
   });
  }
  for(const socket of wss.clients)socket.close();
  wss.close();
  await new Promise<void>(resolve=>http.close(()=>resolve()));
  await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});
 }
});
