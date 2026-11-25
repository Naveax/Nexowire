import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { verifyWindowsKernelJob } from './windows-job-kernel-attestation.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Windows does not expose CREATE_SUSPENDED or Win32 Job Objects through
 * node:child_process. A small native, non-inheriting Job handle owner is the
 * containment boundary. Never treat a naked Node spawn as equivalent.
 */
export class WindowsJobOwnerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'WindowsJobOwnerError';
  }
}

export interface WindowsJobLaunch {
  child: ChildProcessWithoutNullStreams; // native guardian, NOT the shell PID
  pid: number; // suspended, assigned and resumed shell PID
  creationFiletime: string; // Win32 FILETIME ticks from GetProcessTimes
  guardianPid: number;
  closed: () => boolean;
  /** Local observation only. Never an independent signed native effect/drain receipt. */
  completion: Promise<WindowsJobCompletion>;
  requestStop: () => Promise<'requested' | 'unconfirmed'>;
}

export type WindowsJobCompletion =
  | {state:'local_job_empty'; reason:'natural'|'stopped'|'timeout'|'owner_lost'; rootExitCode:number}
  | {state:'unknown'};

const unknownCompletion=():WindowsJobCompletion=>({state:'unknown'});

/** The native guardian, not the root, writes a flushed v6 terminal record.
 * Bind the observation to the retained guardian's exit, exact suspended
 * root identity and expected protocol exit code. Unauthenticated local
 * files are never accepted as protected/remote execution authority. */
export function parseWindowsJobCompletion(input:{
  raw:string; pid:number; creationFiletime:string; guardianPid:number;
  exitCode:number|null; signal:NodeJS.Signals|null;
}):WindowsJobCompletion {
  if(input.signal!==null||input.exitCode===null||input.raw.length>160)return unknownCompletion();
  const m=/^NWJOB6 ([1-9][0-9]*) ([1-9][0-9]*) ([1-9][0-9]*) ([0-3]) ([0-9]{1,10})\n$/.exec(input.raw);
  if(!m||m[0]!==input.raw||m[1]!==String(input.pid)||m[2]!==input.creationFiletime||
     m[3]!==String(input.guardianPid))return unknownCompletion();
  const reason=Number(m[4]),rootExitCode=Number(m[5]);
  if(!Number.isSafeInteger(rootExitCode)||rootExitCode>0xffffffff||
     m[5]!==String(rootExitCode))return unknownCompletion();
  const expected=reason===1?125:reason===2?124:reason===3?78:rootExitCode<=255?rootExitCode:1;
  if(input.exitCode!==expected)return unknownCompletion();
  const label=(['natural','stopped','timeout','owner_lost'] as const)[reason];
  return label?{state:'local_job_empty',reason:label,rootExitCode}:unknownCompletion();
}

export function validateWindowsJobRuntimeTimeout(value:number|undefined):number {
  if(value===undefined)return 0;
  if(!Number.isSafeInteger(value)||value<1||value>600000)
    throw new WindowsJobOwnerError('WINDOWS_JOB_RUNTIME_TIMEOUT_INVALID','Invalid native Job lifetime budget.');
  return value;
}

async function readTerminalRecord(file:string):Promise<string>{
  const before=await fs.lstat(file);
  if(!before.isFile()||before.isSymbolicLink()||before.size>160||before.size<1)
    throw Error('WINDOWS_JOB_TERMINAL_RECORD_UNTRUSTED');
  const handle=await fs.open(file,'r');
  try{
    const current=await handle.stat();
    if(!current.isFile()||current.dev!==before.dev||current.ino!==before.ino||
       current.size!==before.size)throw Error('WINDOWS_JOB_TERMINAL_RECORD_CHANGED');
    const bytes=Buffer.alloc(161);
    const {bytesRead}=await handle.read(bytes,0,bytes.length,0);
    if(bytesRead!==before.size)throw Error('WINDOWS_JOB_TERMINAL_RECORD_CHANGED');
    return bytes.subarray(0,bytesRead).toString('utf8');
  }finally{await handle.close();}
}

function candidateBinary(): string {
  // Source: src/agent -> native/. Bundle: dist/src/agent -> dist/native/.
  // Do not accept an environment-variable override or parent-directory
  // fallback. An attacker-controlled executable can forge an ownership marker.
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, '../../native/windows-job-owner.exe');
}

interface HelperIdentity { digest: string; signature: string }

/**
 * Build-produced SHA detects helper-only substitution; release signer and
 * protected manifest provenance still require separate production acceptance.
 */
