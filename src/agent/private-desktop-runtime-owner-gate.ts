import {promises as fs} from 'node:fs';
import path from 'node:path';
import {
  verifyPrivateDesktopOwnerFence,
  type PrivateDesktopLaunchIdentity,
  type PrivateDesktopKernelWitness,
} from './private-desktop-owner-fence.js';

export const PRIVATE_DESKTOP_OWNER_WITNESS_UNAVAILABLE =
  'PRIVATE_DESKTOP_OWNER_WITNESS_UNAVAILABLE';
export const PRIVATE_DESKTOP_EMERGENCY_STOP_PENDING =
  'PRIVATE_DESKTOP_EMERGENCY_STOP_PENDING';

export class PrivateDesktopRuntimeGateError extends Error {
  constructor(readonly code:string,message:string) {
    super(message);
    this.name='PrivateDesktopRuntimeGateError';
  }
}

const stopFile=(root:string)=>path.join(root,'emergency-stop.pending');

/**
 * A durable cancellation request, not a claim that an OS process has
 * exited. The user-writable marker is NOT a signed authorization token.
 * An unavailable disk or any failure to persist must fail before taskkill.
 */
export async function recordPrivateDesktopEmergencyStop(root:string):Promise<void>{
  await fs.mkdir(root,{recursive:true});
  const file=stopFile(root);
  let fd:Awaited<ReturnType<typeof fs.open>>;
  try{
    // O_EXCL denies an attacker-supplied symlink/reparse-point target.
    fd=await fs.open(file,'wx',0o600);
  }catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    const existing=await fs.lstat(file);
    if(!existing.isFile()||existing.isSymbolicLink()){
      throw new PrivateDesktopRuntimeGateError(
        PRIVATE_DESKTOP_EMERGENCY_STOP_PENDING,
        'Emergency-stop marker was replaced with an unsafe file type.',
      );
    }
    return; // Already fenced: never append to a caller-owned path.
  }
  try{
    await fd.writeFile('STOP_REQUESTED\n','utf8');
    await fd.sync();
  }finally{
    await fd.close();
  }
}

/** Fail closed on any existing stop request or unreadable marker. */
export async function assertNoPrivateDesktopEmergencyStop(root:string):Promise<void>{
  let exists=false;
  try{
    await fs.lstat(stopFile(root));
    exists=true;
  }catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  }
  if(exists)throw new PrivateDesktopRuntimeGateError(
    PRIVATE_DESKTOP_EMERGENCY_STOP_PENDING,
    'Emergency stop is pending; refusing any new private desktop action.',
  );
}

/**
 * The actual #09 source launcher and stop path must not act on a persisted
 * PID or a claimed child-launch stdout receipt. This entrypoint deliberately
 * has NO default collector. An authenticated #03 protected native Broker /
 * Job owner must be wired explicitly later, with atomic process HANDLE and
 * immutable creation FILETIME bound to the action.
 *
 * The callback is a trusted-code extension point, never sourced from an
 * RPC payload, environment variable, or per-user JSON. Pure synthetic tests
 * may supply it, but such tests do not confer OS authority.
 */
export async function requireProtectedPrivateDesktopOwner(
  operation:'launch'|'stop',
  original?:PrivateDesktopLaunchIdentity,
  protectedRead?:()=>Promise<PrivateDesktopKernelWitness>,
):Promise<Readonly<{pid:number;creationTime100ns:string}>>{
  if(!original||!protectedRead){
    throw new PrivateDesktopRuntimeGateError(
      PRIVATE_DESKTOP_OWNER_WITNESS_UNAVAILABLE,
      'Protected kernel Job, process HANDLE and creationTime proof unavailable; '+
      'refusing private child launch or PID-only stop.',
    );
  }
  const result=await verifyPrivateDesktopOwnerFence(
    original,protectedRead,operation==='stop'?'stop':'read',
  );
  return Object.freeze({
    pid:result.pid,creationTime100ns:result.creationTime100ns,
  });
}
