/**
 * Read-only storage headroom gate for explicitly approved physical cutover.
 *
 * The protected state destination and the interactive owner's source profile
 * can reside on different volumes or be redirected through volume mount points.
 * Probe the actual filesystem paths, never assume that "C:\" is sufficient.
 *
 * This gate does NOT authorize installation, task mutation or SYSTEM access.
 * 8 GiB remains the documented recommended reserve; the ~4.1 GiB operational
 * floor blocks an unsafe start. Do not treat the reserve as physical acceptance.
 */
import {statfs} from 'node:fs/promises';
import os from 'node:os';

export const SYSTEM_CUTOVER_STATE_VOLUME='C:\\';
export const SYSTEM_CUTOVER_STATE_PROBE_PATH='C:\\ProgramData';
export const SYSTEM_CUTOVER_MINIMUM_FREE_BYTES=BigInt(Math.ceil(4.1*1024**3));
export const SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES=8n*1024n**3n;

interface StatfsHeadroom {bsize:number;bavail:number}
export type CutoverStatfsReader=(path:string)=>Promise<StatfsHeadroom>;

export interface CutoverDiskReserveObservation {
  root:string;
  systemStateProbePath:string;
  userProfileProbePath:string;
  availableBytes:bigint;
  userProfileAvailableBytes:bigint;
  minimumFreeBytes:bigint;
  recommendedFreeBytes:bigint;
  recommendedReserveMet:boolean;
}

/** A failed/ambiguous probe of either data location must never return PASS. */
export async function assertSystemCutoverDiskReserve(
  read:CutoverStatfsReader=(probePath)=>statfs(probePath),
  userProfilePath:string=os.homedir(),
):Promise<CutoverDiskReserveObservation>{
  if(typeof userProfilePath!=='string'||!userProfilePath.trim()||
     userProfilePath.includes('\0')){
    throw new Error('AI04_CUTOVER_DISK_RESERVE_UNVERIFIED');
  }
  const freeBytes=async(probePath:string):Promise<bigint>=>{
    let disk:StatfsHeadroom;
    try{
      disk=await read(probePath);
    }catch{
      throw new Error('AI04_CUTOVER_DISK_RESERVE_UNVERIFIED');
    }
    if(!disk||!Number.isSafeInteger(disk.bsize)||disk.bsize<=0||
       !Number.isSafeInteger(disk.bavail)||disk.bavail<0){
      throw new Error('AI04_CUTOVER_DISK_RESERVE_UNVERIFIED');
    }
    return BigInt(disk.bsize)*BigInt(disk.bavail);
  };
  // The destination might be a ProgramData mount point, while the user state
  // may be under a different local volume. Both need verified headroom.
  const availableBytes=await freeBytes(SYSTEM_CUTOVER_STATE_PROBE_PATH);
  const userProfileAvailableBytes=await freeBytes(userProfilePath);
  if(availableBytes<SYSTEM_CUTOVER_MINIMUM_FREE_BYTES||
     userProfileAvailableBytes<SYSTEM_CUTOVER_MINIMUM_FREE_BYTES){
    throw new Error('AI04_CUTOVER_DISK_RESERVE_INSUFFICIENT');
  }
  return {
    root:SYSTEM_CUTOVER_STATE_VOLUME,
    systemStateProbePath:SYSTEM_CUTOVER_STATE_PROBE_PATH,
    userProfileProbePath:userProfilePath,
    availableBytes,
    userProfileAvailableBytes,
    minimumFreeBytes:SYSTEM_CUTOVER_MINIMUM_FREE_BYTES,
    recommendedFreeBytes:SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES,
    recommendedReserveMet:availableBytes>=SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES&&
      userProfileAvailableBytes>=SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES,
  };
}
