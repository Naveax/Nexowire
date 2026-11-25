import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {WebSocketServer} from 'ws';
import type {HelperSelectionTlsConfig} from '../../src/security/protected-helper-selection-transport.js';
import type {HelperPin} from '../../src/installer/protected-transfer-helper-lifecycle.js';
interface ReleaseFixture {
  tls:Omit<HelperSelectionTlsConfig,'credential'>;credential:string;pin:HelperPin;
  expectRelease:boolean;beforeStop?:()=>Promise<void>;onLocalReturn?:()=>void;
}

export async function actualAgentStop(t:TestContext,mode:'stop'|'revoke',id=randomUUID(),release?:ReleaseFixture){
  const root=await mkdtemp(path.join(os.tmpdir(),'nx-ai07-stop-'));
  const home=path.join(root,'home');await mkdir(home);
  const identity=path.join(root,'identity.json');
  await writeFile(identity,JSON.stringify({id}));
  const server=new WebSocketServer({host:'127.0.0.1',port:0});
  await once(server,'listening',{signal:AbortSignal.timeout(10000)});
  const addr=server.address();assert(addr&&typeof addr!=='string');
  const hello=new Promise<string>((resolve,reject)=>{
    server.once('connection',socket=>socket.once('message',raw=>{
      try{resolve(JSON.parse(String(raw)).device.id);}catch(error){reject(error);}
    }));
  });
  const env:NodeJS.ProcessEnv=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.toUpperCase().startsWith('NEXOWIRE_')&&k.toUpperCase()!=='NODE_EXTRA_CA_CERTS'));
  Object.assign(env,{HOME:home,USERPROFILE:home,NEXOWIRE_AGENT_IDENTITY_FILE:identity,NEXOWIRE_ALLOWED_ROOTS:root,
    NEXOWIRE_HUB_WS_URL:'ws://127.0.0.1:'+addr.port+'/agent',NEXOWIRE_DEVICE_NAME:'AI07 isolated shutdown',
    NEXOWIRE_PRIVILEGE_MODE:'direct',NEXOWIRE_AGENT_REQUIRE_ATOMIC_EFFECT_ADMISSION:'1',
    NEXOWIRE_AGENT_OPERATION_JOURNAL_FILE:path.join(root,'agent.sqlite'),
    NEXOWIRE_PROCESS_STATE_FILE:path.join(root,'process-sessions.json'),
    NEXOWIRE_TASK_GRAPH_STATE_FILE:path.join(root,'task-graphs.json'),
    NEXOWIRE_RUNBOOK_STATE_FILE:path.join(root,'runbooks.json'),NEXOWIRE_PROCESS_WORKER_ROOT:path.join(root,'workers')});
  if(release){
    const configFile=path.join(root,'fixture-selection.json');
    const {tls,credential,pin}=release;
    await writeFile(configFile,JSON.stringify({tls,credential,pin}),{mode:0o600,flag:'wx'});
    env.NEXOWIRE_AI07_SHUTDOWN_LEASE_FIXTURE=configFile;
  }
  const child=spawn(process.execPath,['--import','tsx','test/fixtures/ai07-protected-shutdown-child.ts'],{env,stdio:['pipe','pipe','pipe'],windowsHide:true});
  let stdout='',stderr='';
  let observedReturn=false;
  child.stdout.on('data',b=>{stdout+=String(b);if(!observedReturn&&stdout.includes('AI07_LOCAL_SHUTDOWN_RETURNED')){observedReturn=true;release?.onLocalReturn?.();}});child.stderr.on('data',b=>{stderr+=String(b);});
  const closed=once(child,'close');void closed.catch(()=>{});
  t.after(async()=>{
    if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
    try{await closed;}finally{
      for(const s of server.clients)s.terminate();
      await new Promise<void>(r=>server.close(()=>r()));
      await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});
    }
  });
  const limit=AbortSignal.timeout(30000);
  assert.equal(await Promise.race([hello,closed.then(()=>{throw Error('Agent exited before hello: '+stderr);}),once(limit,'abort').then(()=>{throw Error('Agent hello timeout');})]),id);
  await release?.beforeStop?.();
  child.stdin.end(mode+'\n');
  const [code]=await Promise.race([closed,once(limit,'abort').then(()=>{throw Error('Agent shutdown timeout');})]);
  if(release){
    assert.match(stdout,/AI07_LOCAL_SHUTDOWN_RETURNED/);
    if(release.expectRelease){assert.equal(code,0,stderr);assert.match(stdout,/AI07_SIGNED_RELEASE_CONFIRMED/);}
    else{assert.equal(code,1,stderr);assert.doesNotMatch(stdout,/AI07_SIGNED_RELEASE_CONFIRMED/);assert.match(stderr,/HELPER_SELECTION_TRANSPORT_UNKNOWN/);}
  }else if(mode==='stop'){assert.equal(code,0,stderr);assert.match(stdout,/AI07_LOCAL_SHUTDOWN_RETURNED/);}
  else{assert.equal(code,1,stderr);assert.doesNotMatch(stdout,/AI07_LOCAL_SHUTDOWN_RETURNED/);assert.match(stderr,/TRANSFER_HELPER_RUNTIME_LEASE_RELEASED/);}
}
