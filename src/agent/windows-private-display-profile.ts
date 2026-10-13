import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as z from 'zod';
import {
  PrivateDisplayPlanSchema, planWindowsPrivateDisplays,
  type PrivateDisplayPlan,
} from './windows-private-display-plan.js';

const VERSION = 1;
const MAX_PROFILE_BYTES = 64 * 1024;

// Concurrent MCP requests in one Agent must not contend for profile.json on
// Windows, whose replacement rename can report EPERM under simultaneous writes.
// Serialize status, set, and reset. The queue also recovers after failures.
let profileOperationQueue: Promise<void> = Promise.resolve();
function serializeProfileOperation<T>(operation:()=>Promise<T>):Promise<T>{
  const pending=profileOperationQueue.then(operation);
  profileOperationQueue=pending.then(()=>undefined,()=>undefined);
  return pending;
}

async function replaceProfileAtomically(temp:string,file:string):Promise<void>{
  for(let retry=0;retry<4;retry++){
    try{await fs.rename(temp,file);return;}
    catch(error){
      const code=(error as NodeJS.ErrnoException).code;
      if(retry===3 || !['EPERM','EACCES','EBUSY'].includes(code??'')){
        throw error;
      }
      await delay(30*(retry+1));
    }
  }
}

const StoredProfileSchema=z.object({
  version:z.literal(VERSION),
  savedAt:z.string().datetime({offset:true}),
  requested:PrivateDisplayPlanSchema,
}).strict();

class PrivateDisplayProfileError extends Error {
  constructor(public readonly code:string,message:string){
    super(message);this.name='PrivateDisplayProfileError';
  }
}

function ensureWindows():void{
  if(process.platform!=='win32'){
    throw new PrivateDisplayProfileError(
      'WINDOWS_REQUIRED','Private AI display profiles are supported on Windows.');
  }
}

function profilePath():string{
  const root=process.env.NEXOWIRE_PRIVATE_DISPLAY_PROFILE_DIR?.trim() ||
    path.join(os.homedir(),'.nexowire','private-display-profile');
  return path.join(root,'profile.json');
}

export interface PrivateDisplayProfileStatus {
  configured:boolean;
  savedAt:string|null;
  plan:PrivateDisplayPlan|null;
  applied:false;
  osMonitorsProvisioned:false;
  touchesHostDisplaySettings:false;
  backend:'isolated_virtual_display_backend_required';
}

function statusOf(requested:z.infer<typeof PrivateDisplayPlanSchema>,savedAt:string):PrivateDisplayProfileStatus{
  return {
    configured:true,savedAt,
    plan:planWindowsPrivateDisplays(requested).data,
    applied:false,osMonitorsProvisioned:false,
    touchesHostDisplaySettings:false,
    backend:'isolated_virtual_display_backend_required',
  };
}
function emptyStatus():PrivateDisplayProfileStatus{
  return {
    configured:false,savedAt:null,plan:null,
    applied:false,osMonitorsProvisioned:false,
    touchesHostDisplaySettings:false,
    backend:'isolated_virtual_display_backend_required',
  };
}

/** Read a saved desired configuration; this never probes/changes host display devices. */
export async function privateDisplayProfileStatus():Promise<{data:PrivateDisplayProfileStatus}>{
  ensureWindows();
  return await serializeProfileOperation(readProfileStatus);
}
async function readProfileStatus():Promise<{data:PrivateDisplayProfileStatus}>{
  const file=profilePath();
  let bytes:Buffer;
  try{
    const stat=await fs.stat(file);
    if(stat.size>MAX_PROFILE_BYTES){
      throw new PrivateDisplayProfileError(
        'PRIVATE_DISPLAY_PROFILE_INVALID','Saved display profile is too large.');
    }
    bytes=await fs.readFile(file);
  }catch(error){
    if((error as NodeJS.ErrnoException).code==='ENOENT'){
      return {data:emptyStatus()};
    }
    throw error;
  }
  let decoded:unknown;
  try{decoded=JSON.parse(bytes.toString('utf8'));}
  catch{
    throw new PrivateDisplayProfileError(
      'PRIVATE_DISPLAY_PROFILE_INVALID','Saved AI display profile is not valid JSON.');
  }
  const parsed=StoredProfileSchema.safeParse(decoded);
  if(!parsed.success){
    throw new PrivateDisplayProfileError(
      'PRIVATE_DISPLAY_PROFILE_INVALID','Saved AI display profile failed validation.');
  }
  try {
    return {data:statusOf(parsed.data.requested,parsed.data.savedAt)};
  }catch {
    throw new PrivateDisplayProfileError(
      'PRIVATE_DISPLAY_PROFILE_INVALID',
      'Saved AI display profile exceeds supported display-plan limits.');
  }
}

/** Save intent for a future fully isolated provider. Never apply host display settings. */
export async function privateDisplayProfileSet(input:unknown):Promise<{data:PrivateDisplayProfileStatus}>{
  ensureWindows();
  const requested=PrivateDisplayPlanSchema.parse(input);
  // Fail before I/O when count, DPI, topology or pixel budget is invalid.
  const checked=planWindowsPrivateDisplays(requested).data;
  return await serializeProfileOperation(async()=>{
  const savedAt=new Date().toISOString();
  const stored={version:VERSION,savedAt,requested};
  const file=profilePath();
  const root=path.dirname(file);
  await fs.mkdir(root,{recursive:true});
  const temp=path.join(root,`.profile-${process.pid}-${randomUUID()}.tmp`);
  try{
    await fs.writeFile(temp,JSON.stringify(stored,null,2)+'\n',
      {encoding:'utf8',mode:0o600,flag:'wx'});
    await replaceProfileAtomically(temp,file);
  }finally{
    await fs.rm(temp,{force:true}).catch(()=>undefined);
  }
  return {data:{
    configured:true,savedAt,plan:checked,
    applied:false,osMonitorsProvisioned:false,
    touchesHostDisplaySettings:false,
    backend:'isolated_virtual_display_backend_required',
  }};
  });
}

/** Forget desired AI screens. No Windows display driver or monitor is touched. */
export async function privateDisplayProfileReset():Promise<{
  data:PrivateDisplayProfileStatus & {removed:boolean};
}>{
  ensureWindows();
  return await serializeProfileOperation(async()=>{
  const file=profilePath();
  let removed=false;
  try{await fs.unlink(file);removed=true;}
  catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
  }
  return {data:{...emptyStatus(),removed}};
  });
}

export async function executeWindowsPrivateDisplayProfileCapability(
  capability:string,input:unknown,
):Promise<unknown>{
  switch(capability){
    case 'windows.private_display.profile.status':
      return await privateDisplayProfileStatus();
    case 'windows.private_display.profile.set':
      return await privateDisplayProfileSet(input);
    case 'windows.private_display.profile.reset':
      return await privateDisplayProfileReset();
    default:throw new PrivateDisplayProfileError(
      'UNSUPPORTED','Unknown private display profile operation.');
  }
}
