import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

const tool=fileURLToPath(new URL('../../scripts/coord-v108-merge-tree.mjs',import.meta.url));
const stack=[
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
] as const;

type Pr = {
  number:number;state:'open';draft:boolean;
  head:{ref:string;sha:string};base:{ref:string;sha:string};
};
type Snapshot={mainSha:string;prs:Pr[]};
const run=(cwd:string,args:string[])=>{
  const result=spawnSync('git',args,{
    cwd,encoding:'utf8',timeout:15000,
    env:{...process.env,GIT_TERMINAL_PROMPT:'0'},
  });
  assert.equal(result.status,0,'git '+args.join(' ')+': '+result.stderr);
  return result.stdout.trim();
};
function fixture(t:import('node:test').TestContext,conflict=false) {
  const root=mkdtempSync(path.join(os.tmpdir(),'nexowire-merge-fixture-'));
  const repo=path.join(root,'repo');
  mkdirSync(repo);
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  run(repo,['init','-q','-b','main']);
  run(repo,['config','user.name','Nexowire Fixture']);
  run(repo,['config','user.email','fixture@example.invalid']);
  writeFileSync(path.join(repo,'base.txt'),'BASE\n');
  writeFileSync(path.join(repo,'conflict.txt'),'ORIGINAL\n');
  run(repo,['add','.']);
  run(repo,['commit','-q','-m','root']);
  const mainSha=run(repo,['rev-parse','HEAD']);
  const refs=new Map<string,string>([['main',mainSha]]);
  const prs:Pr[]=[];
  for(const spec of stack){
    const parentId='parent' in spec?spec.parent:undefined;
    const baseRef=parentId!==undefined?
      stack.find(x=>x.number===parentId)!.head:
      ('base' in spec?spec.base:undefined);
    assert.equal(typeof baseRef,'string');
    const baseBranch=baseRef as string;
    if(!refs.has(baseBranch)){
      assert.equal(baseBranch,'docs/07-task-os-sandbox-provider-contract-20261024');
      run(repo,['switch','--detach','-q',mainSha]);
      run(repo,['switch','-q','-c',baseBranch]);
      writeFileSync(path.join(repo,'sandbox-contract.txt'),'SANDBOX_BASE\n');
      run(repo,['add','.']);
      run(repo,['commit','-q','-m','sandbox-parent']);
      refs.set(baseBranch,run(repo,['rev-parse','HEAD']));
    }
    const baseSha=refs.get(baseBranch)!;
    run(repo,['switch','--detach','-q',baseSha]);
    run(repo,['switch','-q','-c',spec.head]);
    writeFileSync(path.join(repo,'pr-'+spec.number+'.txt'),'PR '+spec.number+'\n');
    if(conflict&&(spec.number===986||spec.number===980)){
      writeFileSync(path.join(repo,'conflict.txt'),'MODIFIED BY PR '+spec.number+'\n');
    }
    run(repo,['add','.']);
    run(repo,['commit','-q','-m','PR '+spec.number]);
    const sha=run(repo,['rev-parse','HEAD']);
    refs.set(spec.head,sha);
    prs.push({number:spec.number,state:'open',draft:true,
      head:{ref:spec.head,sha},base:{ref:baseBranch,sha:baseSha}});
  }
  run(repo,['switch','-q','main']);
  const snapshot:Snapshot={mainSha,prs};
  const snapshotPath=path.join(root,'snapshot.json');
  function execute(){
    writeFileSync(snapshotPath,JSON.stringify(snapshot));
    const result=spawnSync(process.execPath,[tool,
      '--repo',repo,'--snapshot',snapshotPath],{
      encoding:'utf8',timeout:30000,env:{...process.env,GITHUB_TOKEN:''},
    });
    const output=JSON.parse(result.stdout||'{}') as {
      status?:string;findings?:string[];nodes?:unknown[];
      mergeAuthorized?:boolean;deployAuthorized?:boolean;productionCore?:string;
      sourceWorkingTreeModified?:boolean;
    };
    return {result,output};
  }
  return {repo,snapshot,execute};
}

test('clean source DAG gets dry-run only and does not change main/workingtree',t=>{
  const f=fixture(t);
  const before=run(f.repo,['rev-parse','HEAD']);
  const working=run(f.repo,['status','--porcelain']);
  const {result,output}=f.execute();
  assert.equal(result.status,0,result.stderr);
  assert.equal(output.status,'CLEAN_DRY_RUN');
  assert.equal(output.nodes?.length,stack.length);
  assert.equal(output.mergeAuthorized,false);
  assert.equal(output.deployAuthorized,false);
  assert.equal(output.sourceWorkingTreeModified,false);
  assert.equal(output.productionCore,'NO_GO');
  assert.equal(run(f.repo,['rev-parse','HEAD']),before);
  assert.equal(run(f.repo,['status','--porcelain']),working);
});

test('distinct AI PRs changing the same line result in a blocked merge',t=>{
  const f=fixture(t,true);
  const {result,output}=f.execute();
  assert.equal(result.status,2,result.stderr);
  assert.equal(output.status,'BLOCKED');
  assert.ok(output.findings?.some(x=>x.includes('PR_980_MERGE_TREE_NONZERO')));
  const collision=output.nodes?.find((n:any)=>n.pr===980);
  assert.ok(collision?.conflictFiles?.includes('conflict.txt'),
    'Git merge-tree should report the actual conflicting file');
  assert.equal(output.mergeAuthorized,false);
});

test('base SHA drift is rejected before attempting any merge',t=>{
  const f=fixture(t);
  f.snapshot.prs.find(p=>p.number===993)!.base.sha='a'.repeat(40);
  const {result,output}=f.execute();
  assert.equal(result.status,2,result.stderr);
  assert.equal(output.status,'BLOCKED');
  assert.ok(output.findings?.some(x=>x.includes('PR_993_BASE_HEAD_SHA_MISMATCH')));
  assert.equal(output.nodes?.length,0);
});

test('absent exact commit object cannot be treated as mergeable',t=>{
  const f=fixture(t);
  f.snapshot.prs.find(p=>p.number===990)!.head.sha='b'.repeat(40);
  const {result,output}=f.execute();
  assert.equal(result.status,2,result.stderr);
  assert.equal(output.status,'BLOCKED');
  assert.ok(output.findings?.some(x=>x.includes('COMMIT_OBJECT_MISSING_')));
  assert.equal(output.nodes?.length,0);
});

test('a declared PR head must really descend from its exact base Git commit',t=>{
  const f=fixture(t);
  const otherHead=f.snapshot.prs.find(p=>p.number===986)!.head.sha;
  f.snapshot.prs.find(p=>p.number===993)!.head.sha=otherHead;
  const {result,output}=f.execute();
  assert.equal(result.status,2,result.stderr);
  assert.equal(output.status,'BLOCKED');
  assert.ok(output.findings?.some(x=>x.includes('PR_993_BASE_NOT_ANCESTOR')));
  assert.equal(output.mergeAuthorized,false);
});
