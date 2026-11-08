import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

const evidence=JSON.parse(readFileSync('docs/connection-v2/staging-evidence.json','utf8'));
const expected=process.env.NEXOWIRE_EXPECTED_HEAD;
const failures=[];
function git(args,extra={}){
  const r=spawnSync('git',args,{encoding:'utf8',maxBuffer:16*1024*1024,...extra});
  if(r.error)throw r.error;
  return {status:r.status,stdout:r.stdout??'',stderr:r.stderr??''};
}
function checked(args){
  const r=git(args);
  if(r.status!==0){failures.push('git '+args[0]+' exit '+r.status);return '';}
  return r.stdout.trim();
}
const head=checked(['rev-parse','HEAD']);
if(!expected||head!==expected)failures.push('checked out HEAD differs from exact PR head SHA');
const heads=evidence.source_heads;
const ancestry={};
for(const [pr,sha] of Object.entries(heads)){
  const check=git(['merge-base','--is-ancestor',sha,head]);
  ancestry[pr]={sha,exit_code:check.status,ancestor:check.status===0};
  if(check.status!==0)failures.push('missing source ancestor #'+pr);
}
const main=evidence.main_parent;
const mainAncestor=git(['merge-base','--is-ancestor',main,head]);
if(mainAncestor.status!==0)failures.push('main parent not reachable');
const sibling=checked(['merge-base',heads['1074'],heads['1077']]);
const expectedSibling='4d8f215f36de7fe05e85a9c19fc40cc35716d705';
if(sibling!==expectedSibling)failures.push('1074/1077 sibling merge-base differs');
const cherry=git(['cherry','-v',main,head]);
if(cherry.status!==0)failures.push('git cherry failed');
const cherryLines=cherry.stdout.trim()?cherry.stdout.trim().split('\n'):[];
const source=heads['1083'];
const parent=checked(['rev-parse',source+'^']);
const diff=git(['diff','--no-ext-diff','--binary',parent,source]);
if(diff.status!==0||!diff.stdout.trim())failures.push('source diff for stable patch id unavailable');
const patch=git(['patch-id','--stable'],{input:diff.stdout});
if(patch.status!==0||!patch.stdout.trim())failures.push('git patch-id --stable failed');
const merge=git(['merge-tree','--write-tree','--messages',heads['1074'],heads['1077']]);
if(merge.status!==0)failures.push('sibling merge-tree unresolved conflict or command error');
const clean10Base=evidence.integration_clean10_parent;
if(!clean10Base)failures.push('CLEAN-10 pre-integration base not recorded');
const clean10Merge=clean10Base
  ? git(['merge-tree','--write-tree','--messages',clean10Base,heads['1075']])
  : {status:1,stdout:'',stderr:'missing base'};
if(clean10Merge.status!==0)failures.push('CLEAN-10 source merge-tree conflict or missing full DAG');
const rows=readFileSync('docs/connection-v2/source-preservation-matrix.csv','utf8').trim().split(/\r?\n/).slice(1)
  .map(line=>[...line.matchAll(/"((?:[^"]|"")*)"/g)].map(x=>x[1].replace(/""/g,'"')));
if(rows.length!==79)failures.push('matrix row count differs from 79');
let sourceBlobPass=0,candidateBlobPass=0;
for(const r of rows){
  if(r.length!==7){failures.push('invalid CSV row');continue;}
  const sourceBlob=checked(['rev-parse',r[1]+':'+r[2]]);
  const candidateBlob=checked(['rev-parse',head+':'+r[2]]);
  if(sourceBlob===r[3])sourceBlobPass++;else failures.push('source blob mismatch '+r[0]+' '+r[2]);
  if(candidateBlob===r[4])candidateBlobPass++;else failures.push('candidate blob mismatch '+r[0]+' '+r[2]);
}
const report={
  schema:'nexowire.connection-v2.native-git-dag.v1',exact_sha:head,expected_sha:expected,
  main_sha:main,source_ancestry:ancestry,main_ancestor:mainAncestor.status===0,
  git_merge_base_siblings:{actual:sibling,expected:expectedSibling},
  git_cherry:{exit_code:cherry.status,entries:cherryLines.length,positive:cherryLines.filter(x=>x.startsWith('+')).length},
  git_patch_id_stable:{exit_code:patch.status,result:patch.stdout.trim().slice(0,120)},
  git_merge_tree:{exit_code:merge.status,stdout_excerpt:merge.stdout.slice(0,2000),stderr_excerpt:merge.stderr.slice(0,1000),clean10_merge_exit:clean10Merge.status,clean10_excerpt:clean10Merge.stdout.slice(0,1000)},
  matrix:{rows:rows.length,source_blob_pass:sourceBlobPass,candidate_blob_pass:candidateBlobPass},
  failures,decision:failures.length===0?'DAG_AND_BLOBS_PASS_RELEASE_NOT_AUTHORIZED':'NO_GO'
};
const target=join(process.env.RUNNER_TEMP||tmpdir(),'connection-v2-native-git-dag.json');
writeFileSync(target,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({exact_sha:head,merge_tree_exit:merge.status,cherry_count:cherryLines.length,
  patch_id_exit:patch.status,source_blobs:sourceBlobPass,candidate_blobs:candidateBlobPass,
  issues:failures}));
if(failures.length)process.exitCode=1;
