import {reviewOfflineSignedSqliteRollback,type ReviewedSqliteRollbackRuntime} from './ai02-signed-sqlite-rollback-review.js';
import type {HelperPin} from '../src/installer/protected-transfer-helper-lifecycle.js';
/** AI-02 read-only review for the independent observer. No private key,
 * writer fence or rollback permission is created here. */
export async function readSqliteHelperRollbackReview(input:Parameters<typeof reviewOfflineSignedSqliteRollback>[0]&{
  reviewedHelper:Readonly<{path:string;pin:HelperPin}>;
}){
  const raw=Buffer.from(input.candidate.manifestUtf8);
  const reviewed:ReviewedSqliteRollbackRuntime=Object.freeze({...input.reviewedRuntime});
  const helper=Object.freeze({path:input.reviewedHelper.path,pin:Object.freeze({...input.reviewedHelper.pin})});
  const result=await reviewOfflineSignedSqliteRollback({...input,reviewedRuntime:reviewed,candidate:{...input.candidate,manifestUtf8:raw}});
  const manifest=JSON.parse(raw.toString('utf8')) as {files?:Array<{path:string;sha256:string}>};
  if(!Array.isArray(manifest.files)||manifest.files.filter(f=>f.path===helper.path&&f.sha256===helper.pin.sha256).length!==1||
     !/^[a-f0-9]{64}$/.test(helper.pin.signerSha256)||helper.pin.signerSha256.length!==64||
     result.runtime.reviewedSqliteOnlyPinMatches!==true||result.runtime.releaseAnchorAdvanced!==false||
     result.offlineDurableStateMatches!==true||result.productionRollbackAuthorized!==false)
    throw Error('HELPER_SQLITE_REVIEW_NOT_BOUND');
  return Object.freeze({manifestSha256:result.runtime.manifestSha256,sourceCommit:result.runtime.sourceCommit,
    releaseSequence:result.runtime.releaseSequence,schemaVersion:result.runtime.ledgerSchemaVersion,
    treeSha256:result.treeSha256,sqliteRecords:result.sqliteRecords,releaseAnchorAdvanced:false as const,productionRollbackAuthorized:false as const});
}
