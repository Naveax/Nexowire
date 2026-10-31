/**
 * Read-only Nexowire v1.0.8 integration simulation.
 *
 * Simulates merges in a disposable local clone using git merge-tree/commit-tree.
 * Never updates a remote ref, checkout, PR, source working tree, CI or device.
 * Caller-supplied PR snapshots are NOT GitHub-authenticated evidence.
 */
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const DEFAULT_STACK=Object.freeze([
  {number:986,head:'ai/01-wal-v108',base:'main'},
  {number:980,head:'integration/core-after-v108-20261030',base:'main'},
  {number:981,head:'core/bounded-native-verifier-host-20261030',parent:980},
  {number:982,head:'core/native-verifier-mtls-client-20261031',parent:981},
  {number:988,head:'ai/03-native-verifier-20261031',parent:982},
  {number:983,head:'local/persistent-enrollment-design-20261031',parent:982},
  {number:984,head:'local/persistent-enrollment-v2-20261031',parent:983},
  {number:993,head:'ai/02-enrollment-hardening-20261031',parent:984},
  {number:989,head:'ai/08-independent-qa-20261031',parent:984},
  {number:987,head:'ai/04-broker-admission-20261031',parent:980},
  {number:992,head:'ai/05-cas-executor',parent:980},
  {number:985,head:'ai/06-console-claim',parent:980},
  {number:996,head:'coord/core-claim-verified-ledger-20261031',parent:980},
  {number:990,head:'ai/07-isolation-worker-20261031',
    base:'docs/07-task-os-sandbox-provider-contract-20261024'},
]);

const sha40=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const item=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const blocked=code=>{throw new Error(code);};

export function validateSnapshot(snapshot,specs=DEFAULT_STACK) {
  if(!item(snapshot)||!sha40(snapshot.mainSha)||!Array.isArray(snapshot.prs)){
    blocked('INVALID_SNAPSHOT');
  }
  if(!Array.isArray(specs)||specs.length===0)blocked('INVALID_STACK');
  const prs=new Map();
  for(const pr of snapshot.prs){
    if(!Number.isSafeInteger(pr?.number)||prs.has(pr.number)){
      blocked('DUPLICATE_OR_INVALID_PR_NUMBER');
    }
    prs.set(pr.number,pr);
  }
  const defined=new Set(),plan=[];
  for(const spec of specs){
    if(!Number.isSafeInteger(spec?.number)||defined.has(spec.number)){
      blocked('INVALID_STACK_MEMBER');
    }
    if(typeof spec.head!=='string'||(spec.parent===undefined)===(spec.base===undefined)){
      blocked('INVALID_STACK_EDGE');
    }
    if(spec.parent!==undefined&&!defined.has(spec.parent)){
      blocked('STACK_PARENT_NOT_ORDERED');
    }
    defined.add(spec.number);
    const pr=prs.get(spec.number);
    if(!item(pr)||pr.state!=='open'||pr.draft!==true||
      !item(pr.head)||!item(pr.base)||
      !sha40(pr.head.sha)||!sha40(pr.base.sha)){
      blocked('PR_'+spec.number+'_MISSING_CLOSED_OR_INVALID');
    }
    if(pr.head.ref!==spec.head)blocked('PR_'+spec.number+'_HEAD_BRANCH_DRIFT');
    if(spec.parent!==undefined){
      const parent=prs.get(spec.parent);
      if(!parent||pr.base.ref!==parent.head.ref||
        pr.base.sha!==parent.head.sha){
        blocked('PR_'+spec.number+'_BASE_HEAD_SHA_MISMATCH');
      }
    }else{
      if(pr.base.ref!==spec.base)blocked('PR_'+spec.number+'_BASE_REF_MISMATCH');
      if(spec.base==='main'&&pr.base.sha!==snapshot.mainSha){
        blocked('PR_'+spec.number+'_MAIN_SHA_MISMATCH');
      }
    }
    plan.push({number:spec.number,headSha:pr.head.sha,baseSha:pr.base.sha});
  }
  return {mainSha:snapshot.mainSha,plan};
}

function callGit(args,{cwd,env,timeout=20000}={}) {
  const result=spawnSync('git',[...(cwd?['-C',cwd]:[]),...args],{
    encoding:'utf8',timeout,maxBuffer:4*1024*1024,
    env:{...process.env,...env},
  });
  return {code:result.status??2,
    stdout:(result.stdout??'').trim(),
    stderr:(result.stderr??'').trim(),
    error:result.error?.message??null};
}

function provenance(status,findings,nodes) {
  return {
    schemaVersion:1,status,findings,nodes,
    source:'UNTRUSTED_OFFLINE_GIT_OBJECTS',
    productionCore:'NO_GO',
    physicalAcceptance:'NOT_PROVEN',
    mergeAuthorized:false,deployAuthorized:false,
    gitRemoteModified:false,sourceWorkingTreeModified:false,
  };
}

