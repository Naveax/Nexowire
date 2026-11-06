import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ProcessManager} from '../../src/agent/process-manager.js';
import {PathPolicy} from '../../src/agent/path-policy.js';

test('durable worker stuck in starting is never returned as a running command',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nwx-starting-'));
  const worker=path.join(root,'starting.mjs');
  await fs.writeFile(worker,`import {promises as fs} from 'node:fs';import path from 'node:path';
let text='';for await(const c of process.stdin)text+=c;
const init=JSON.parse(text),root=process.argv[3],now=new Date().toISOString();
await fs.writeFile(path.join(root,'control.json'),JSON.stringify({version:1,sessionId:init.sessionId,port:1,token:init.token,workerPid:process.pid,createdAt:now}));
await fs.writeFile(path.join(root,'status.json'),JSON.stringify({version:1,sessionId:init.sessionId,workerPid:process.pid,childPid:null,status:'starting',startedAt:now,exitCode:null,signal:null,nextSeq:1,maxBufferBytes:65536}));
setInterval(()=>{},1000);`);
  const manager=new ProcessManager({workerRoot:path.join(root,'workers'),workerEntrypoint:worker,workerExecArgv:[]});
  try{
    await assert.rejects(manager.start({command:'echo never-started',durable:true,
      shell:process.platform==='win32'?'powershell':'sh'},new PathPolicy([root])),
      {code:'PROCESS_WORKER_START_TIMEOUT'});
    assert.equal(manager.list().length,0);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
