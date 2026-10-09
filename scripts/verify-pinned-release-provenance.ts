import {createHash, timingSafeEqual} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REPOSITORY='Naveax/Nexowire';
const REPO_URL='https://github.com/'+REPOSITORY;
const WORKFLOW='.github/workflows/release-readiness.yml';
const OIDC_ISSUER='https://token.actions.githubusercontent.com';
const PREDICATE='https://slsa.dev/provenance/v1';
const MAX_ARCHIVE_BYTES=32*1024*1024;
const MAX_VERIFICATION_BYTES=2*1024*1024;
const hex64=/^[a-f0-9]{64}$/;
const hex40=/^[a-f0-9]{40}$/;
const tagPattern=/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

type RecordLike=Record<string,unknown>;
function object(value:unknown):RecordLike {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('RELEASE_PROVENANCE_INVALID_JSON_SHAPE');
  return value as RecordLike;
}
function get(value:unknown,...keys:string[]):unknown {
  let current=value;
  for(const key of keys){current=object(current)[key]}
  return current;
}
function fail(code:string):never{throw new Error('RELEASE_PROVENANCE_'+code)}
function fixedEqual(a:string,b:string):boolean {
  return a.length===b.length&&timingSafeEqual(Buffer.from(a,'utf8'),Buffer.from(b,'utf8'));
}
export interface ProvenancePins {
  archiveSha256:string;
  tag:string;
  sourceCommit:string;
}
export interface ProvenanceResult {
  status:'VERIFIED_RELEASE_PROVENANCE';
  artifactSha256:string;
  tag:string;
  sourceCommit:string;
  sourceRepository:typeof REPOSITORY;
  signerWorkflow:typeof WORKFLOW;
  cryptographicVerificationDelegatedTo:'gh attestation verify';
  protectedAclVerified:false;
  authorizedInstallerVerified:false;
  safeToElevate:false;
  productionModified:false;
}
function validatePins(input:ProvenancePins):void {
  if(!hex64.test(input.archiveSha256))fail('ARCHIVE_PIN_INVALID');
  if(!tagPattern.test(input.tag)||input.tag.includes('..'))fail('TAG_INVALID');
  if(!hex40.test(input.sourceCommit))fail('SOURCE_COMMIT_INVALID');
}
export function buildAttestationArgs(archivePath:string,pins:ProvenancePins):string[]{
  validatePins(pins);
  return [
    'attestation','verify',archivePath,
    '--repo',REPOSITORY,
    '--signer-workflow',REPOSITORY+'/'+WORKFLOW,
    '--signer-digest',pins.sourceCommit,
    '--source-ref','refs/tags/'+pins.tag,
    '--source-digest',pins.sourceCommit,
    '--cert-oidc-issuer',OIDC_ISSUER,
    '--deny-self-hosted-runners',
    '--predicate-type',PREDICATE,
    '--format','json',
  ];
}
/**
 * Policy on JSON returned by an independently successful GitHub CLI verifier.
 * This does NOT validate cryptographic signatures in isolation. Never accept
 * caller-provided JSON as proof of provenance for privileged execution.
 */
