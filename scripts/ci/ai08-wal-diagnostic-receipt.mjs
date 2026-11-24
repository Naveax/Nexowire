import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {assertTapSummary} from './assert-tap-summary.mjs';
import {assertWindowsDiagnosticTap} from './ai08-wal-diagnostic-tap.mjs';
const DIAGNOSTIC='test/native-agent-startup-diagnostic.test.ts';
import {readTestInventory} from './test-inventory.mjs';
const tests={
 'test/agent/ai04-wal-snapshot-race.test.ts':['227dc73023421e702bc4ae653e07d89de3c4f487',12],
 'test/agent/ai04-external-journal-owner.test.ts':['9d2daca025c666ab7be8b250481519f0bd1bffae',3],
 'test/agent/ai04-frameless-wal.test.ts':['235150296f55d11c4dfff3155b3783f667f41195',14],
 [DIAGNOSTIC]:['4a9095dad4232313df8504071a1de1f557668a8c',10]
};
const dependencies={
 'src/agent/operation-journal.ts':'598882cf2a47c764a4e4d8b111228f60460fad1f',
 'src/agent/operation-journal-wal.ts':'1847ca93aaa0cca8b00b1fa3dc32e4af697d317c',
 'src/agent/journal-owner-process.ts':'cabe4f51203c7c93b94640f5c3e0b19f516b7e5a',
 'src/agent/operation-journal-authority.ts':'b98e8a6f12ce740bfe7ddea3d6aa2561edde2575',
 'src/agent/native-agent-startup-diagnostic.ts':'7c5e4c3fda397617d412da67ede50896a7ebebb9'
};
const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim();
const hash=b=>createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
const dir='ai08-wal-receipts';
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||
 process.versions.node.split('.')[0]!==process.env.NX_EXPECTED_NODE||!/^\d+$/.test(process.env.NX_JOB_ID??'')||
 !/^\d+$/.test(process.env.GITHUB_RUN_ID??''))throw Error('HOSTED_EXACT_WINDOWS_REQUIRED');
const {report,entries}=readTestInventory(process.cwd());
if(report.commitSha!==process.env.NEXOWIRE_EXPECTED_COMMIT_SHA||git('rev-parse','HEAD')!==report.commitSha)throw Error('HEAD_MISMATCH');
const pins={...dependencies,...Object.fromEntries(Object.entries(tests).map(([f,[b]])=>[f,b]))};
const check=()=>{for(const [f,b] of Object.entries(pins)){
 const st=lstatSync(f);
 if(!st.isFile()||st.isSymbolicLink()||git('rev-parse','HEAD:'+f)!==b||hash(readFileSync(f))!==b)throw Error('PIN_MISMATCH:'+f);
}};
check();
for(const [f,[b]] of Object.entries(tests))if(!entries.some(e=>e.path===f&&e.blob===b))throw Error('INVENTORY_MISMATCH:'+f);
mkdirSync(dir,{recursive:true});
const receipt={schemaVersion:1,sourceCommitSha:report.commitSha,sourceManifestSha256:report.manifestSha256,platform:process.platform,nodeVersion:process.version,workflowRunId:process.env.GITHUB_RUN_ID,jobId:process.env.NX_JOB_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,scope:'HOSTED_WAL_AND_STARTUP_DIAGNOSTIC_ONLY',pins,files:Object.entries(tests).map(([file,[blob,expected]])=>({file,blob,expected,status:'NOT_RUN'}))};
const save=()=>writeFileSync(path.join(dir,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
save();
for(const r of receipt.files){
 check();
 const child=spawnSync(process.execPath,['--test','--test-reporter=tap','--test-concurrency=1','--import','tsx',r.file],{encoding:'utf8',timeout:480000,maxBuffer:8*1024*1024,windowsHide:true});
 const tap=child.stdout??'';
 writeFileSync(path.join(dir,path.basename(r.file)+'.tap'),tap);
 process.stdout.write(tap);if(child.stderr)process.stderr.write(child.stderr);
 r.tapSha256=createHash('sha256').update(tap).digest('hex');
 r.exitCode=child.status;r.signal=child.signal;
 try{
  if(child.error||child.signal||child.status!==0)throw Error('CHILD_FAILED');
  if(r.file===DIAGNOSTIC){
   Object.assign(r,assertWindowsDiagnosticTap(tap));
   r.status='PASS_WITH_EXPECTED_SKIP';
  }else{
   r.counts=assertTapSummary(tap,r.expected);
   if(r.counts.tests!==r.expected)throw Error('EXACT_TEST_COUNT_MISMATCH');
   r.status='PASS';
  }
 }catch(e){r.status='FAIL';r.failure=e.message;}
 save();
}
receipt.totalPass=receipt.files.reduce((n,f)=>n+(f.counts?.pass??0),0);
receipt.totalSkipped=receipt.files.reduce((n,f)=>n+(f.counts?.skipped??0),0);
console.log(JSON.stringify(receipt));
if(receipt.totalPass!==38||receipt.totalSkipped!==1||receipt.files.some(f=>f.status!==(f.file===DIAGNOSTIC?'PASS_WITH_EXPECTED_SKIP':'PASS')))process.exitCode=1;
