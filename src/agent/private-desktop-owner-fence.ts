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

/**
 * The child launch reply (PID/stdout/exitCode=0) is UNTRUSTED until a
 * separately protected native collector verifies the actual parent/child
 * process creations and kernel Job membership. This is a pure source-only
 * contract, never the runtime CreateProcess or Job path.
 */
export interface PrivateDesktopChildLaunchReceipt {
  readonly child:PrivateDesktopLaunchIdentity;
  readonly claimedParentPid:number;
  readonly claimedParentCreationTime100ns:string;
  readonly requestId:string;
  readonly desktopGeneration:string;
}
export interface PrivateDesktopChildKernelWitness extends PrivateDesktopKernelWitness {
  readonly actualParentPid:number;
  readonly actualParentCreationTime100ns:string;
  readonly observedLaunchRequestId:string;
}
export function assertPrivateDesktopChildLaunchProvenance(
  protectedParent:PrivateDesktopLaunchIdentity,
  parentWitness:PrivateDesktopKernelWitness,
  untrustedReceipt:PrivateDesktopChildLaunchReceipt,
  childWitness:PrivateDesktopChildKernelWitness,
):Readonly<{childPid:number;childCreationTime100ns:string;result:'verified-source-only'}>{
  // Never infer provenance from a successful process launch report or a
  // matching PID alone. Both snapshots require the same protected Job.
  assertPrivateDesktopProcessProvenance(protectedParent,parentWitness,'read');
  const child=untrustedReceipt?.child;
  if(!child||!Number.isSafeInteger(child.pid)||
     !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
       untrustedReceipt.requestId??'')){
    refuse('PRIVATE_DESKTOP_PROVENANCE_MISSING');
  }
  if(untrustedReceipt.claimedParentPid!==protectedParent.pid||
     untrustedReceipt.claimedParentCreationTime100ns!==protectedParent.creationTime100ns||
     untrustedReceipt.desktopGeneration!==protectedParent.desktopGeneration||
     child.pid===protectedParent.pid||
     child.sessionId!==protectedParent.sessionId||
     child.desktopGeneration!==protectedParent.desktopGeneration||
     child.ownerEpoch!==protectedParent.ownerEpoch||
     child.cancelEpoch!==protectedParent.cancelEpoch||
     child.guardianPid!==protectedParent.guardianPid||
     child.guardianCreationTime100ns!==protectedParent.guardianCreationTime100ns||
     child.jobHandleId!==protectedParent.jobHandleId||
     !validTime(child.creationTime100ns)||
     BigInt(child.creationTime100ns)<BigInt(protectedParent.creationTime100ns)){
    refuse('PRIVATE_DESKTOP_PROVENANCE_STALE');
  }
  // The untrusted receipt cannot assert its own true parent.
  if(childWitness?.actualParentPid!==protectedParent.pid||
     childWitness.actualParentCreationTime100ns!==protectedParent.creationTime100ns||
     childWitness.observedLaunchRequestId!==untrustedReceipt.requestId){
    refuse('PRIVATE_DESKTOP_PROVENANCE_STALE');
  }
  assertPrivateDesktopProcessProvenance(child,childWitness,'read');
  return Object.freeze({
    childPid:child.pid,childCreationTime100ns:child.creationTime100ns,
    result:'verified-source-only' as const,
  });
}

export interface PrivateDesktopEmergencyStopObservation {
  readonly ownerEpoch:number;
  readonly cancelEpoch:number;
  /** If true, no new private UIA, child launch, or file-picker action. */
  readonly emergencyStopPending:boolean;
  readonly inputDesktop:string;
  /** "unknown" means an OS side effect may already have begun. */
  readonly pendingEffect:'none'|'native-write-in-flight'|'unknown';
  readonly requestId:string;
}
/**
 * Emergency STOP revokes NEW mutation dispatch and makes an in-flight write
 * UNKNOWN, not "undone". Verified cleanup/Job close must use a separate
 * protected OS path; it is never authorized by this function.
 */
export function assertPrivateDesktopEmergencyStopFence(
  before:PrivateDesktopEmergencyStopObservation,
  current:PrivateDesktopEmergencyStopObservation,
):Readonly<{requestId:string;kind:'source-only-mutation-gate'}>{
  if(!before||!current||
     !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(before.requestId??'')||
     before.requestId!==current.requestId||
     !Number.isSafeInteger(before.ownerEpoch)||before.ownerEpoch<1||
     !Number.isSafeInteger(before.cancelEpoch)||before.cancelEpoch<0||
     before.inputDesktop!=='Default'||current.inputDesktop!=='Default'){
    refuse('PRIVATE_DESKTOP_INPUT_DESKTOP_UNSAFE');
  }
  if(before.ownerEpoch!==current.ownerEpoch||
     before.cancelEpoch!==current.cancelEpoch||
     before.emergencyStopPending||current.emergencyStopPending){
    refuse('PRIVATE_DESKTOP_OWNER_REVOKED');
  }
  if(before.pendingEffect!=='none'||current.pendingEffect!=='none'){
    refuse('PRIVATE_DESKTOP_PROVENANCE_STALE');
  }
  return Object.freeze({
    requestId:before.requestId,kind:'source-only-mutation-gate' as const,
  });
}
