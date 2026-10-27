/**
 * #11 SYSTEM QA ONLY: verify current PR/run/job metadata through GitHub REST.
 *
 * Read-only. This establishes authenticated source-CI evidence only. It never
 * establishes physical Windows trust, external CAS, enrollment or production CORE.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const API_ORIGIN='https://api.github.com';
export const CORE_CI_REPOSITORY='Naveax/Nexowire';
export const CORE_CI_WORKFLOW_ID=369213208;
export const REQUIRED_CORE_CI_JOBS=[
  'test (22)',
  'test (24)',
  'browser-live',
  'linux-native-live',
  'wsl2-live',
  'security-operational-live',
  'macos-agent-lifecycle-live',
] as const;

type JsonRecord=Record<string,unknown>;
const record=(value:unknown):value is JsonRecord=>
  typeof value==='object'&&value!==null&&!Array.isArray(value);
const positiveId=(value:unknown):value is number=>
  typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
const sha40=(value:unknown):value is string=>
  typeof value==='string'&&/^[0-9a-f]{40}$/.test(value);
const repoName=(value:unknown):value is string=>
  typeof value==='string'&&/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);

export interface GitHubCiAuditInput {
  readonly repositoryFullName:string;
  readonly pullRequestNumber:number;
  readonly runId:number;
  readonly token:string;
}
export interface CoreCiGitHubAudit {
  readonly schemaVersion:1;
  readonly repositoryFullName:string|null;
  readonly pullRequestNumber:number|null;
  readonly pullRequestState:string|null;
  readonly draft:boolean|null;
  readonly baseSha:string|null;
  readonly headSha:string|null;
  readonly runId:number|null;
  readonly runAttempt:number|null;
  readonly workflowId:number|null;
  readonly event:string|null;
  readonly snapshotConsistency:'CONSISTENT'|'BLOCKED';
  readonly findings:readonly string[];
  /** True only after successful native HTTPS requests, including GET /user. */
  readonly githubOriginAuthenticated:boolean;
  readonly physicalAcceptance:'NOT_PROVEN';
  readonly productionCore:'NO_GO';
  readonly requiredJobs:readonly string[];
  readonly jobs:readonly {
    readonly name:string|null;
    readonly status:string|null;
    readonly conclusion:string|null;
  }[];
}

function addOnce(findings:string[],finding:string):void{
  if(!findings.includes(finding))findings.push(finding);
}

