import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {privateShellWorkerSourceForTests} from '../src/agent/windows-private-shell.js';

test('one-shot worker running on owner Default denies requested child before spawn',{
  skip:process.platform!=='win32',
  timeout:20_000,
},async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nx-private-oneshot-default-deny-'));
  try{
    const script=path.join(dir,'worker.cjs');
    const input=path.join(dir,'input.json');
    const marker=path.join(dir,'requested-child-created.txt');
    const output=path.join(dir,'result.json');
    const stdoutFile=path.join(dir,'stdout');
    const stderrFile=path.join(dir,'stderr');
    await fs.writeFile(script,privateShellWorkerSourceForTests);
    await fs.writeFile(input,JSON.stringify({
      executable:process.execPath,
      args:['-e','require("node:fs").writeFileSync(process.argv[1],"spawned")',marker],
      cwd:dir,
      env:{SystemRoot:'C:\\Windows',Path:'C:\\Windows\\System32'},
      timeoutMs:5_000,maxOutputBytes:4096,resultFile:output,stdoutFile,stderrFile,
      requestNonce:randomUUID(),
    }));
    const child=spawn(process.execPath,[script,input],{
      cwd:dir,windowsHide:true,stdio:'ignore',
    });
    const exit=await new Promise<number|null>((resolve,reject)=>{
      const timer=setTimeout(()=>{
        child.kill();
        reject(new Error('One-shot worker timed out; child was terminated'));
      },13_000);
      child.once('error',error=>{clearTimeout(timer);reject(error)});
      child.once('close',code=>{clearTimeout(timer);resolve(code)});
    });
    assert.equal(exit,0);
    const result=JSON.parse(await fs.readFile(output,'utf8')) as{
      exitCode:number|null;errorMessage:string|null;
    };
    assert.equal(result.exitCode,null);
    assert.match(result.errorMessage??'',/PRIVATE_SHELL_WORKER_DESKTOP_UNVERIFIED/);
    await assert.rejects(fs.access(marker),(error:unknown)=>
      error instanceof Error&&'code' in error&&error.code==='ENOENT');
  }finally{
    await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:150});
  }
});
