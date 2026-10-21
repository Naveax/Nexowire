/**
 * Source-only AI Screen process ownership contract.
 *
 * A Windows PID is not a process identity. Neither this module nor a JSON
 * receipt proves kernel Job membership or a signed elevated Broker. Only a
 * separately protected, OS-trusted collector can furnish real evidence.
 *
 * DO NOT connect this contract to taskkill, GUI input or elevated execution
 * before #03 supplies verified process HANDLE/Job provenance. The existing
 * private desktop launcher/stoppers are intentionally unchanged here.
 */
export interface PrivateDesktopLaunchIdentity {
  readonly pid: number;
  readonly creationTime100ns: string;
  readonly sessionId: number;
  readonly desktopGeneration: string;
  readonly ownerEpoch: number;
  readonly guardianPid: number;
  readonly guardianCreationTime100ns: string;
  readonly jobHandleId: string;
  readonly cancelEpoch: number;
}

export interface PrivateDesktopKernelWitness {
  readonly processPid: number;
  readonly processCreationTime100ns: string;
  readonly processSessionId: number;
  readonly processDesktopName: string;
  readonly guardianPid: number;
  readonly guardianCreationTime100ns: string;
  readonly jobHandleId: string;
  readonly isMemberOfGuardianJob: boolean;
  readonly guardianJobVerified: boolean;
  readonly collectorVerified: boolean;
  readonly ownerEpoch: number;
  readonly desktopGeneration: string;
  readonly cancelEpoch: number;
  readonly inputDesktop: string;
  readonly processState: 'running' | 'exited' | 'unknown';
}

export class PrivateDesktopOwnerFenceError extends Error {
  constructor(readonly code:
    'PRIVATE_DESKTOP_PROVENANCE_MISSING' |
    'PRIVATE_DESKTOP_PROVENANCE_STALE' |
    'PRIVATE_DESKTOP_JOB_NOT_VERIFIED' |
    'PRIVATE_DESKTOP_OWNER_REVOKED' |
    'PRIVATE_DESKTOP_INPUT_DESKTOP_UNSAFE',
    message: string) {
    super(message);
    this.name = 'PrivateDesktopOwnerFenceError';
  }
}
function refuse(code:PrivateDesktopOwnerFenceError['code']):never {
  throw new PrivateDesktopOwnerFenceError(code,
    'A protected kernel process/owner witness is required; no PID-only action.');
}
function validTime(s:string):boolean {
  if(!/^[1-9][0-9]{7,19}$/.test(s))return false;
  try{return BigInt(s)>0n&&BigInt(s)<=18446744073709551615n;}catch{return false;}
}
function validPid(pid:number):boolean{
  return Number.isSafeInteger(pid)&&pid>0&&pid<=4294967295;
}
function validGeneration(s:string):boolean{
  return /^[a-zA-Z0-9_.:-]{10,128}$/.test(s);
}
/**
 * Pure validation only; witness booleans are not self-attesting. The caller
 * MUST obtain them independently from a protected Windows collector with
 * pinned helper publisher, OS HANDLE, creation time and Job identity.
 */
export function assertPrivateDesktopProcessProvenance(
  original:PrivateDesktopLaunchIdentity,
  witness:PrivateDesktopKernelWitness,
  action:'read'|'private-uia'|'stop',
):Readonly<{pid:number;creationTime100ns:string;action:typeof action}>{
  if(!validPid(original.pid)||!validPid(original.guardianPid)||
      !validTime(original.creationTime100ns)||
      !validTime(original.guardianCreationTime100ns)||
      !Number.isSafeInteger(original.sessionId)||original.sessionId<0||
      !validGeneration(original.desktopGeneration)||
      !Number.isSafeInteger(original.ownerEpoch)||original.ownerEpoch<1||
      !Number.isSafeInteger(original.cancelEpoch)||original.cancelEpoch<0||
      !/^[A-Za-z0-9._:-]{10,128}$/.test(original.jobHandleId)){
    refuse('PRIVATE_DESKTOP_PROVENANCE_MISSING');
  }
  if(!witness||!witness.collectorVerified||
      !witness.guardianJobVerified||!witness.isMemberOfGuardianJob){
    refuse('PRIVATE_DESKTOP_JOB_NOT_VERIFIED');
  }
  if(witness.ownerEpoch!==original.ownerEpoch||
      witness.cancelEpoch!==original.cancelEpoch){
    refuse('PRIVATE_DESKTOP_OWNER_REVOKED');
  }
  if(witness.inputDesktop!=='Default'){
    // Real Winlogon/UAC desktop must never be automated or switched.
    refuse('PRIVATE_DESKTOP_INPUT_DESKTOP_UNSAFE');
  }
  if(witness.processPid!==original.pid||
      witness.processCreationTime100ns!==original.creationTime100ns||
      witness.processSessionId!==original.sessionId||
      witness.processDesktopName!=='NexowirePrivate'||
      witness.desktopGeneration!==original.desktopGeneration||
      witness.guardianPid!==original.guardianPid||
      witness.guardianCreationTime100ns!==original.guardianCreationTime100ns||
      witness.jobHandleId!==original.jobHandleId||
      witness.processState!=='running'){
    refuse('PRIVATE_DESKTOP_PROVENANCE_STALE');
  }
  return Object.freeze({
    pid:original.pid,creationTime100ns:original.creationTime100ns,action,
  });
}
/**
 * Obtain a SECOND independent witness before committing a GUI/stop action.
 * This gate never performs an action; the caller must bind the returned
 * proof to a native OS handle/Job and must never replay an UNKNOWN effect.
 */
export async function verifyPrivateDesktopOwnerFence(
  original:PrivateDesktopLaunchIdentity,
  inspect:()=>Promise<PrivateDesktopKernelWitness>,
  action:'read'|'private-uia'|'stop',
):Promise<Readonly<{pid:number;creationTime100ns:string;action:typeof action}>>{
  const first=assertPrivateDesktopProcessProvenance(original,await inspect(),action);
  const second=assertPrivateDesktopProcessProvenance(original,await inspect(),action);
  if(first.pid!==second.pid||
     first.creationTime100ns!==second.creationTime100ns){
    refuse('PRIVATE_DESKTOP_PROVENANCE_STALE');
  }
  return second;
}