/** Pure parser for API payloads. Caller-supplied payloads are never authenticated. */
export function auditGitHubCiPayload(input:unknown):CoreCiGitHubAudit{
  const findings:string[]=[];
  let repositoryFullName:string|null=null;
  let pullRequestNumber:number|null=null;
  let pullRequestState:string|null=null;
  let draft:boolean|null=null;
  let baseSha:string|null=null;
  let headSha:string|null=null;
  let runId:number|null=null;
  let runAttempt:number|null=null;
  let workflowId:number|null=null;
  let event:string|null=null;
  let jobSummaries:CoreCiGitHubAudit['jobs']=[];

  if(!record(input)){
    addOnce(findings,'PAYLOAD_INVALID');
  }else{
    const repo=input.repositoryFullName;
    const expectedPr=input.pullRequestNumber;
    const expectedRun=input.runId;
    const pr=input.pullRequest;
    const recheckedPr=input.recheckedPullRequest;
    const run=input.run;
    const jobsEnvelope=input.jobs;
    const dispatchAssociations=input.workflowDispatchPullRequests;

    if(repoName(repo)&&repo===CORE_CI_REPOSITORY)repositoryFullName=repo;
    else addOnce(findings,'REPOSITORY_INVALID');
    if(positiveId(expectedPr))pullRequestNumber=expectedPr;
    else addOnce(findings,'PR_NUMBER_INVALID');
    if(positiveId(expectedRun))runId=expectedRun;
    else addOnce(findings,'RUN_ID_INVALID');

    if(!record(pr)){
      addOnce(findings,'PR_METADATA_MISSING');
    }else{
      if(pr.number!==expectedPr)addOnce(findings,'PR_NUMBER_MISMATCH');
      pullRequestState=typeof pr.state==='string'?pr.state:null;
      draft=typeof pr.draft==='boolean'?pr.draft:null;
      if(pr.state!=='open')addOnce(findings,'PR_NOT_OPEN');
      if(!record(pr.head)||!sha40(pr.head.sha)){
        addOnce(findings,'PR_HEAD_INVALID');
      }else{
        headSha=pr.head.sha;
      }
      if(!record(pr.base)||!sha40(pr.base.sha)){
        addOnce(findings,'PR_BASE_INVALID');
      }else{
        baseSha=pr.base.sha;
      }
      if(typeof pr.head.ref!=='string'||pr.head.ref.length<1){
        addOnce(findings,'PR_HEAD_REF_INVALID');
      }
      if(!record(pr.head)||!record(pr.head.repo)||
         pr.head.repo.full_name!==CORE_CI_REPOSITORY){
        addOnce(findings,'PR_HEAD_REPOSITORY_MISMATCH');
      }
      if(!record(pr.base)||!record(pr.base.repo)||
         pr.base.repo.full_name!==CORE_CI_REPOSITORY){
        addOnce(findings,'PR_BASE_REPOSITORY_MISMATCH');
      }
    }

    if(!record(recheckedPr)){
      addOnce(findings,'PR_RECHECK_MISSING');
    }else if(!record(pr)||!record(pr.head)||!record(pr.base)||
      !record(recheckedPr.head)||!record(recheckedPr.base)||
      recheckedPr.number!==pr.number||
      recheckedPr.state!==pr.state||
      recheckedPr.draft!==pr.draft||
      recheckedPr.head.sha!==pr.head.sha||
      recheckedPr.base.sha!==pr.base.sha){
      addOnce(findings,'PR_CHANGED_DURING_AUDIT');
    }

    if(!record(run)){
      addOnce(findings,'RUN_METADATA_MISSING');
    }else{
      if(run.id!==expectedRun)addOnce(findings,'RUN_ID_MISMATCH');
      if(run.workflow_id!==CORE_CI_WORKFLOW_ID){
        addOnce(findings,'WORKFLOW_ID_MISMATCH');
      }else{
        workflowId=run.workflow_id as number;
      }
      if(!sha40(run.head_sha)||!sha40(headSha)||run.head_sha!==headSha){
        addOnce(findings,'EXACT_SHA_MISMATCH');
      }
      if(run.status!=='completed'||run.conclusion!=='success'){
        addOnce(findings,'RUN_NOT_SUCCESSFUL');
      }
      if(!positiveId(run.run_attempt)){
        addOnce(findings,'ATTEMPT_INVALID');
      }else{
        runAttempt=run.run_attempt;
      }
      event=typeof run.event==='string'?run.event:null;
      if(event!=='pull_request'&&event!=='workflow_dispatch'){
        addOnce(findings,'EVENT_INVALID');
      }
      if(!record(pr)||typeof pr.head.ref!=='string'||
         run.head_branch!==pr.head.ref){
        addOnce(findings,'RUN_BRANCH_MISMATCH');
      }
      if(!record(pr)||!record(pr.head)||!record(pr.head.repo)||
         !record(run.head_repository)||
         run.head_repository.full_name!==pr.head.repo.full_name){
        addOnce(findings,'RUN_HEAD_REPOSITORY_MISMATCH');
      }

      let associations:unknown[]=[];
      if(event==='pull_request'){
        associations=Array.isArray(run.pull_requests)?run.pull_requests:[];
      }else if(event==='workflow_dispatch'){
        associations=Array.isArray(dispatchAssociations)?
          dispatchAssociations:[];
      }
      const association=associations.find(item=>
        record(item)&&item.number===expectedPr);
      if(!record(association)){
        addOnce(findings,'RUN_PR_CONTEXT_MISSING');
      }else{
        if(!record(pr)||!record(pr.head)||!record(association.head)||
           association.head.sha!==pr.head.sha){
          addOnce(findings,'RUN_PR_HEAD_MISMATCH');
        }
        if(!record(pr)||!record(pr.base)||!record(association.base)||
           association.base.sha!==pr.base.sha){
          addOnce(findings,'RUN_PR_BASE_MISMATCH');
        }
      }
    }

    if(!record(jobsEnvelope)||!Array.isArray(jobsEnvelope.jobs)){
      addOnce(findings,'JOBS_METADATA_MISSING');
    }else{
      const items=jobsEnvelope.jobs;
      jobSummaries=items.map(job=>({
        name:record(job)&&typeof job.name==='string'?job.name:null,
        status:record(job)&&typeof job.status==='string'?job.status:null,
        conclusion:record(job)&&typeof job.conclusion==='string'?job.conclusion:null,
      }));
      if(!positiveId(jobsEnvelope.total_count)||
         jobsEnvelope.total_count!==items.length){
        addOnce(findings,'JOB_PAGE_INCOMPLETE');
      }
      if(items.length!==REQUIRED_CORE_CI_JOBS.length){
        addOnce(findings,'JOB_CARDINALITY_MISMATCH');
      }
      const found=new Set<string>();
      for(const job of items){
        if(!record(job)||typeof job.name!=='string'){
          addOnce(findings,'JOB_METADATA_INVALID');
          continue;
        }
        if(found.has(job.name))addOnce(findings,'DUPLICATE_JOB_NAME');
        found.add(job.name);
        if(!REQUIRED_CORE_CI_JOBS.includes(
          job.name as typeof REQUIRED_CORE_CI_JOBS[number],
        ))addOnce(findings,'UNEXPECTED_JOB');
        if(!positiveId(runId)||job.run_id!==runId){
          addOnce(findings,'JOB_RUN_ID_MISMATCH');
        }
        // The endpoint is scoped to this attempt; compare the field when GitHub returns it.
        if(record(run)&&job.run_attempt!==undefined&&
           job.run_attempt!==run.run_attempt){
          addOnce(findings,'JOB_ATTEMPT_MISMATCH');
        }
        if(job.status!=='completed'||job.conclusion!=='success'){
          addOnce(findings,'JOB_NOT_SUCCESSFUL');
        }
      }
      for(const required of REQUIRED_CORE_CI_JOBS){
        if(!found.has(required))addOnce(findings,'REQUIRED_JOB_MISSING');
      }
    }
  }
  return {
    schemaVersion:1,
    repositoryFullName,
    pullRequestNumber,
    pullRequestState,
    draft,
    baseSha,
    headSha,
    runId,
    runAttempt,
    workflowId,
    event,
    snapshotConsistency:findings.length===0?'CONSISTENT':'BLOCKED',
    findings,
    githubOriginAuthenticated:false,
    physicalAcceptance:'NOT_PROVEN',
    productionCore:'NO_GO',
    requiredJobs:REQUIRED_CORE_CI_JOBS,
    jobs:jobSummaries,
  };
}

