import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,type ChildProcess} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,writeFile,readFile,stat,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AgentBroker} from '../src/core/agent-broker.js';
import {attachAgentWebSocketServer} from '../src/hub/agent-websocket.js';
import {isolatedRemoteCas} from './fixtures/agent-remote-cas-fixture.js';

test('real isolated Agent invokes remote TLS CAS before mutation and fails closed offline',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'nw-live-cas-'));
 const home=path.join(root,'home'),allowed=path.join(root,'allowed');
 await mkdir(home);await mkdir(allowed);
 const cas=await isolatedRemoteCas(root);
 const identityFile=path.join(root,'id.json');
 await writeFile(identityFile,JSON.stringify({id:cas.deviceId}));
 const broker=new AgentBroker(),http=createServer();
 const wss=attachAgentWebSocketServer(http,broker);
 await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
 const port=(http.address() as {port:number}).port;
 const env:NodeJS.ProcessEnv={...process.env,...cas.env,
  HOME:home,USERPROFILE:home,NEXOWIRE_AGENT_IDENTITY_FILE:identityFile,
  NEXOWIRE_AGENT_OPERATION_JOURNAL_FILE:path.join(root,'agent','journal.sqlite'),
  NEXOWIRE_HUB_WS_URL:'ws://127.0.0.1:'+port+'/agent',
  NEXOWIRE_DEVICE_NAME:'Live CAS '+cas.deviceId.slice(0,8),
  NEXOWIRE_ALLOWED_ROOTS:allowed,
  NEXOWIRE_PROCESS_STATE_FILE:path.join(root,'workers.json'),
  NEXOWIRE_TASK_GRAPH_STATE_FILE:path.join(root,'graphs.json'),
  NEXOWIRE_RUNBOOK_STATE_FILE:path.join(root,'runbooks.json'),
  NEXOWIRE_PROCESS_WORKER_ROOT:path.join(root,'workers'),
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
  agent.stderr?.on('data',data=>errors.push(String(data)));
  let ready=false;const deadline=Date.now()+15000;
  while(Date.now()<deadline){
   if(broker.list().some(d=>d.id===cas.deviceId)){ready=true;break}
   if(agent.exitCode!==null)throw new Error('Agent startup: '+errors.join('').slice(-400));
   await new Promise(r=>setTimeout(r,50));
  }
  assert.equal(ready,true);
  const output=path.join(allowed,'safe.txt');
  const written=await broker.request(cas.deviceId,'files.write',{
   path:output,content:'secure-test',mode:'overwrite',
  },12000);
  assert.equal((written as {data:{bytesWritten:number}}).data.bytesWritten,11);
  assert.equal(await readFile(output,'utf8'),'secure-test');
  const db=new DatabaseSync(cas.dbFile,{readOnly:true});
  try{
   const count=db.prepare('SELECT COUNT(*) AS count FROM reservations')
    .get() as {count:number};
   assert.ok(count.count>=1,'External durable CAS must have reserved first');
  }finally{db.close()}
  await cas.stop();
  const deniedPath=path.join(allowed,'must-not-appear.txt');
  const denied=await broker.request(cas.deviceId,'files.write',{
   path:deniedPath,content:'NEVER',mode:'overwrite',
  },12000).then(x=>x,e=>({error:String(e)}));
  assert.match(JSON.stringify(denied),/Independent mutation reservation cannot be verified/);
  await assert.rejects(stat(deniedPath),{code:'ENOENT'});
 }finally{
  if(agent&&agent.exitCode===null){
   agent.kill('SIGTERM');
   await new Promise<void>(resolve=>{
    if(agent!.exitCode!==null)return resolve();
    const timer=setTimeout(()=>{agent!.kill('SIGKILL');resolve()},4000);
    agent!.once('exit',()=>{clearTimeout(timer);resolve()});
   });
  }
  for(const socket of wss.clients)socket.close();
  wss.close();
  await new Promise<void>(resolve=>http.close(()=>resolve()));
  await cas.stop();
  await rm(root,{recursive:true,force:true,maxRetries:6,retryDelay:100});
 }
});
