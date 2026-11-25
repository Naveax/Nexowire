/** Candidate evidence only. No signing key, live task access, release admission or cleanup. */
import {inspectOfflineSqliteStatus,assertOfflineSqliteNoUnresolvedOperations}
  from '../src/hub/sqlite-rollback-offline-evidence.js';
import {captureLegacyHubStateSnapshotProof} from './ai04-state-snapshot-proof.js';
import {reviewOfflineSignedSqliteRollback} from './ai02-signed-sqlite-rollback-review.js';
import {assertDurableRollbackConfirmation} from './ai04-controlled-system-hub-cutover.js';

type ReviewInput=Parameters<typeof reviewOfflineSignedSqliteRollback>[0];
type ExpectedReceipt=Parameters<typeof assertDurableRollbackConfirmation>[1];
export interface ApprovedOfflineRecoveryBaseline {
  readonly treeSha256:string;
  readonly sqliteRecords:number;
  readonly runtimeManifestSha256:string;
}
function fail(code:string):never{throw Error('AI02_OFFLINE_RECOVERY_'+code)}
const isHash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function approve(v:ApprovedOfflineRecoveryBaseline){
  const {treeSha256,sqliteRecords,runtimeManifestSha256}=v;
  if(!isHash(treeSha256)||!isHash(runtimeManifestSha256)||
    !Number.isSafeInteger(sqliteRecords)||sqliteRecords<0)fail('BASELINE_REQUIRED');
  return Object.freeze({treeSha256,sqliteRecords,runtimeManifestSha256});
}
/**
 * Use one separately retained approved baseline across BEGIN_DEPLOYMENT and
 * COMMIT; equal copies alone cannot establish which state was approved.
 * A rollback journal receipt, even valid, does not establish live task absence.
 * The offline review cannot issue the AI-05 signed positive guard claims.
 */
export async function collectOfflineRecoveryEvidence(input:ReviewInput&{
  approved:ApprovedOfflineRecoveryBaseline;
  purpose:'rollback-review'|'coordinated-uninstall-review';
  terminalReceipt?:{bytes:Buffer;expected:ExpectedReceipt};
}){
  const approved=approve(input.approved);
  const purpose=input.purpose;
  if(purpose!=='rollback-review'&&purpose!=='coordinated-uninstall-review')fail('PURPOSE_UNREVIEWED');
  const current=input.currentOfflineRoot,preserved=input.preservedOfflineRoot;
  const receipt=input.terminalReceipt?{
    bytes:Buffer.from(input.terminalReceipt.bytes),
    expected:Object.freeze({...input.terminalReceipt.expected}),
  }:undefined;
  if(purpose==='coordinated-uninstall-review'&&!receipt)fail('TERMINAL_RECEIPT_REQUIRED');
  if(receipt)assertDurableRollbackConfirmation(receipt.bytes,receipt.expected);
  const review=await reviewOfflineSignedSqliteRollback({...input,currentOfflineRoot:current,
    preservedOfflineRoot:preserved});
  if(review.treeSha256!==approved.treeSha256||review.sqliteRecords!==approved.sqliteRecords||
     review.runtime.manifestSha256!==approved.runtimeManifestSha256)fail('APPROVED_BASELINE_MISMATCH');
  const currentStatus=inspectOfflineSqliteStatus(current),preservedStatus=inspectOfflineSqliteStatus(preserved);
  assertOfflineSqliteNoUnresolvedOperations(currentStatus);
  assertOfflineSqliteNoUnresolvedOperations(preservedStatus);
  if(currentStatus.sqliteRecords!==approved.sqliteRecords||
     JSON.stringify(currentStatus)!==JSON.stringify(preservedStatus))fail('LEDGER_STATUS_MISMATCH');
  // The status query can refresh SHM, but the durable state must be unchanged.
  for(const root of [current,preserved]){
    const proof=await captureLegacyHubStateSnapshotProof(root);
    if(proof.treeSha256!==approved.treeSha256||proof.sqliteRecords!==approved.sqliteRecords)
      fail('APPROVED_BASELINE_MISMATCH');
  }
  return Object.freeze({purpose,approvedStateSha256:approved.treeSha256,
    currentStateSha256:review.treeSha256,sqliteStatus:currentStatus,
    runtimeManifestSha256:review.runtime.manifestSha256,
    terminalReceiptMatches:receipt!==undefined,
    // These are actual limitations, not positive signed witness flags.
    writerFenced:false as const,recoveryPending:'UNVERIFIED' as const,
    priorHelperCompatible:false as const,productionRollbackAuthorized:false as const,
    productionUninstallAuthorized:false as const,releaseGate:'MISSING' as const});
}
