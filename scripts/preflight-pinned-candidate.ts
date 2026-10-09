import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  verifyPinnedReleaseProvenance,
  type ProvenancePins,type ProvenanceResult,
} from './verify-pinned-release-provenance.js';
import {
  verifyReleaseTree,
  type ReleaseTreeVerification,
} from './verify-release-tree.js';

export interface ReadOnlyCandidateInput {
  archivePath:string;
  checksumPath:string;
  extractedRoot:string;
  pins:ProvenancePins & {cliSha256:string};
}
export interface ReadOnlyCandidateResult {
  status:'PINNED_SOURCE_AND_TREE_MATCHED';
  releaseTag:string;
  sourceCommit:string;
  archiveSha256:string;
  cliSha256:string;
  treeDigest:string;
  checkedFiles:number;
  verifiedBy:'PINNED_GITHUB_SLSA_AND_FULL_ARCHIVE_TREE';
  windowsGithubCliSignerPreflight:boolean;
  codePublisherSignatureVerified:false;
  adminProtectedTreeVerified:false;
  unprivilegedWriteDenialVerified:false;
  productionRollbackRestorationTested:false;
  ownerCutoverAuthorized:false;
  safeToElevate:false;
  safeToCutover:false;
  productionModified:false;
}
const hash=/^[a-f0-9]{64}$/;
function reject(code:string):never{throw new Error('P0_CANDIDATE_'+code)}
function eq(a:string,b:string):boolean{return a===b}
/**
 * Compare two independently executed validators. Never use this function
 * alone as authentication: caller-supplied fabricated result JSON is not
 * cryptographic evidence. Only preflightPinnedCandidate runs the verifiers.
 */
export function assembleReadOnlyCandidateEvidence(
  input:ReadOnlyCandidateInput,
  tree:ReleaseTreeVerification,
  provenance:ProvenanceResult,
  treeAfter:ReleaseTreeVerification,
  platform=process.platform,
):ReadOnlyCandidateResult{
  const pins=input.pins;
  if(!hash.test(pins.archiveSha256)||!hash.test(pins.cliSha256)){
    reject('INVALID_PINNED_SHA256');
  }
  if(!/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(pins.tag)){
    reject('INVALID_RELEASE_TAG');
  }
  if(!/^[a-f0-9]{40}$/.test(pins.sourceCommit))reject('INVALID_SOURCE_COMMIT');
  if(tree.status!=='MATCHED'||treeAfter.status!=='MATCHED'||
    provenance.status!=='VERIFIED_RELEASE_PROVENANCE')reject('VERIFICATION_STATUS');
  if(provenance.sourceRepository!=='Naveax/Nexowire'||
     provenance.signerWorkflow!=='.github/workflows/release-readiness.yml'||
     provenance.cryptographicVerificationDelegatedTo!=='gh attestation verify'){
    reject('PROVENANCE_POLICY');
  }
  if(!eq(tree.archiveSha256,pins.archiveSha256)||
     !eq(treeAfter.archiveSha256,pins.archiveSha256)||
     !eq(provenance.artifactSha256,pins.archiveSha256)||
     !eq(tree.cliSha256,pins.cliSha256)||
     !eq(treeAfter.cliSha256,pins.cliSha256)||
     !eq(provenance.tag,pins.tag)||
     !eq(provenance.sourceCommit,pins.sourceCommit)||
     !eq(tree.version,pins.tag.slice(1))||
     !eq(treeAfter.version,pins.tag.slice(1))){
    reject('CROSS_SOURCE_PIN_MISMATCH');
  }
  if(tree.checkedFiles<1||tree.checkedFiles>20_000||
     tree.checkedFiles!==treeAfter.checkedFiles||
     !hash.test(tree.treeDigest)||
     tree.treeDigest!==treeAfter.treeDigest){
    reject('TREE_CHANGED_DURING_ATTESTATION');
  }
  if(tree.productionModified!==false||treeAfter.productionModified!==false||
    provenance.productionModified!==false||
    tree.safeToElevate!==false||treeAfter.safeToElevate!==false||
    provenance.safeToElevate!==false){
    reject('UNEXPECTED_SIDE_EFFECT_OR_PRIVILEGE');
  }
  return {
    status:'PINNED_SOURCE_AND_TREE_MATCHED',
    releaseTag:pins.tag,sourceCommit:pins.sourceCommit,
    archiveSha256:pins.archiveSha256,cliSha256:pins.cliSha256,
    treeDigest:tree.treeDigest,checkedFiles:tree.checkedFiles,
    verifiedBy:'PINNED_GITHUB_SLSA_AND_FULL_ARCHIVE_TREE',
    windowsGithubCliSignerPreflight:platform==='win32',
    codePublisherSignatureVerified:false,
    adminProtectedTreeVerified:false,
    unprivilegedWriteDenialVerified:false,
    productionRollbackRestorationTested:false,
    ownerCutoverAuthorized:false,
    safeToElevate:false,safeToCutover:false,productionModified:false,
  };
}
/** Read-only, non-elevating prerequisite. Never stage or execute code. */
export async function preflightPinnedCandidate(
  input:ReadOnlyCandidateInput,
):Promise<ReadOnlyCandidateResult>{
  const pins=input.pins;
  // The SHA-256 and tag must be independently owner approved. Never derive
  // pins from files within a caller-controlled extracted directory.
  if(!hash.test(pins.archiveSha256)||!hash.test(pins.cliSha256)||
     !/^[a-f0-9]{40}$/.test(pins.sourceCommit)||
     !/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(pins.tag)){
    reject('INVALID_INPUT_PINS');
  }
  const options={
    archivePath:input.archivePath,
    checksumPath:input.checksumPath,
    extractedRoot:input.extractedRoot,
    expectedArchiveSha256:pins.archiveSha256,
    expectedCliSha256:pins.cliSha256,
    expectedVersion:pins.tag.slice(1),
  };
  // Recheck the entire on-disk package after the network attestation. This
  // rejects ordinary mutations during the check, not post-check races.
  const before=await verifyReleaseTree(options);
  const provenance=await verifyPinnedReleaseProvenance(input.archivePath,pins);
  const after=await verifyReleaseTree(options);
  return assembleReadOnlyCandidateEvidence(input,before,provenance,after);
}
async function main():Promise<void>{
  // args: archive, SHA256SUMS, extracted-root, tag, commit, tarhash, clihash
  if(process.argv.length!==9){
    throw new Error('Usage: node --import tsx scripts/preflight-pinned-candidate.ts <tarball.tgz> <SHA256SUMS> <extracted-package-dir> <vTAG> <source-commit-sha1> <approved-archive-sha256> <approved-cli-sha256>');
  }
  const [, ,archivePath,checksumPath,extractedRoot,tag,sourceCommit,archiveSha256,cliSha256]=process.argv;
  const report=await preflightPinnedCandidate({
    archivePath:archivePath!,checksumPath:checksumPath!,extractedRoot:extractedRoot!,
    pins:{tag:tag!,sourceCommit:sourceCommit!,archiveSha256:archiveSha256!,cliSha256:cliSha256!},
  });
  process.stdout.write(JSON.stringify(report)+'\n');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(error=>{
    process.stderr.write((error instanceof Error?error.message:'P0_CANDIDATE_UNKNOWN')+'\n');
    process.exitCode=1;
  });
}
