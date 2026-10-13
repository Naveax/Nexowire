import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeWindowsPrivateDesktopCapability } from './windows-private-desktop.js';
import {assertNoObviousPrivateShellBrokerInvocation} from './windows-private-shell-broker-guard.js';
export {assertNoObviousPrivateShellBrokerInvocation} from './windows-private-shell-broker-guard.js';

export interface PrivateShellResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  timedOut: boolean;
}

const workerSource = String.raw`
'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
(async function main(){
 const file = process.argv[2];
 const data = JSON.parse(fs.readFileSync(file, 'utf8'));
 const resultFile = data.resultFile;
 const output = [[],[]];
 const counts = [0,0];
 let truncated = false;
 let timedOut = false;
 let completed = false;
 let errorMessage = null;
 let child;
 let timer;
 function collect(index,chunk){
   const remaining=Math.max(0,data.maxOutputBytes-counts[index]);
   const take=Math.min(chunk.length,remaining);
   if(take>0){output[index].push(chunk.subarray(0,take));counts[index]+=take;}
   if(take<chunk.length)truncated=true;
 }
 async function finish(code){
   if(completed)return;
   completed=true;
   if(timer)clearTimeout(timer);
   const record={exitCode:code,truncated,timedOut,errorMessage};
   await fs.promises.writeFile(data.stdoutFile,Buffer.concat(output[0]));
   await fs.promises.writeFile(data.stderrFile,Buffer.concat(output[1]));
   await fs.promises.writeFile(resultFile+'.tmp',JSON.stringify(record));
   await fs.promises.rename(resultFile+'.tmp',resultFile);
 }
 try{
   child=spawn(data.executable,data.args,{
     cwd:data.cwd || undefined,windowsHide:true,shell:false,
     env:data.env,
     stdio:['ignore','pipe','pipe'],
   });
   child.stdout.on('data',buf=>collect(0,buf));
   child.stderr.on('data',buf=>collect(1,buf));
   timer=setTimeout(()=>{
     timedOut=true;
     if(child && child.pid){
       const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{
         windowsHide:true,stdio:'ignore',shell:false,
       });
       killer.on('error',()=>{});
     }else if(child){child.kill();}
   },data.timeoutMs);
   child.once('error',error=>{
     errorMessage=String(error.message||error);
     void finish(null);
   });
   child.once('close',code=>{void finish(code===null?null:code);});
 }catch(error){
   errorMessage=String(error.message||error);
   await finish(null);
 }
})().catch(error=>{process.stderr.write(String(error));process.exitCode=1;});
`;

/**
 * The private desktop helper deliberately has a system-only PATH. Restore
 * only the ordinary interactive process environment needed for development
 * commands, not arbitrary credential/token variables from the agent.
 */
export function privateShellExecutionEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string,string> {
  const allowed = [
    'PATH','Path','PATHEXT','SystemRoot','windir','ComSpec','COMSPEC',
    'USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP',
    'HOMEDRIVE','HOMEPATH','HOME','ProgramData','ProgramFiles',
    'ProgramFiles(x86)','PSModulePath',
  ];
  const result:Record<string,string>={};
  for(const key of allowed){
    const value=source[key];
    if(value!==undefined && !/[\r\n\0]/.test(value) && value.length<=32_768){
      result[key]=value;
    }
  }
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Launch the command's shell in the real, separate NexowirePrivate Win32
 * desktop, then collect bounded stdout/stderr through an isolated IPC file.
 * Never switch the user's input desktop or move their physical cursor.
 *
 * Not a universal isolation guarantee for programs which deliberately ask
 * the system shell/Explorer to activate a GUI on the default desktop.
 */
export async function runWindowsPrivateShell(
  executable: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs: number; maxOutputBytes: number },
): Promise<PrivateShellResult> {
  if (process.platform !== 'win32') {
    throw new Error('PRIVATE_SHELL_WINDOWS_ONLY');
  }
  if (!Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 100 || options.timeoutMs > 600_000 ||
    !Number.isInteger(options.maxOutputBytes) ||
    options.maxOutputBytes < 1024 ||
    options.maxOutputBytes > 16_777_216) {
    throw new Error('PRIVATE_SHELL_LIMITS_INVALID');
  }

  assertNoObviousPrivateShellBrokerInvocation(executable,args);

  await executeWindowsPrivateDesktopCapability(
    'windows.private_desktop.start', { create_shortcut: false },
  );

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-private-shell-'));
  const script = path.join(dir, 'worker.cjs');
  const input = path.join(dir, 'input.json');
  const output = path.join(dir, 'result.json');
  const stdoutFile = path.join(dir, 'stdout');
  const stderrFile = path.join(dir, 'stderr');
  let pid = 0;
  let safeToClean = false;
  try {
    await fs.writeFile(script, workerSource, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(input, JSON.stringify({
      executable, args, cwd: options.cwd,
      env:privateShellExecutionEnvironment(),
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      resultFile: output, stdoutFile, stderrFile,
    }), { flag: 'wx', mode: 0o600 });
    const launched = await executeWindowsPrivateDesktopCapability(
      'windows.private_desktop.launch',
      { executable: process.execPath, args: [script, input], cwd: dir },
    ) as {data: {pid: number}};
    pid = launched.data.pid;
    const deadline = Date.now() + options.timeoutMs + 12_000;
    while (Date.now() < deadline) {
      try {
        const result = JSON.parse(await fs.readFile(output, 'utf8')) as
          { exitCode: number | null; truncated: boolean;
            timedOut: boolean; errorMessage: string | null };
        const [stdout, stderr] = await Promise.all([
          fs.readFile(stdoutFile, 'utf8'), fs.readFile(stderrFile, 'utf8'),
        ]);
        safeToClean = true;
        if (result.errorMessage) {
          throw new Error('PRIVATE_SHELL_EXEC_FAILED: '+result.errorMessage);
        }
        return {
          stdout, stderr, exitCode: result.exitCode,
          truncated: result.truncated, timedOut: result.timedOut,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (pid && !pidAlive(pid)) {
        throw new Error('PRIVATE_SHELL_WORKER_EXITED_WITHOUT_RESULT');
      }
      await sleep(50);
    }
    throw new Error('PRIVATE_SHELL_WORKER_TIMEOUT');
  } finally {
    // On an unexpected worker failure, retain the temporary data rather
    // than deleting a potentially still-running subprocess's IPC files.
    if (safeToClean || !pid || !pidAlive(pid)) {
      await fs.rm(dir, {recursive: true, force: true}).catch(()=>undefined);
    }
  }
}
