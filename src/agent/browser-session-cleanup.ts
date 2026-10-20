import {promises as fs} from 'node:fs';
import path from 'node:path';

export interface BrowserOwnedProcessEvidence {
  pid:number;
  executablePath:string;
  commandLine:string;
}

/** Only a new one-level UUID profile directly beneath this manager's root
 * can be removed. Never follow a junction or replace another session root.
 */
export async function verifyOwnedBrowserProfile(
  root:string,profile:string,
):Promise<void>{
  const fail=()=>{throw Object.assign(new Error(
    'Browser profile cleanup is not scoped to a direct owned session directory.'),
    {code:'BROWSER_PROFILE_OWNERSHIP_INVALID'});};
  if(path.resolve(path.dirname(profile))!==path.resolve(root)||
     !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path.basename(profile)))fail();
  const rootEntry=await fs.lstat(root);
  if(!rootEntry.isDirectory()||rootEntry.isSymbolicLink())fail();
  const normalizedRoot=await fs.realpath(root);
  const parent=await fs.realpath(path.dirname(profile));
  if(normalizedRoot!==parent)fail();
  let entry;
  try{entry=await fs.lstat(profile);}catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT')return;
    throw error;
  }
  if(!entry.isDirectory()||entry.isSymbolicLink())fail();
}

/** A PID without matching process executable and unique user-data-dir
 * is not a browser process this BrowserManager is authorized to kill.
 */
export function isVerifiedOwnedBrowserProcess(
  evidence:BrowserOwnedProcessEvidence|null,
  expectedPid:number,expectedExecutable:string,expectedProfile:string,
):boolean{
  if(!evidence||evidence.pid!==expectedPid||!evidence.executablePath||
     !evidence.commandLine)return false;
  const normalize=(v:string)=>path.win32.normalize(v).toLowerCase();
  if(normalize(evidence.executablePath)!==normalize(expectedExecutable))return false;
  const matches=[...evidence.commandLine.matchAll(/--user-data-dir=(?:"([^"]+)"|'([^']+)'|([^\s"]+))/ig)];
  return matches.length===1&&normalize(
    matches[0]?.[1]??matches[0]?.[2]??matches[0]?.[3]??'',
  )===normalize(expectedProfile);
}

/**
 * Windows Edge may leave its singleton lockfile open after the browser root
 * process exits. Only retry Windows transient file contention, with an
 * explicit bounded deadline. Never hide a persistent EBUSY or EPERM.
 */
export async function removeOwnedBrowserProfile(
  root:string,profile:string,options:{
    remove?:(target:string)=>Promise<void>;
    pause?:(ms:number)=>Promise<void>;
    maxAttempts?:number;
    retryDelayMs?:number;
  }={},
):Promise<void>{
  const remove=options.remove??(async target=>{
    await fs.rm(target,{recursive:true,force:true,maxRetries:0});
  });
  const pause=options.pause??(async ms=>{
    await new Promise<void>(resolve=>setTimeout(resolve,ms));
  });
  const attempts=options.maxAttempts??35;
  const delay=options.retryDelayMs??300;
  if(!Number.isInteger(attempts)||attempts<1||attempts>40||
     !Number.isInteger(delay)||delay<0||delay>1000)
    throw new Error('Invalid bounded browser profile cleanup controls.');
  for(let i=0;i<attempts;i++){
    await verifyOwnedBrowserProfile(root,profile);
    try{
      await remove(profile);
      return;
    }catch(error){
      const code=(error as NodeJS.ErrnoException).code;
      if(!['EBUSY','EPERM','EACCES','ENOTEMPTY'].includes(code??'')||i===attempts-1)
        throw Object.assign(new Error(
          'Owned browser profile cleanup could not release locked files.'),
          {code:'BROWSER_PROFILE_CLEANUP_FAILED',
           cause:error,details:{profile,attempts:i+1,filesystemCode:code}});
      await pause(delay);
    }
  }
}
