/**
 * Reversible transition driver. All side effects are supplied by the Windows
 * adapter; an armed recovery path must exist before the old writer is stopped.
 */
/**
 * A healthy SYSTEM PID and HTTP 200 are a provisional deployment, not
 * physical cutover acceptance. Keep the independent rollback task armed.
 */
export function postHealthSystemHubDisposition():{
  journalPhase:'AWAITING_PHYSICAL_ACCEPTANCE';
  retainRecoveryTask:true;
  physicalRebootAccepted:false;
}{
  return {journalPhase:'AWAITING_PHYSICAL_ACCEPTANCE',
    retainRecoveryTask:true,physicalRebootAccepted:false};
}
export interface SystemCutoverOperations {
  preflight():Promise<void>;
  armRecovery():Promise<void>;
  quiesceLegacy():Promise<void>;
  copyProtectedState():Promise<void>;
  issueReceipt():Promise<void>;
  installSystemHub():Promise<void>;
  verifySystemHub():Promise<void>;
  commit():Promise<void>;
  rollback():Promise<void>;
}
export type SystemCutoverStep =
  'preflight'|'arm-recovery'|'quiesce-legacy'|'copy-protected-state'|
  'issue-receipt'|'install-system-hub'|'verify-system-hub'|'commit';
export class SystemCutoverFailed extends Error {
  constructor(
    readonly failedStep:SystemCutoverStep,
    readonly rollbackFailed:boolean,
    readonly cause:unknown,
    readonly rollbackAttempted=true,
  ){
    super('SYSTEM_HUB_CUTOVER_FAILED_'+failedStep.toUpperCase().replaceAll('-','_')+
      (!rollbackAttempted?'_RECOVERY_UNVERIFIED':
        rollbackFailed?'_ROLLBACK_FAILED':'_ROLLED_BACK'));
    this.name='SystemCutoverFailed';
  }
}
export async function runRecoverableSystemHubCutover(
  ops:SystemCutoverOperations,
):Promise<{booted:true;rollbackArmed:true;physicalRebootAccepted:false;pendingPhysicalAcceptance:true}>{
  await ops.preflight();
  // A failed or partially completed arm step does not prove a durable
  // recovery task exists. The old writer has not been stopped yet, so
  // attempting a rollback here could execute an unverified recovery script.
  try{
    await ops.armRecovery();
  }catch(error){
    throw new SystemCutoverFailed('arm-recovery',false,error,false);
  }
  let step:SystemCutoverStep='quiesce-legacy';
  try{
    await ops.quiesceLegacy();
    step='copy-protected-state'; await ops.copyProtectedState();
    step='issue-receipt'; await ops.issueReceipt();
    step='install-system-hub'; await ops.installSystemHub();
    step='verify-system-hub'; await ops.verifySystemHub();
    step='commit'; await ops.commit();
  }catch(error){
    try{await ops.rollback()}catch(rollbackError){
      throw new SystemCutoverFailed(step,true,new AggregateError(
        [error,rollbackError],'SYSTEM_HUB_CUTOVER_AND_ROLLBACK_FAILED'));
    }
    throw new SystemCutoverFailed(step,false,error);
  }
  return {booted:true,rollbackArmed:true,physicalRebootAccepted:false,pendingPhysicalAcceptance:true};
}
