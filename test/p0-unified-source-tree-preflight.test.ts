import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  assembleReadOnlyCandidateEvidence,type ReadOnlyCandidateInput,
} from '../scripts/preflight-pinned-candidate.js';
import type {ReleaseTreeVerification} from '../scripts/verify-release-tree.js';
import type {ProvenanceResult} from '../scripts/verify-pinned-release-provenance.js';

const sha=(char:string)=>char.repeat(64);
const commit='a'.repeat(40);
const input:ReadOnlyCandidateInput={
  archivePath:'test.tgz',checksumPath:'SHA256SUMS',extractedRoot:'testroot',
  pins:{tag:'v1.0.5',sourceCommit:commit,archiveSha256:sha('b'),cliSha256:sha('c')},
};
function before():ReleaseTreeVerification{
  return {status:'MATCHED',archiveSha256:input.pins.archiveSha256,
    version:'1.0.5',checkedFiles:431,treeDigest:sha('d'),
    cliSha256:input.pins.cliSha256,codeSignatureVerified:false,
    protectedAclVerified:false,authorizedInstallerVerified:false,
    safeToElevate:false,productionModified:false};
}
function signed():ProvenanceResult{
  return {status:'VERIFIED_RELEASE_PROVENANCE',
    artifactSha256:input.pins.archiveSha256,
    tag:input.pins.tag,sourceCommit:input.pins.sourceCommit,
    sourceRepository:'Naveax/Nexowire',
    signerWorkflow:'.github/workflows/release-readiness.yml',
    cryptographicVerificationDelegatedTo:'gh attestation verify',
    protectedAclVerified:false,authorizedInstallerVerified:false,
    safeToElevate:false,productionModified:false};
}
test('matched source and extracted package cannot authorize elevation or cutover',()=>{
  const x=assembleReadOnlyCandidateEvidence(input,before(),signed(),before(),'win32');
  assert.equal(x.status,'PINNED_SOURCE_AND_TREE_MATCHED');
  assert.equal(x.treeDigest,sha('d'));
  assert.equal(x.checkedFiles,431);
  assert.equal(x.windowsGithubCliSignerPreflight,true);
  for(const key of [
    'codePublisherSignatureVerified','adminProtectedTreeVerified',
    'unprivilegedWriteDenialVerified','productionRollbackRestorationTested',
    'ownerCutoverAuthorized','safeToElevate','safeToCutover','productionModified',
  ] as const)assert.equal(x[key],false,key);
});
test('rejects forged cross-source archive, source ref and executable pins',()=>{
  const mismatches:[
    ReleaseTreeVerification,ProvenanceResult,ReleaseTreeVerification
  ][]=[
    [{...before(),archiveSha256:sha('f')},signed(),before()],
    [before(),{...signed(),sourceCommit:'f'.repeat(40)},before()],
    [before(),{...signed(),tag:'v1.0.4'},before()],
    [before(),{...signed(),artifactSha256:sha('f')},before()],
    [before(),signed(),{...before(),cliSha256:sha('e')}],
    [before(),signed(),{...before(),treeDigest:sha('e')}],
    [before(),signed(),{...before(),checkedFiles:432}],
  ];
  for(const [a,b,c] of mismatches){
    assert.throws(()=>assembleReadOnlyCandidateEvidence(input,a,b,c),/P0_CANDIDATE_/);
  }
});
test('fails on malformed pins and unexpected elevated/side effect flags',()=>{
  assert.throws(()=>assembleReadOnlyCandidateEvidence({
    ...input,pins:{...input.pins,cliSha256:'bad'}
  },before(),signed(),before()),/P0_CANDIDATE_INVALID_PINNED_SHA256/);
  assert.throws(()=>assembleReadOnlyCandidateEvidence(
    input,{...before(),safeToElevate:true} as unknown as ReleaseTreeVerification,signed(),before()
  ),/P0_CANDIDATE_UNEXPECTED_SIDE_EFFECT_OR_PRIVILEGE/);
  assert.throws(()=>assembleReadOnlyCandidateEvidence(
    input,before(),{...signed(),productionModified:true} as unknown as ProvenanceResult,before()
  ),/P0_CANDIDATE_UNEXPECTED_SIDE_EFFECT_OR_PRIVILEGE/);
  assert.throws(()=>assembleReadOnlyCandidateEvidence(
    input,{...before(),checkedFiles:0},signed(),before()
  ),/P0_CANDIDATE_TREE_CHANGED_DURING_ATTESTATION/);
});
test('real orchestration invokes each verifier with reread of tree and no installer',()=>{
  const src=readFileSync(new URL('../scripts/preflight-pinned-candidate.ts',import.meta.url),'utf8');
  assert.ok(src.includes('const before=await verifyReleaseTree(options)'));
  assert.ok(src.includes('const provenance=await verifyPinnedReleaseProvenance(input.archivePath,pins)'));
  assert.ok(src.includes('const after=await verifyReleaseTree(options)'));
  assert.doesNotMatch(src,/execFileSync|spawnSync|Register-ScheduledTask|hardenWindowsProgramDataAcl|fs\.writeFile|fs\.rename/);
});
