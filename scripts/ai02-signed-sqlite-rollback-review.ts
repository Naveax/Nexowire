/**
 * Source-only signed SQLite rollback candidate review.
 * No updater, executable launch, task, release anchor or ledger mutation.
 * The caller must supply an independently reviewed artifact pin and an
 * authenticated anchor; synthetic pins cannot establish production authority.
 * State inspection is for disposable, quiesced offline copies only.
 */
import {createHash} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {verifyCoreRuntimePackageCandidate} from '../src/security/core-runtime-package-manifest.js';
import {
  captureLegacyHubStateSnapshotProof,compareLegacyHubStateSnapshotProofs,
  type StateSnapshotProof,
} from './ai04-state-snapshot-proof.js';

type CandidateOptions=Parameters<typeof verifyCoreRuntimePackageCandidate>[0];
export interface ReviewedSqliteRollbackRuntime {
  readonly manifestSha256:string;
  readonly sourceCommit:string;
  readonly releaseSequence:number;
  readonly reader:'sqlite-only';
  readonly schemaVersion:1;
}
function fail(code:string):never{throw new Error('AI02_SIGNED_SQLITE_ROLLBACK_'+code)}
function freezeReview(review:ReviewedSqliteRollbackRuntime):Readonly<ReviewedSqliteRollbackRuntime>{
  const {manifestSha256,sourceCommit,releaseSequence,reader,schemaVersion}=review;
  if(typeof manifestSha256!=='string'||! /^[a-f0-9]{64}$/.test(manifestSha256)||
     typeof sourceCommit!=='string'||! /^[a-f0-9]{40}$/.test(sourceCommit)||
     !Number.isSafeInteger(releaseSequence)||releaseSequence<1||
     reader!=='sqlite-only'||schemaVersion!==1)fail('RUNTIME_REVIEW_REQUIRED');
  return Object.freeze({manifestSha256,sourceCommit,releaseSequence,reader,schemaVersion});
}

/** The signed code identity must match a separately reviewed SQLite-only pin.
 * A signature alone does not establish reader semantics. Do not rewind the
 * independent release anchor to accept an older binary during rollback.
 */
export async function reviewSignedSqliteRollbackRuntime(
  candidate:CandidateOptions,reviewedRuntime:ReviewedSqliteRollbackRuntime,
){
  const review=freezeReview(reviewedRuntime);
  const raw=Buffer.from(candidate.manifestUtf8);
  if(createHash('sha256').update(raw).digest('hex')!==review.manifestSha256||
     candidate.expectedSourceCommit!==review.sourceCommit)fail('RUNTIME_PIN_MISMATCH');
  const readAnchor=candidate.readReleaseAnchor;
  const result=await verifyCoreRuntimePackageCandidate({...candidate,manifestUtf8:raw,
    readReleaseAnchor:async()=>{
      const anchor=await readAnchor();
      if(!anchor||anchor.acceptedSequence!==review.releaseSequence||
         anchor.acceptedManifestSha256!==review.manifestSha256)
        fail('ACCEPTED_ANCHOR_REQUIRED');
      return anchor;
    },
  });
  if(result.manifestSha256!==review.manifestSha256||
     result.sourceCommit!==review.sourceCommit||
     result.releaseSequence!==review.releaseSequence)fail('RUNTIME_PIN_MISMATCH');
  return {...result,reviewedSqliteOnlyPinMatches:true as const,
    ledgerSchemaVersion:review.schemaVersion,rollbackAuthorized:false as const};
}

function assertSameProof(a:StateSnapshotProof,b:StateSnapshotProof):void{
  if(a.sqliteQuickCheck!=='ok'||b.sqliteQuickCheck!=='ok'||
     a.fileCount!==b.fileCount||a.totalBytes!==b.totalBytes||
     a.workspaceFileCount!==b.workspaceFileCount||a.sqliteRecords!==b.sqliteRecords||
     !compareLegacyHubStateSnapshotProofs(a,b).matches)
    fail('CURRENT_LEDGER_NOT_PRESERVED');
}
function distinct(a:string,b:string):boolean{
  const sep=path.sep;
  const left=process.platform==='win32'?a.toLowerCase():a;
  const right=process.platform==='win32'?b.toLowerCase():b;
  return left!==right&&!left.startsWith(right.endsWith(sep)?right:right+sep)&&
    !right.startsWith(left.endsWith(sep)?left:left+sep);
}
function assertSchema(root:string,expected:number):void{
  const db=new DatabaseSync(path.join(root,'idempotency-records.sqlite'),{readOnly:true});
  try{
    const row=db.prepare("SELECT value FROM idempotency_meta WHERE key='schema_version'").get();
    if(row?.value!==String(expected))fail('LEDGER_SCHEMA_UNREVIEWED');
  }finally{db.close()}
}
/**
 * Verify a signed candidate and independent current/preserved offline copies.
 * The second snapshot is evidence, NEVER a source for restoring old state.
 * Main DB and durable WAL are included in the existing fingerprint. SHM is
 * rebuildable metadata; the inventory validates its presence/type as applicable,
 * not byte equality. SQLite read-only inspection may refresh the offline SHM.
 * Even success leaves physical/production rollback explicitly unauthorized.
 */
export async function reviewOfflineSignedSqliteRollback(input:{
  candidate:CandidateOptions;reviewedRuntime:ReviewedSqliteRollbackRuntime;
  currentOfflineRoot:string;preservedOfflineRoot:string;
}){
  if(process.platform!=='win32')fail('WINDOWS_OFFLINE_REVIEW_ONLY');
  const review=freezeReview(input.reviewedRuntime);
  const current=await realpath(input.currentOfflineRoot);
  const preserved=await realpath(input.preservedOfflineRoot);
  const payload=await realpath(input.candidate.payloadRoot);
  // Reject aliases, noncanonical paths and overlap among the three trees.
  const equal=(a:string,b:string)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
  if(!equal(current,input.currentOfflineRoot)||!equal(preserved,input.preservedOfflineRoot)||
     !equal(payload,input.candidate.payloadRoot)||!distinct(current,preserved)||
     !distinct(current,payload)||!distinct(preserved,payload))fail('OFFLINE_ROOT_UNTRUSTED');
  const first=await captureLegacyHubStateSnapshotProof(current);
  const saved=await captureLegacyHubStateSnapshotProof(preserved);
  assertSchema(current,review.schemaVersion);assertSchema(preserved,review.schemaVersion);
  assertSameProof(first,saved);
  const runtime=await reviewSignedSqliteRollbackRuntime(input.candidate,review);
  const currentAfter=await captureLegacyHubStateSnapshotProof(current);
  const preservedAfter=await captureLegacyHubStateSnapshotProof(preserved);
  assertSameProof(first,currentAfter);assertSameProof(saved,preservedAfter);
  return {runtime,offlineDurableStateMatches:true as const,
    treeSha256:currentAfter.treeSha256,sqliteRecords:currentAfter.sqliteRecords,
    writerQuiescenceVerified:false as const,productionRollbackAuthorized:false as const,
    physicalAcceptance:'NOT_PROVEN' as const,releaseGate:'MISSING' as const};
}
