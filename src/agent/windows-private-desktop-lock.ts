import {randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';

interface OwnerRecord {
  version:1;
  pid:number;
  nonce:string;
  startedAt:number;
}

export class PrivateLifecycleLockError extends Error {
  constructor(public readonly code:string, message:string) {
    super(message);
    this.name='PrivateLifecycleLockError';
  }
}

function isAlive(pid:number):boolean {
  if(!Number.isSafeInteger(pid)||pid<=0)return false;
  try {
    process.kill(pid,0);
    return true;
  }catch(error){
    // An EPERM error cannot establish that an owner is gone.
    if((error as NodeJS.ErrnoException).code==='EPERM')return true;
    return false;
  }
}

function wait(ms:number):Promise<void> {
  return new Promise(resolve=>setTimeout(resolve,ms));
}

async function existing(pathname:string):Promise<boolean> {
  try{await fs.stat(pathname);return true;}
  catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT')return false;
    throw error;
  }
}

async function readOwner(dir:string):Promise<OwnerRecord|null> {
  try {
    const raw=JSON.parse(await fs.readFile(path.join(dir,'owner.json'),'utf8')) as Partial<OwnerRecord>;
    if(!raw||raw.version!==1 || !Number.isSafeInteger(raw.pid) ||
      typeof raw.nonce!=='string' || !/^[a-f0-9-]{36}$/.test(raw.nonce) ||
      !Number.isSafeInteger(raw.startedAt)){
      throw new PrivateLifecycleLockError(
        'PRIVATE_DESKTOP_LOCK_OWNER_INVALID',
        'Private desktop lock owner metadata is invalid; refusing reclamation.',
      );
    }
    return raw as OwnerRecord;
  }catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT')return null;
    if(error instanceof SyntaxError){
      throw new PrivateLifecycleLockError(
        'PRIVATE_DESKTOP_LOCK_OWNER_INVALID',
        'Private desktop lock owner metadata is unreadable JSON; refusing reclamation.',
      );
    }
    throw error;
  }
}

/**
 * Serialize start/launch/stop between multiple native-agent Node processes,
 * not only concurrent requests in one process. A dead owner's lock is
 * recoverable after a grace period under a separate atomic recovery gate.
 *
 * Never reclaim a live or permission-inaccessible PID; time out instead.
 */
export async function withPrivateDesktopProcessLock<T>(
  root:string,
  action:()=>Promise<T>,
  options:{timeoutMs?:number;staleMs?:number;now?:()=>number}={},
):Promise<T>{
  const timeoutMs=options.timeoutMs??40_000;
  const staleMs=options.staleMs??30_000;
  const now=options.now??Date.now;
  if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>120_000||
     !Number.isInteger(staleMs)||staleMs<1000||staleMs>300_000){
    throw new PrivateLifecycleLockError('PRIVATE_DESKTOP_LOCK_LIMITS','Invalid lifecycle lock timing.');
  }
  const lockDir=path.join(root,'.lifecycle.lock');
  const recovery=lockDir+'.recovery';
  const nonce=randomUUID();
  const owner:OwnerRecord={version:1,pid:process.pid,nonce,startedAt:now()};
  const deadline=Date.now()+timeoutMs;
  await fs.mkdir(root,{recursive:true,mode:0o700});
  let acquired=false;

  while(Date.now()<deadline){
    try {
      await fs.mkdir(lockDir,{mode:0o700});
      acquired=true;
      try {
        await fs.writeFile(path.join(lockDir,'owner.json'),JSON.stringify(owner),{
          flag:'wx',mode:0o600,
        });
      }catch(error){
        await fs.rm(lockDir,{force:true,recursive:true});
        acquired=false;
        throw error;
      }
      break;
    }catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    }

    // The recovery lock permits at most one stale-owner cleanup.
    if(!(await existing(recovery))){
      let recoveryHeld=false;
      try {
        await fs.mkdir(recovery,{mode:0o700});
        recoveryHeld=true;
        const stat=await fs.stat(lockDir).catch((error:NodeJS.ErrnoException)=>{
          if(error.code==='ENOENT')return null;
          throw error;
        });
        const previous=await readOwner(lockDir);
        const age=stat?now()-stat.mtimeMs:0;
        const dead=previous!==null&&!isAlive(previous.pid);
        const deadAndOld=dead&&age>staleMs;
        if(stat&&deadAndOld){
          // A missing/unreadable owner cannot establish that the lock's
          // creator is dead. Never reclaim it; fail closed instead.
          // A dead confirmed PID is guarded by an
          // exclusive directory, preventing competing scavengers.
          await fs.rm(lockDir,{recursive:true,force:true});
        }
      }catch(error){
        if((error as NodeJS.ErrnoException).code!=='EEXIST'&&
           (error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      }finally{
        if(recoveryHeld)await fs.rm(recovery,{recursive:true,force:true});
      }
    }
    await wait(50);
  }

  if(!acquired){
    throw new PrivateLifecycleLockError(
      'PRIVATE_DESKTOP_LIFECYCLE_LOCK_BUSY',
      'Private desktop lifecycle is already controlled by another agent process.',
    );
  }
  try {
    return await action();
  }finally{
    // Verify ownership before deleting a lock. Never remove another
    // process's newer lock even if our action failed or timed out.
    const existingOwner=await readOwner(lockDir);
    if(existingOwner?.nonce===nonce&&existingOwner.pid===process.pid){
      await fs.rm(lockDir,{recursive:true,force:true});
    }
  }
}
