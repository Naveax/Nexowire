import type {reviewOfflineSignedSqliteRollback,ReviewedSqliteRollbackRuntime} from './ai02-signed-sqlite-rollback-review.js';
import type {HelperPin} from '../src/installer/protected-transfer-helper-lifecycle.js';
import {collectOfflineRecoveryEvidence,type ApprovedOfflineRecoveryBaseline} from './ai02-offline-recovery-evidence.js';
/** AI-02 read-only review for the independent observer. No private key,
 * writer fence or rollback permission is created here. */
export async function readSqliteHelperRollbackReview(input:Parameters<typeof reviewOfflineSignedSqliteRollback>[0]&{
  reviewedHelper:Readonly<{path:string;pin:HelperPin}>;
  approved:ApprovedOfflineRecoveryBaseline;
}){
  const raw=Buffer.from(input.candidate.manifestUtf8);
  const reviewed:ReviewedSqliteRollbackRuntime=Object.freeze({...input.reviewedRuntime});
  const helper=Object.freeze({path:input.reviewedHelper.path,pin:Object.freeze({...input.reviewedHelper.pin})});
  const approved=Object.freeze({...input.approved});
  const result=await collectOfflineRecoveryEvidence({...input,approved,purpose:'rollback-review',
    reviewedRuntime:reviewed,candidate:{...input.candidate,manifestUtf8:raw}});
  const manifest=JSON.parse(raw.toString('utf8')) as {files?:Array<{path:string;sha256:string}>};
  if(!Array.isArray(manifest.files)||manifest.files.filter(f=>f.path===helper.path&&f.sha256===helper.pin.sha256).length!==1||
     !/^[a-f0-9]{64}$/.test(helper.pin.signerSha256)||helper.pin.signerSha256.length!==64||
     result.runtimeManifestSha256!==reviewed.manifestSha256||
     result.currentStateSha256!==approved.treeSha256||result.approvedStateSha256!==approved.treeSha256||
     result.sqliteStatus.sqliteRecords!==approved.sqliteRecords||result.sqliteStatus.schemaVersion!==reviewed.schemaVersion||
     result.sqliteStatus.unknown!==0||result.sqliteStatus.inProgress!==0||
     result.writerFenced!==false||result.recoveryPending!=='UNVERIFIED'||result.priorHelperCompatible!==false||
     result.productionRollbackAuthorized!==false||result.productionUninstallAuthorized!==false)
    throw Error('HELPER_SQLITE_REVIEW_NOT_BOUND');
  // The actual AI02 collector verified the signed candidate and accepted
  // anchor against these frozen values, plus the fixed offline baseline.
  // This projection deliberately contains no live native fence/launch claim.
  return Object.freeze({manifestSha256:result.runtimeManifestSha256,sourceCommit:reviewed.sourceCommit,
    releaseSequence:reviewed.releaseSequence,schemaVersion:result.sqliteStatus.schemaVersion,
    treeSha256:result.currentStateSha256,sqliteRecords:result.sqliteStatus.sqliteRecords,
    succeeded:result.sqliteStatus.succeeded,failed:result.sqliteStatus.failed,
    unknown:result.sqliteStatus.unknown,inProgress:result.sqliteStatus.inProgress,
    releaseAnchorAdvanced:false as const,productionRollbackAuthorized:false as const});
}