export async function verifyWindowsJobHelperBinary(helper: string): Promise<HelperIdentity> {
  try {
    const manifest = path.join(path.dirname(helper), 'windows-job-owner.sha256');
    const expected = (await fs.readFile(manifest, 'utf8')).trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('invalid SHA256 manifest');
    const dir = path.dirname(helper);
    const [dirLink, link, resolved, canonicalParent, first] = await Promise.all([
      fs.lstat(dir), fs.lstat(helper), fs.realpath(helper), fs.realpath(dir),
      fs.stat(helper, { bigint: true }),
    ]);
    // Windows may canonicalize a checkout's ancestor (drive/mount alias).
    // Compare canonical parent + leaf identity instead of the uncanonical
    // user-facing path. Never permit a symlink/junction at the selected
    // helper leaf or at its immediate parent.
    const sameParent = path.win32.normalize(path.win32.dirname(resolved)).toLowerCase() ===
      path.win32.normalize(canonicalParent).toLowerCase();
    const sameLeaf = path.win32.basename(resolved).toLowerCase() ===
      path.win32.basename(helper).toLowerCase();
    if (dirLink.isSymbolicLink() || link.isSymbolicLink() || !link.isFile() ||
        !sameParent || !sameLeaf) {
      throw new Error('helper path is a link or reparse redirection');
    }
    const handle = await fs.open(helper, 'r');
    let actual: string;
    try {
      actual = createHash('sha256').update(await handle.readFile()).digest('hex');
    } finally {
      await handle.close();
    }
    const second = await fs.stat(helper, { bigint: true });
    if (actual !== expected || first.dev !== second.dev ||
        first.ino !== second.ino || first.size !== second.size ||
        first.mtimeNs !== second.mtimeNs) {
      throw new Error('helper hash or file identity changed');
    }
    return { digest: actual,
      signature: [first.dev, first.ino, first.size, first.mtimeNs].join(':') };
  } catch (cause) {
    throw new WindowsJobOwnerError('WINDOWS_JOB_HELPER_UNTRUSTED',
      'Windows Job helper image/path integrity unverified: ' +
      (cause instanceof Error ? cause.message : String(cause)));
  }
}
async function binaryPath(): Promise<string> {
  const candidate = candidateBinary();
  await verifyWindowsJobHelperBinary(candidate);
  return candidate;
}

