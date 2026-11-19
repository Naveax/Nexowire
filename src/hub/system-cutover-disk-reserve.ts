/**
 * Read-only storage headroom gate for explicitly approved physical cutover.
 *
 * The installer copies protected state and may need space for a reversible
 * recovery journal. A one-time operator preflight is insufficient if other
 * processes consume disk before the legacy Hub writer is quiesced.
 *
 * This gate does NOT authorize installation, task mutation or SYSTEM access.
 * 8 GiB remains the documented recommended reserve; the ~4.1 GiB operational
 * floor blocks an unsafe start. Do not treat the reserve as physical acceptance.
 */
import {statfs} from 'node:fs/promises';

export const SYSTEM_CUTOVER_STATE_VOLUME='C:\\';
export const SYSTEM_CUTOVER_MINIMUM_FREE_BYTES=BigInt(Math.ceil(4.1*1024**3));
export const SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES=8n*1024n**3n;

interface StatfsHeadroom {bsize:number;bavail:number}
export type CutoverStatfsReader=(root:string)=>Promise<StatfsHeadroom>;

export interface CutoverDiskReserveObservation {
  root:string;
  availableBytes:bigint;
  minimumFreeBytes:bigint;
  recommendedFreeBytes:bigint;
  recommendedReserveMet:boolean;
}

/** A failed/ambiguous filesystem probe must never return a PASS. */
export async function assertSystemCutoverDiskReserve(
  read:CutoverStatfsReader=(root)=>statfs(root),
):Promise<CutoverDiskReserveObservation>{
  let disk:StatfsHeadroom;
  try{
    disk=await read(SYSTEM_CUTOVER_STATE_VOLUME);
  }catch{
    throw new Error('AI04_CUTOVER_DISK_RESERVE_UNVERIFIED');
  }
  if(!disk||!Number.isSafeInteger(disk.bsize)||disk.bsize<=0||
     !Number.isSafeInteger(disk.bavail)||disk.bavail<0){
    throw new Error('AI04_CUTOVER_DISK_RESERVE_UNVERIFIED');
  }
  const availableBytes=BigInt(disk.bsize)*BigInt(disk.bavail);
  if(availableBytes<SYSTEM_CUTOVER_MINIMUM_FREE_BYTES){
    throw new Error('AI04_CUTOVER_DISK_RESERVE_INSUFFICIENT');
  }
  return {
    root:SYSTEM_CUTOVER_STATE_VOLUME,
    availableBytes,
    minimumFreeBytes:SYSTEM_CUTOVER_MINIMUM_FREE_BYTES,
    recommendedFreeBytes:SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES,
    recommendedReserveMet:availableBytes>=SYSTEM_CUTOVER_RECOMMENDED_FREE_BYTES,
  };
}
