import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  buildAttestationArgs,evaluateVerifiedReleaseProvenance,
  pinnedGithubCliExecutable,isolatedGithubCliEnvironment,assertTrustedWindowsGithubCli,
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

test('Windows preflight picks fixed GitHub CLI instead of search-path executable',()=>{
  assert.equal(pinnedGithubCliExecutable('win32'),'C:\\Program Files\\GitHub CLI\\gh.exe');
  assert.equal(pinnedGithubCliExecutable('linux'),'gh');
  const env=isolatedGithubCliEnvironment('win32');
  assert.equal(env.PATH,'C:\\Windows\\System32;C:\\Windows');
  assert.equal(env.SystemRoot,'C:\\Windows');
  for(const dangerous of [
    'NODE_OPTIONS','NODE_PATH','PSModulePath','GH_HOST','GH_CONFIG_DIR',
    'GH_ENTERPRISE_TOKEN','GIT_CONFIG_GLOBAL','GIT_SSH_COMMAND','COMSPEC',
  ])assert.equal(env[dangerous],undefined,dangerous);
});
test('PATH-injected fake gh cannot replace fixed, signed Windows GitHub CLI',{
  skip:process.platform!=='win32'||!existsSync('C:\\Program Files\\GitHub CLI\\gh.exe'),
},()=>{
  const tmp=mkdtempSync(path.join(tmpdir(),'nx-gh-spoof-'));
  const fake=path.join(tmp,'gh.exe');
  const before=process.env.PATH;
  writeFileSync(fake,'malicious gh.exe stub that must never execute');
  try{
    process.env.PATH=tmp+';'+(before||'');
    assert.equal(pinnedGithubCliExecutable(),'C:\\Program Files\\GitHub CLI\\gh.exe');
    assert.ok(!isolatedGithubCliEnvironment().PATH?.includes(tmp));
    assert.doesNotThrow(()=>assertTrustedWindowsGithubCli());
    assert.equal(readFileSync(fake,'utf8'),'malicious gh.exe stub that must never execute');
  }finally{
    if(before===undefined)delete process.env.PATH;else process.env.PATH=before;
    rmSync(tmp,{recursive:true,force:true});
  }
});
test('Windows trust check fails closed with unsigned/mutable executable paths in source',()=>{
  const source=readFileSync(new URL('../scripts/verify-pinned-release-provenance.ts',import.meta.url),'utf8');
  assert.ok(source.includes("WINDOWS_GH_EXE='C:\\\\Program Files\\\\GitHub CLI\\\\gh.exe'"));
  assert.ok(source.includes("'GH_UNTRUSTED_OWNER'"));
  assert.ok(source.includes("'GH_UNTRUSTED_WRITE_ACE'"));
  assert.ok(source.includes("'GH_UNTRUSTED_AUTHENTICODE_PUBLISHER'"));
  assert.ok(source.includes('Get-AuthenticodeSignature'));
  assert.ok(source.includes('GH_EXECUTABLE_UNTRUSTED'));
  assert.ok(source.includes("const run=spawnSync(executable,buildAttestationArgs"));
  assert.ok(!source.includes("spawnSync('gh',buildAttestationArgs"));
});