export async function launchWindowsJob(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; guardOnParentExit?: boolean;
    runtimeTimeoutMs?:number;
    onOutput?: (stream: 'stdout' | 'stderr', chunk: Buffer) => void }
): Promise<WindowsJobLaunch> {
  if (process.platform !== 'win32') {
    throw new WindowsJobOwnerError('WINDOWS_JOB_WINDOWS_ONLY', 'Windows only');
  }
  const runtimeTimeout=validateWindowsJobRuntimeTimeout(options.runtimeTimeoutMs);
  if(options.guardOnParentExit===false)throw new WindowsJobOwnerError(
    'WINDOWS_JOB_OWNER_REQUIRED','Managed Job requires a live owning process.');
  const helper = await binaryPath();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nexowire-job-'));
  const marker = path.join(directory, 'assigned.txt');
  const release = path.join(directory, 'verified.ok');
  const cancel=marker+'.cancel';
  const terminal=marker+'.terminal';
  let child: ChildProcessWithoutNullStreams | undefined;
  let settleAdmission!:(value:boolean)=>void;
  const admission=new Promise<boolean>(resolve=>{settleAdmission=resolve;});
  let stopRequest:Promise<'requested'|'unconfirmed'>|undefined;
  let identity:{pid:number;creationFiletime:string;guardianPid:number}|undefined;
  let completionStarted=false;
  let resolveCompletion!:(value:WindowsJobCompletion)=>void;
  const completion=new Promise<WindowsJobCompletion>(resolve=>{resolveCompletion=resolve;});
  const requestStop=():Promise<'requested'|'unconfirmed'>=>{
    if(!child||child.exitCode!==null||child.signalCode!==null)return Promise.resolve('unconfirmed');
    if(stopRequest)return stopRequest;
    // Only the existing guardian may terminate its Job. A late control
    // file write may request cancellation of this exact Job, never another.
    // Bounded async waiting avoids blocking the canonical shutdown loop.
    stopRequest=new Promise(resolve=>{
      const timer=setTimeout(()=>resolve('unconfirmed'),1000);
      void fs.writeFile(cancel,'stop',{flag:'wx',mode:0o600}).then(
        ()=>{clearTimeout(timer);resolve('requested');},
        ()=>{clearTimeout(timer);resolve('unconfirmed');});
    });
    return stopRequest;
  };
  const finishCompletion=(code:number|null,signal:NodeJS.Signals|null):void=>{
    if(completionStarted)return;
    completionStarted=true;
    const bound=identity;
    if(!bound||signal!==null||code===null||code<0||code>255){
      resolveCompletion(unknownCompletion());return;
    }
    // The exit event may beat the release-file write callback. Require
    // successful admission independently of that ordering.
    const deadline=setTimeout(()=>resolveCompletion(unknownCompletion()),2000);
    void admission.then(async admitted=>{
      if(!admitted)return unknownCompletion();
      try{return parseWindowsJobCompletion({...bound,raw:await readTerminalRecord(terminal),exitCode:code,signal});}
      catch{return unknownCompletion();}
    }).then(value=>{clearTimeout(deadline);resolveCompletion(value);},
      ()=>{clearTimeout(deadline);resolveCompletion(unknownCompletion());});
  };
  try {
    // Invoked by Node with pipes. Native helper forwards inherited std handles
    // to the suspended shell and owns the Job until every member is gone.
    child = spawn(
      helper,
      ['--status', marker, '--cwd', options.cwd ?? '-', '--parent',
        String(process.pid), '--release', release, '--lifecycle-v6',String(runtimeTimeout),
        '--', executable, ...args],
      { shell:false,windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: options.env ?? process.env },
    );
    // Register both pipe readers immediately after spawn, before any async
    // marker polling or kernel attestation. A fast root can resume and exit
    // while launchWindowsJob is still completing its awaits. Node may close
    // unconsumed inherited pipes before ProcessManager receives the child.
    // These bytes are application OUTPUT only, never attestation evidence.
    if (options.onOutput) {
      child.stdout.on('data', (chunk: Buffer) => options.onOutput?.('stdout', chunk));
      child.stderr.on('data', (chunk: Buffer) => options.onOutput?.('stderr', chunk));
    }
    let failed: Error | undefined;
    let closed = false;
    child.once('error', (error) => { failed = error;finishCompletion(null,null); });
    // 'exit' occurs when the guardian PID dies. 'close' may NEVER fire while
    // a surviving root holds the inherited stdout/stderr pipe handles open.
    // Ownership is lost on guardian exit, regardless of stream lifetimes.
    child.once('exit', (code,signal) => { closed = true;finishCompletion(code,signal); });
    child.once('close', (code,signal) => { closed = true;finishCompletion(code,signal); });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (failed) throw failed;
      try {
        const line = (await fs.readFile(marker, 'utf8')).trim();
        const match = /^NWJOB6 ([1-9][0-9]*) ([1-9][0-9]*) ([1-9][0-9]*) ([1-9][0-9]*) ([0-9]+)$/.exec(line);
        if (!match) throw new Error('Invalid Windows Job attestation');
        const pid = Number(match[1]);
        if (!Number.isSafeInteger(pid) || pid > 0xffffffff) {
          throw new Error('Invalid owned Windows process ID');
        }
        // Never trust helper-authored marker text without an independent
        // Win32 kernel membership + job limit verification.
        if (!child.pid) throw new Error('Windows Job guardian PID unavailable');
        await verifyWindowsKernelJob(pid,match[2]!,child.pid,match[3]!,{
          creationFiletime:match[4]!,sessionId:Number(match[5]),
        });
        await verifyWindowsJobHelperBinary(helper);
        if(closed||child.exitCode!==null||child.signalCode!==null||Date.now()>=deadline)
          throw new WindowsJobOwnerError('WINDOWS_JOB_LAUNCH_UNCONFIRMED','Guardian closed or admission expired.');
        identity={pid,creationFiletime:match[2]!,guardianPid:child.pid};
        // Install the completion identity before release can make a fast
        // root exit. Failure to write the gate never becomes a receipt.
        await fs.writeFile(release,'verified',{flag:'wx',mode:0o600});
        settleAdmission(true);
        return {
          child, ...identity, closed: () => closed,completion,requestStop,
        };
      } catch (error) {
        if (!(typeof error === 'object' && error !== null &&
            'code' in error && ['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(String(error.code)))) {
          throw error;
        }
      }
      if (closed || child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new WindowsJobOwnerError(
      'WINDOWS_JOB_LAUNCH_UNCONFIRMED',
      'Windows Job owner exited or timed out before confirming suspended-process assignment.',
    );
  } catch (error) {
    // Request cancellation through the existing guardian. Incomplete
    // admission is denied and its native pre-resume deadline remains armed.
    // Do not kill a guardian and then report its descendants gone.
    settleAdmission(false);
    await requestStop();
    throw error;
  } finally {
    if(!child){
      await fs.rm(directory,{recursive:true,force:true}).catch(()=>undefined);
    }else{
      // Retain unknown evidence; no recursive deletion during native work.
      // Close (not just exit) establishes that the stdio pipes are drained.
      const cleanup=()=>{void completion.then(value=>{
        if(value.state==='local_job_empty')
          return fs.rm(directory,{recursive:true,force:true}).catch(()=>undefined);
      });};
      if(child.stdout.destroyed&&child.stderr.destroyed&&
         (child.exitCode!==null||child.signalCode!==null))cleanup();
      else child.once('close',cleanup);
    }
  }
}

export async function requestWindowsJobStop(launch: WindowsJobLaunch): Promise<'requested' | 'unconfirmed'> {
  // A request is not a terminal Job observation or independent OS drain.
  if(launch.closed())return 'unconfirmed';
  return launch.requestStop();
}

/** Historical scheduled Agent launchers use NWJOB3 arguments and do not
 * have the v6 suspended-root release/pipe/identity handshake. New task
 * registration or explicit activation is denied until the existing task
 * launcher is independently migrated and accepted. A legacy receipt is
 * historical ownership information, not a v6 activation grant. */
export function assertScheduledAgentJobMigrationAdmission():void {
  throw new WindowsJobOwnerError('NATIVE_AGENT_TASK_JOB_PROTOCOL_MIGRATION_REQUIRED',
    'NATIVE_AGENT_TASK_JOB_PROTOCOL_MIGRATION_REQUIRED: NWJOB3 scheduled admission is not v6.');
}