interface GitHubJsonResult {
  readonly payload:unknown;
  readonly originAuthenticated:boolean;
}
async function fetchGitHubJson(
  url:string,
  token:string,
  fetcher:typeof fetch,
  verifyOrigin:boolean,
):Promise<GitHubJsonResult>{
  if(new URL(url).origin!==API_ORIGIN){
    throw new Error('GITHUB_API_ORIGIN_MISMATCH');
  }
  let response:Response;
  try{
    response=await fetcher(url,{
      method:'GET',
      headers:{
        accept:'application/vnd.github+json',
        authorization:'Bearer '+token,
        'x-github-api-version':'2022-11-28',
      },
      redirect:'error',
      cache:'no-store',
      signal:AbortSignal.timeout(15_000),
    });
  }catch{
    throw new Error('GITHUB_API_REQUEST_FAILED');
  }
  if(!response.ok)throw new Error('GITHUB_API_HTTP_'+response.status);
  if(response.redirected)throw new Error('GITHUB_API_REDIRECT_REJECTED');
  if(verifyOrigin){
    if(!response.url||response.url!==url||
       new URL(response.url).origin!==API_ORIGIN){
      throw new Error('GITHUB_API_ORIGIN_MISMATCH');
    }
  }
  const contentType=response.headers.get('content-type')??'';
  if(!contentType.toLowerCase().includes('json')){
    throw new Error('GITHUB_API_CONTENT_TYPE_INVALID');
  }
  try{
    return {
      payload:await response.json() as unknown,
      originAuthenticated:verifyOrigin,
    };
  }catch{
    throw new Error('GITHUB_API_JSON_INVALID');
  }
}

/**
 * Fetch current PR/run/job data from fixed api.github.com GET endpoints.
 * A synthetic test fetcher can never report authenticated source evidence.
 */
