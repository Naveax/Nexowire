import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {runProcessWorker} from '../src/agent/process-worker.js';
import {assertNoObviousPrivateShellBrokerInvocation} from '../src/agent/windows-private-shell-broker-guard.js';
import {ProcessManager} from '../src/agent/process-manager.js';
import {PathPolicy} from '../src/agent/path-policy.js';

test('Windows shell bridge entry points are not eligible for private GUI worker routing',()=>{
  for(const command of [
    'bash','bash.exe','sh','sh.exe','wsl','wsl.exe',
    'wslhost.exe','wt','wt.exe','C:\\Windows\\System32\\wsl.exe',
  ]){
    assert.throws(
      ()=>assertNoObviousPrivateShellBrokerInvocation(command,['-lc','echo checked']),
      (error:unknown)=>error instanceof Error&&'code' in error&&
        error.code==='AI_PRIVATE_SHELL_BROKER_NOT_ISOLATED',
      command,
    );
  }
});

test('Windows private durable process rejects POSIX shell before allocating worker state',{
  skip:process.platform!=='win32',
},async()=>{
  const root=path.join(os.tmpdir(),'nexowire-private-bridge-no-worker-'+randomUUID());
  const manager=new ProcessManager({
    workerRoot:root,
    workerEntrypoint:path.join(root,'unused-cli.js'),
  });
  for(const shell of ['bash','sh'] as const){
    await assert.rejects(
      manager.start({
        command:'echo harmless',
        shell,ui_target:'private_desktop',
      },new PathPolicy(['*'])),
      (error:unknown)=>error instanceof Error&&'code' in error&&
        error.code==='AI_PRIVATE_SHELL_BROKER_NOT_ISOLATED',
      shell,
    );
  }
  await assert.rejects(fs.stat(root),(error:unknown)=>
    error instanceof Error&&'code' in error&&error.code==='ENOENT');
});

async function checkPrivateFileInitDenied(
  command:string,
  env:Record<string,string>|undefined,
  expectedCode:string,
):Promise<void>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nx-private-worker-final-gate-'));
  const payload={
    sessionId:randomUUID(),
    command,
    shell:'powershell',
    maxBufferBytes:65_536,
    token:'0'.repeat(64),
    ...(env?{executionEnv:env}:{}),
  };
  await fs.writeFile(path.join(dir,'init.json'),JSON.stringify(payload),'utf8');
  try{
    await assert.rejects(
      runProcessWorker(dir,true),
      (error:unknown)=>error instanceof Error&&'code' in error&&
        error.code===expectedCode,
    );
    for(const filename of ['control.json','status.json','events.jsonl']){
      await assert.rejects(fs.stat(path.join(dir,filename)),(error:unknown)=>
        error instanceof Error&&'code' in error&&error.code==='ENOENT');
    }
  }finally{
    await fs.rm(dir,{recursive:true,force:true});
  }
}

test('private worker independently preflights replayed broker command before child/socket',{
  skip:process.platform!=='win32',
},async()=>{
  await checkPrivateFileInitDenied(
    'Start-Process explorer.exe',
    {PATH:process.env.PATH??''},
    'AI_PRIVATE_SHELL_BROKER_NOT_ISOLATED',
  );
});

test('private worker refuses missing sanitized execution environment before child/socket',{
  skip:process.platform!=='win32',
},async()=>{
  await checkPrivateFileInitDenied(
    'Write-Output harmless',
    undefined,
    'PRIVATE_PROCESS_WORKER_INIT_MODE_MISMATCH',
  );
});
