import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {
  assertPrivateWorkerDesktopProbeResult,
  assertWindowsPrivateWorkerDesktopIdentity,
  PrivateWorkerDesktopIdentityError,
} from '../src/agent/windows-private-worker-desktop-identity.js';
import {runProcessWorker} from '../src/agent/process-worker.js';

test('private worker desktop probe accepts only exact successful private identity',()=>{
  assert.doesNotThrow(()=>assertPrivateWorkerDesktopProbeResult({
    status:0,stdout:'WinSta0\\NexowirePrivate\r\n',
  }));
  for(const input of [
    {status:0,stdout:'Default'},
    {status:0,stdout:'NexowirePrivate'},
    {status:0,stdout:'AnotherStation\\NexowirePrivate'},
    {status:0,stdout:'WinSta0\\Default'},
    {status:0,stdout:''},
    {status:0,stdout:'WinSta0\\NexowirePrivate\nDefault'},
    {status:0,stdout:'WinSta0\\NexowirePrivate_'},
    {status:1,stdout:'WinSta0\\NexowirePrivate'},
    {status:null,stdout:'WinSta0\\NexowirePrivate'},
    {status:0,stdout:'WinSta0\\NexowirePrivate',error:new Error('probe timeout')},
  ]){
    assert.throws(()=>assertPrivateWorkerDesktopProbeResult(input),
      (error:unknown)=>error instanceof PrivateWorkerDesktopIdentityError&&
        error.code==='PRIVATE_PROCESS_WORKER_DESKTOP_UNVERIFIED');
  }
});

test('live host Default desktop fails the private worker identity attestation',{
  skip:process.platform!=='win32',
},()=>{
  assert.throws(()=>assertWindowsPrivateWorkerDesktopIdentity(),
    (error:unknown)=>error instanceof PrivateWorkerDesktopIdentityError&&
      error.code==='PRIVATE_PROCESS_WORKER_DESKTOP_UNVERIFIED');
});

test('private init from owner Default desktop fails closed before publishing control or status',{
  skip:process.platform!=='win32',
},async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nx-private-worker-desktop-denied-'));
  try{
    await fs.writeFile(path.join(dir,'init.json'),JSON.stringify({
      sessionId:randomUUID(),
      command:'Write-Output child-must-not-run',
      shell:'powershell',
      maxBufferBytes:65_536,
      token:'x'.repeat(64),
      executionEnv:{PATH:'C:\\Windows\\System32'},
    }),{encoding:'utf8'});
    await assert.rejects(runProcessWorker(dir,true),
      (error:unknown)=>error instanceof PrivateWorkerDesktopIdentityError&&
        error.code==='PRIVATE_PROCESS_WORKER_DESKTOP_UNVERIFIED');
    for(const name of ['control.json','status.json','events.jsonl']){
      await assert.rejects(fs.stat(path.join(dir,name)),(error:unknown)=>
        error instanceof Error&&'code' in error&&error.code==='ENOENT');
    }
  }finally{
    await fs.rm(dir,{recursive:true,force:true});
  }
});