export function simulateMerges({repository,snapshot,specs=DEFAULT_STACK}) {
  let checked;
  try{checked=validateSnapshot(snapshot,specs);}
  catch(error){return provenance('BLOCKED',[String(error.message??error)],[]);}
  if(typeof repository!=='string'||!path.isAbsolute(repository)){
    return provenance('BLOCKED',['ABSOLUTE_LOCAL_REPOSITORY_REQUIRED'],[]);
  }
  // Only the disposable clone can receive virtual commits/merge objects.
  const parent=mkdtempSync(path.join(os.tmpdir(),'nexowire-v108-merge-'));
  const isolated=path.join(parent,'isolated');
  const nodes=[],findings=[];
  try{
    const copied=callGit(['clone','--local','--shared','--quiet','--no-checkout',
      '--',repository,isolated],{timeout:120000});
    if(copied.code!==0){
      return provenance('BLOCKED',['ISOLATED_CLONE_UNAVAILABLE'],nodes);
    }
    const hashes=[checked.mainSha,...checked.plan.flatMap(s=>[s.headSha,s.baseSha])];
    for(const sha of new Set(hashes)){
      const found=callGit(['cat-file','-e',sha+'^{commit}'],{cwd:isolated});
      if(found.code!==0){
        return provenance('BLOCKED',['COMMIT_OBJECT_MISSING_'+sha.slice(0,12)],nodes);
      }
    }
    // PR metadata alone cannot prove that head SHA descends from the stated
    // exact base SHA. Validate real Git object ancestry before simulating.
    for(const step of checked.plan){
      const ancestor=callGit(['merge-base','--is-ancestor',
        step.baseSha,step.headSha],{cwd:isolated});
      if(ancestor.code!==0){
        return provenance('BLOCKED',[
          'PR_'+step.number+'_BASE_NOT_ANCESTOR_OR_GIT_ERROR',
        ],nodes);
      }
    }
    let simulatedTip=checked.mainSha;
    const identity={
      GIT_AUTHOR_NAME:'Nexowire dry-run',
      GIT_COMMITTER_NAME:'Nexowire dry-run',
      GIT_AUTHOR_EMAIL:'dry-run@localhost.invalid',
      GIT_COMMITTER_EMAIL:'dry-run@localhost.invalid',
      GIT_AUTHOR_DATE:'2026-10-31T00:00:00+0000',
      GIT_COMMITTER_DATE:'2026-10-31T00:00:00+0000',
    };
    for(const step of checked.plan){
      // Input PR already reachable in the previous virtual history: no-op.
      const present=callGit(['merge-base','--is-ancestor',
        step.headSha,simulatedTip],{cwd:isolated});
      if(present.code===0){
        nodes.push({pr:step.number,result:'ALREADY_ANCESTOR'});
        continue;
      }
      if(present.code!==1){
        findings.push('GIT_ANCESTRY_UNCERTAIN_PR_'+step.number);
        return provenance('BLOCKED',findings,nodes);
      }
      const merger=callGit(['merge-tree','--write-tree',
        simulatedTip,step.headSha],{cwd:isolated,timeout:60000});
      if(merger.code!==0){
        // Git merge-tree prints conflict paths in deterministic CONFLICT lines.
        // Log only public repository paths, never raw conflict hunks/contents.
        const conflictFiles=merger.stdout.split(/\r?\n/)
          .filter(line=>line.startsWith('CONFLICT'))
          .map(line=>line.includes(' in ')?
            line.slice(line.lastIndexOf(' in ')+4).trim().slice(0,512):'UNKNOWN')
          .slice(0,15);
        nodes.push({pr:step.number,result:'CONFLICT_OR_MERGE_ERROR',
          conflictFiles});
        findings.push('PR_'+step.number+'_MERGE_TREE_NONZERO_'+merger.code);
        return provenance('BLOCKED',findings,nodes);
      }
      const tree=merger.stdout.split(/\s+/)[0];
      if(!sha40(tree)){
        findings.push('PR_'+step.number+'_INVALID_MERGED_TREE');
        return provenance('BLOCKED',findings,nodes);
      }
      const commit=callGit(['commit-tree',tree,
        '-p',simulatedTip,'-p',step.headSha,
        '-m','UNTRUSTED_OFFLINE_V108_DRY_RUN_PR_'+step.number],
        {cwd:isolated,env:identity});
      if(commit.code!==0||!sha40(commit.stdout)){
        findings.push('PR_'+step.number+'_VIRTUAL_COMMIT_FAILED');
        return provenance('BLOCKED',findings,nodes);
      }
      simulatedTip=commit.stdout;
      nodes.push({pr:step.number,result:'MERGE_TREE_CLEAN'});
    }
    return provenance('CLEAN_DRY_RUN',[],nodes);
  }catch(error){
    return provenance('BLOCKED',['SIMULATION_ERROR_'+
      (error instanceof Error?error.name:'UNKNOWN')],nodes);
  }finally{
    rmSync(parent,{recursive:true,force:true});
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2);
    if(args.length!==4||args[0]!=='--repo'||args[2]!=='--snapshot'){
      blocked('Usage: node scripts/coord-v108-merge-tree.mjs --repo /absolute/local/clone --snapshot /path/snapshot.json');
    }
    const payload=readFileSync(args[3],'utf8');
    if(payload.length>1024*1024)blocked('SNAPSHOT_OVER_1MIB');
    const report=simulateMerges({repository:args[1],snapshot:JSON.parse(payload)});
    process.stdout.write(JSON.stringify(report,null,2)+'\n');
    if(report.status!=='CLEAN_DRY_RUN')process.exitCode=2;
  }catch(error){
    process.stderr.write('V108_MERGE_DRY_RUN_BLOCKED: '+
      (error instanceof Error?error.message:'unknown')+'\n');
    process.exitCode=2;
  }
}