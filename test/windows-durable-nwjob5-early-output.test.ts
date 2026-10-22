import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {ProcessManager} from '../src/agent/process-manager.js';
import {PathPolicy} from '../src/agent/path-policy.js';

/** Native physical source-only fixture, no installed Agent or user processes. */
test('Windows durable NWJOB5: fast-exit stdout and stderr persist exactly once before exited', {
  skip: process.platform!=='win32', timeout:180_000,
},async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx03-durable-early-output-'));
  const manager=new ProcessManager({
    stateFile:path.join(root,'sessions.json'),
    workerRoot:path.join(root,'workers'),
    workerEntrypoint:path.resolve('src/cli.ts'),
    workerExecArgv:process.execArgv,
    exitedRetentionMs:120_000,
  });
  await manager.initialize();
  try{
    for(let cycle=0;cycle<16;cycle++){
      const marker='NX03_DURABLE_FAST_'+randomBytes(8).toString('hex');
      const started=await manager.start({
        shell:'cmd',durable:true,
        command:'echo '+marker+'_OUT & echo '+marker+'_ERR 1>&2',
      },new PathPolicy(['*']));
      assert.equal(started.durable,true);
      let cursor=0,stdout='',stderr='',status='running';
      const deadline=Date.now()+12_000;
      do{
        const read=await manager.read({
          session_id:started.sessionId,after_seq:cursor,max_events:128,wait_ms:150,
        });
        cursor=read.nextSeq;
        status=read.session.status;
        for(const event of read.events){
          if(event.stream==='stdout')stdout+=event.text;
          if(event.stream==='stderr')stderr+=event.text;
        }
        if(status==='exited'||status==='lost'||status==='orphaned')break;
      }while(Date.now()<deadline);
      assert.equal(status,'exited','native durable fixture must terminate with real exit at cycle '+cycle);
      assert.equal(stdout.split(marker+'_OUT').length-1,1,
        'durable stdout must arrive exactly once BEFORE terminal status: cycle '+cycle);
      assert.equal(stderr.split(marker+'_ERR').length-1,1,
        'durable stderr must arrive exactly once BEFORE terminal status: cycle '+cycle);
    }
  }finally{
    // Retain old failure semantics: only this test's isolated sessions.
    await manager.stopAll().catch(()=>undefined);
    await fs.rm(root,{recursive:true,force:true});
  }
});

// Structural regression: a fast native Job root may exit during awaited
// launcher verification. The callback MUST be registered by JobOwner at
// spawn time, not attached to its pipes after that awaited operation.
test('durable Windows Job source passes onOutput before awaited native launch',async()=>{
  const worker=await fs.readFile(path.resolve('src/agent/process-worker.ts'),'utf8');
  const jobCall=/job\s*=\s*await\s+launchWindowsJob\([\s\S]*?\);/g;
  const matches=[...worker.matchAll(jobCall)];
  assert.equal(matches.length,1,'one durable native Job launch source entry expected');
  assert.match(matches[0]?.[0]??'',/onOutput\s*:\s*captureOutput/,
    'durable worker must supply pre-spawn capture callback to native JobOwner');
});
