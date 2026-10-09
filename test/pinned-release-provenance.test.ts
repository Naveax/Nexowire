import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAttestationArgs,evaluateVerifiedReleaseProvenance,
  type ProvenancePins,
} from '../scripts/verify-pinned-release-provenance.js';

const pins:ProvenancePins={
  archiveSha256:'a'.repeat(64),
  tag:'v1.0.5',
  sourceCommit:'b'.repeat(40),
};
function fixture(){
  const ref='refs/tags/'+pins.tag;
  const repo='https://github.com/Naveax/Nexowire';
  const signer=repo+'/.github/workflows/release-readiness.yml@'+ref;
  return [{
    verificationResult:{
      mediaType:'application/vnd.dev.sigstore.verificationresult+json;version=0.1',
      signature:{certificate:{
        issuer:'https://token.actions.githubusercontent.com',
        subjectAlternativeName:signer,
        githubWorkflowRepository:'Naveax/Nexowire',
        githubWorkflowRef:ref,
        githubWorkflowSHA:pins.sourceCommit,
        sourceRepositoryURI:repo,
        sourceRepositoryDigest:pins.sourceCommit,
        sourceRepositoryRef:ref,
        buildSignerURI:signer,
        buildSignerDigest:pins.sourceCommit,
        runnerEnvironment:'github-hosted',
      }},
      verifiedTimestamps:[{type:'transparency-log',timestamp:'2026-10-08T12:00:00Z'}],
      statement:{
        _type:'https://in-toto.io/Statement/v1',
        predicateType:'https://slsa.dev/provenance/v1',
        subject:[{name:'nexowire-1.0.5.tgz',digest:{sha256:pins.archiveSha256}}],
        predicate:{
          buildDefinition:{
            buildType:'https://actions.github.io/buildtypes/workflow/v1',
            externalParameters:{workflow:{
              path:'.github/workflows/release-readiness.yml',
              ref,repository:repo,
            }},
            resolvedDependencies:[{uri:'git+'+repo+'@'+ref,digest:{gitCommit:pins.sourceCommit}}],
          },
          runDetails:{builder:{id:signer}},
        },
      },
    },
  }];
}
function checkFails(change:(f:ReturnType<typeof fixture>)=>void){
  const f=fixture();
  change(f);
  assert.throws(()=>evaluateVerifiedReleaseProvenance(f,pins),/RELEASE_PROVENANCE_NO_MATCHING_PINNED_ATTESTATION/);
}
test('builds exact signer, source and runner provenance restrictions, no shell',()=>{
  const args=buildAttestationArgs('C:\\test\\release.tgz',pins);
  for(const expected of [
    '--repo','Naveax/Nexowire',
    '--signer-workflow','Naveax/Nexowire/.github/workflows/release-readiness.yml',
    '--signer-digest',pins.sourceCommit,
    '--source-ref','refs/tags/v1.0.5',
    '--source-digest',pins.sourceCommit,
    '--cert-oidc-issuer','https://token.actions.githubusercontent.com',
    '--deny-self-hosted-runners','--predicate-type','https://slsa.dev/provenance/v1',
    '--format','json',
  ])assert.ok(args.includes(expected),expected);
  assert.equal(args[2],'C:\\test\\release.tgz');
});
test('valid verified provenance gives strictly non-elevated result',()=>{
  const result=evaluateVerifiedReleaseProvenance(fixture(),pins);
  assert.equal(result.status,'VERIFIED_RELEASE_PROVENANCE');
  assert.equal(result.artifactSha256,pins.archiveSha256);
  assert.equal(result.safeToElevate,false);
  assert.equal(result.protectedAclVerified,false);
  assert.equal(result.authorizedInstallerVerified,false);
  assert.equal(result.productionModified,false);
});
test('rejects invalid archive/tag/commit pins and arbitrary empty results',()=>{
  assert.throws(()=>buildAttestationArgs('x',{...pins,sourceCommit:'g'.repeat(40)}),/SOURCE_COMMIT_INVALID/);
  assert.throws(()=>buildAttestationArgs('x',{...pins,tag:'v1.0.5;rm -rf'}),/TAG_INVALID/);
  assert.throws(()=>evaluateVerifiedReleaseProvenance(fixture(),{...pins,archiveSha256:'x'}),/ARCHIVE_PIN_INVALID/);
  assert.throws(()=>evaluateVerifiedReleaseProvenance([],pins),/ATTESTATION_COUNT_INVALID/);
  assert.throws(()=>evaluateVerifiedReleaseProvenance('success',pins),/ATTESTATION_COUNT_INVALID/);
});
test('rejects wrong certificate fields including pinned signer and source',()=>{
  const changes=[
    (f:ReturnType<typeof fixture>)=>{f[0]!.verificationResult.signature.certificate.issuer='https://other.example';},
    (f:ReturnType<typeof fixture>)=>{f[0]!.verificationResult.signature.certificate.subjectAlternativeName='https://github.com/attacker/other';},
    (f:ReturnType<typeof fixture>)=>{f[0]!.verificationResult.signature.certificate.githubWorkflowRef='refs/heads/main';},
    (f:ReturnType<typeof fixture>)=>{f[0]!.verificationResult.signature.certificate.githubWorkflowSHA='c'.repeat(40);},
    (f:ReturnType<typeof fixture>)=>{f[0]!.verificationResult.signature.certificate.sourceRepositoryURI='https://github.com/other/repo';},
    (f:ReturnType<typeof fixture>)=>{f[0]!.verificationResult.signature.certificate.sourceRepositoryDigest='c'.repeat(40);},
    (f:ReturnType<typeof fixture>)=>{f[0]!.verificationResult.signature.certificate.sourceRepositoryRef='refs/heads/main';},
    (f:ReturnType<typeof fixture>)=>{f[0]!.verificationResult.signature.certificate.buildSignerDigest='c'.repeat(40);},
    (f:ReturnType<typeof fixture>)=>{f[0]!.verificationResult.signature.certificate.runnerEnvironment='self-hosted';},
  ];
  for(const change of changes)checkFails(change);
});
test('rejects wrong statement, subject, builder and source dependencies',()=>{
  checkFails(f=>{f[0]!.verificationResult.statement.predicateType='https://cyclonedx.org/bom';});
  checkFails(f=>{f[0]!.verificationResult.statement._type='wrong';});
  checkFails(f=>{f[0]!.verificationResult.statement.subject[0]!.name='evil.tgz';});
  checkFails(f=>{f[0]!.verificationResult.statement.subject[0]!.digest.sha256='c'.repeat(64);});
  checkFails(f=>{f[0]!.verificationResult.statement.predicate.buildDefinition.externalParameters.workflow.path='.github/workflows/other.yml';});
  checkFails(f=>{f[0]!.verificationResult.statement.predicate.buildDefinition.externalParameters.workflow.ref='refs/heads/main';});
  checkFails(f=>{f[0]!.verificationResult.statement.predicate.runDetails.builder.id='https://github.com/other/repo';});
  checkFails(f=>{f[0]!.verificationResult.statement.predicate.buildDefinition.resolvedDependencies[0]!.digest.gitCommit='c'.repeat(40);});
  checkFails(f=>{f[0]!.verificationResult.verifiedTimestamps.splice(0);});
  checkFails(f=>{f[0]!.verificationResult.mediaType='unsupported';});
});
test('skips unrelated attestation and accepts exact subsequent SLSA record',()=>{
  const unrelated=fixture()[0]!;
  unrelated.verificationResult.statement.subject[0]!.name='different.tgz';
  const ok=evaluateVerifiedReleaseProvenance([unrelated,...fixture()],pins);
  assert.equal(ok.safeToElevate,false);
});