export async function auditCurrentGitHubCi(
  input:GitHubCiAuditInput,
  testFetcher?:typeof fetch,
):Promise<CoreCiGitHubAudit>{
  if(input.repositoryFullName!==CORE_CI_REPOSITORY||
     !positiveId(input.pullRequestNumber)||
     !positiveId(input.runId)){
    throw new Error('GITHUB_CI_INPUT_INVALID');
  }
  const token=input.token.trim();
  if(token.length<20||token.length>512||/[\r\n]/.test(token)){
    throw new Error('GITHUB_TOKEN_REQUIRED_OR_INVALID');
  }
  const [owner,repo]=input.repositoryFullName.split('/');
  const trustedNativeFetch=testFetcher===undefined;
  const fetcher=testFetcher??globalThis.fetch;
  const apiRepo=API_ORIGIN+'/repos/'+encodeURIComponent(owner!)+
    '/'+encodeURIComponent(repo!);
  const pullsUrl=apiRepo+'/pulls/'+input.pullRequestNumber;
  const runUrl=apiRepo+'/actions/runs/'+input.runId;
  const [viewerResult,prResult,runResult]=await Promise.all([
    fetchGitHubJson(API_ORIGIN+'/user',token,fetcher,trustedNativeFetch),
    fetchGitHubJson(pullsUrl,token,fetcher,trustedNativeFetch),
    fetchGitHubJson(runUrl,token,fetcher,trustedNativeFetch),
  ]);
  if(!record(viewerResult.payload)||
     typeof viewerResult.payload.login!=='string'||
     !positiveId(viewerResult.payload.id)){
    throw new Error('GITHUB_TOKEN_AUTHENTICATION_FAILED');
  }
  if(!record(runResult.payload)||!positiveId(runResult.payload.run_attempt)){
    throw new Error('GITHUB_RUN_ATTEMPT_INVALID');
  }
  const run=runResult.payload as JsonRecord;
  const attempt=run.run_attempt as number;
  const jobsUrl=runUrl+'/attempts/'+attempt+'/jobs?per_page=100';
  const dispatchAssociationsUrl=
    run.event==='workflow_dispatch'&&sha40(run.head_sha)?
      apiRepo+'/commits/'+encodeURIComponent(run.head_sha)+'/pulls?per_page=100':
      null;
  const requests=[
    fetchGitHubJson(jobsUrl,token,fetcher,trustedNativeFetch),
    fetchGitHubJson(pullsUrl,token,fetcher,trustedNativeFetch),
  ];
  if(dispatchAssociationsUrl){
    requests.push(fetchGitHubJson(
      dispatchAssociationsUrl,token,fetcher,trustedNativeFetch,
    ));
  }
  const results=await Promise.all(requests);
  const jobsResult=results[0]!;
  const recheckedPrResult=results[1]!;
  const dispatchResult=results[2];
  const report=auditGitHubCiPayload({
    repositoryFullName:input.repositoryFullName,
    pullRequestNumber:input.pullRequestNumber,
    runId:input.runId,
    pullRequest:prResult.payload,
    recheckedPullRequest:recheckedPrResult.payload,
    run,
    jobs:jobsResult.payload,
    workflowDispatchPullRequests:dispatchResult?.payload,
  });
  const originAuthenticated=trustedNativeFetch&&
    viewerResult.originAuthenticated&&prResult.originAuthenticated&&
    runResult.originAuthenticated&&jobsResult.originAuthenticated&&
    recheckedPrResult.originAuthenticated&&
    (!dispatchResult||dispatchResult.originAuthenticated);
  return {...report,githubOriginAuthenticated:originAuthenticated};
}

if(process.argv[1]&&
   resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2);
    if(args.length!==3){
      throw new Error('Expected repository, pull request number and run ID.');
    }
    const token=process.env.GH_TOKEN||process.env.GITHUB_TOKEN||'';
    const report=await auditCurrentGitHubCi({
      repositoryFullName:args[0]!,
      pullRequestNumber:Number(args[1]),
      runId:Number(args[2]),
      token,
    });
    process.stdout.write(JSON.stringify(report,null,2)+'\n');
    if(report.snapshotConsistency!=='CONSISTENT')process.exitCode=2;
  }catch{
    process.stderr.write(
      'Live GitHub CI audit failed closed; verify read-only token access and exact PR/run IDs.\n',
    );
    process.exitCode=2;
  }
}