export function evaluateVerifiedReleaseProvenance(
  verified:unknown,pins:ProvenancePins,
):ProvenanceResult {
  validatePins(pins);
  if(!Array.isArray(verified)||verified.length<1||verified.length>16)fail('ATTESTATION_COUNT_INVALID');
  const expectedName='nexowire-'+pins.tag.slice(1)+'.tgz';
  const ref='refs/tags/'+pins.tag;
  const signer=REPO_URL+'/'+WORKFLOW+'@'+ref;
  for(const candidate of verified){
    try{
      const result=get(candidate,'verificationResult');
      if(get(result,'mediaType')!=='application/vnd.dev.sigstore.verificationresult+json;version=0.1'){
        fail('VERIFICATION_RESULT_VERSION');
      }
      const cert=get(result,'signature','certificate');
      const expectedFields:Record<string,string>={
        issuer:OIDC_ISSUER,
        subjectAlternativeName:signer,
        githubWorkflowRepository:REPOSITORY,
        githubWorkflowRef:ref,
        githubWorkflowSHA:pins.sourceCommit,
        sourceRepositoryURI:REPO_URL,
        sourceRepositoryDigest:pins.sourceCommit,
        sourceRepositoryRef:ref,
        buildSignerURI:signer,
        buildSignerDigest:pins.sourceCommit,
        runnerEnvironment:'github-hosted',
      };
      for(const [key,expected] of Object.entries(expectedFields)){
        if(get(cert,key)!==expected)fail('CERT_'+key.toUpperCase()+'_MISMATCH');
      }
      const timestamps=get(result,'verifiedTimestamps');
      if(!Array.isArray(timestamps)||timestamps.length<1)fail('VERIFIED_TIMESTAMP_MISSING');
      const statement=get(result,'statement');
      if(get(statement,'_type')!=='https://in-toto.io/Statement/v1')fail('STATEMENT_TYPE');
      if(get(statement,'predicateType')!==PREDICATE)fail('PREDICATE_TYPE');
      const subjects=get(statement,'subject');
      if(!Array.isArray(subjects)||subjects.length!==1)fail('SUBJECT_COUNT');
      if(get(subjects[0],'name')!==expectedName||
         !fixedEqual(String(get(subjects[0],'digest','sha256')),pins.archiveSha256)){
        fail('SUBJECT_MISMATCH');
      }
      const predicate=get(statement,'predicate');
      if(get(predicate,'buildDefinition','buildType')!=='https://actions.github.io/buildtypes/workflow/v1')fail('BUILD_TYPE');
      const workflow=get(predicate,'buildDefinition','externalParameters','workflow');
      if(get(workflow,'repository')!==REPO_URL||
         get(workflow,'ref')!==ref||get(workflow,'path')!==WORKFLOW)fail('WORKFLOW_PARAMETERS');
      if(get(predicate,'runDetails','builder','id')!==signer)fail('BUILDER_ID');
      const dependencies=get(predicate,'buildDefinition','resolvedDependencies');
      if(!Array.isArray(dependencies)||dependencies.length!==1||
         get(dependencies[0],'uri')!=='git+'+REPO_URL+'@'+ref||
         get(dependencies[0],'digest','gitCommit')!==pins.sourceCommit){
        fail('RESOLVED_SOURCE_MISMATCH');
      }
      return {
        status:'VERIFIED_RELEASE_PROVENANCE',artifactSha256:pins.archiveSha256,
        tag:pins.tag,sourceCommit:pins.sourceCommit,
        sourceRepository:REPOSITORY,signerWorkflow:WORKFLOW,
        cryptographicVerificationDelegatedTo:'gh attestation verify',
        protectedAclVerified:false,authorizedInstallerVerified:false,
        safeToElevate:false,productionModified:false,
      };
    }catch{
      // More than one attestation may exist for one digest. A malformed or
      // unrelated statement cannot satisfy the required SLSA record.
    }
  }
  fail('NO_MATCHING_PINNED_ATTESTATION');
}
export async function verifyPinnedReleaseProvenance(
  archivePath:string,pins:ProvenancePins,
):Promise<ProvenanceResult>{
  validatePins(pins);
  const name='nexowire-'+pins.tag.slice(1)+'.tgz';
  if(path.basename(archivePath)!==name)fail('ARCHIVE_NAME_MISMATCH');
  const stat=await fs.lstat(archivePath);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>MAX_ARCHIVE_BYTES){
    fail('ARCHIVE_PATH_OR_SIZE_INVALID');
  }
  const digest=createHash('sha256').update(await fs.readFile(archivePath)).digest('hex');
  if(!fixedEqual(digest,pins.archiveSha256))fail('ARCHIVE_DIGEST_MISMATCH');
  const run=spawnSync('gh',buildAttestationArgs(archivePath,pins),{
    encoding:'utf8',shell:false,windowsHide:true,timeout:90000,
    maxBuffer:MAX_VERIFICATION_BYTES,
  });
  // Never echo gh stderr; auth errors can contain endpoint details.
  if(run.error||run.status!==0||!run.stdout||run.stdout.length>=MAX_VERIFICATION_BYTES){
    fail('GH_ATTESTATION_VERIFICATION_FAILED');
  }
  let verification:unknown;
  try{verification=JSON.parse(run.stdout)}catch{fail('GH_JSON_INVALID')}
  const result=evaluateVerifiedReleaseProvenance(verification,pins);
  const digestAfter=createHash('sha256').update(await fs.readFile(archivePath)).digest('hex');
  if(!fixedEqual(digestAfter,pins.archiveSha256))fail('ARCHIVE_CHANGED_DURING_CHECK');
  return result;
}
async function main():Promise<void>{
  if(process.argv.length!==6){
    throw new Error('Usage: node --import tsx scripts/verify-pinned-release-provenance.ts <archive.tgz> <archive-sha256> <tag> <tag-commit-sha>');
  }
  const result=await verifyPinnedReleaseProvenance(process.argv[2]!,{
    archiveSha256:process.argv[3]!,tag:process.argv[4]!,sourceCommit:process.argv[5]!,
  });
  process.stdout.write(JSON.stringify(result)+'\n');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(error=>{
    process.stderr.write((error instanceof Error?error.message:'RELEASE_PROVENANCE_UNKNOWN')+'\n');
    process.exitCode=1;
  });
}
