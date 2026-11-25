import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {assertTapSummary} from './assert-tap-summary.mjs';
import {readTestInventory} from './test-inventory.mjs';
const tests={
 'test/agent/ai04-wal-snapshot-race.test.ts':['227dc73023421e702bc4ae653e07d89de3c4f487',12],
 'test/agent/ai04-external-journal-owner.test.ts':['9d2daca025c666ab7be8b250481519f0bd1bffae',3],
 'test/agent/ai04-frameless-wal.test.ts':['235150296f55d11c4dfff3155b3783f667f41195',14],
 'test/native-agent-startup-diagnostic.test.ts':['4a9095dad4232313df8504071a1de1f557668a8c',10],
 'test/agent/ai04-wal-index-convergence.test.ts':['24bc621403a26d97683a5ef322f35b035a889292',7]
};
const dependencies={
 'src/agent/operation-journal.ts':'598882cf2a47c764a4e4d8b111228f60460fad1f',
 'src/agent/operation-journal-wal.ts':'d5c84054b6b40a3d4b6774bfc80e0f58721b88b2',
 'src/agent/journal-owner-process.ts':'cabe4f51203c7c93b94640f5c3e0b19f516b7e5a',
 'src/agent/operation-journal-authority.ts':'b98e8a6f12ce740bfe7ddea3d6aa2561edde2575',
 'src/agent/native-agent-startup-diagnostic.ts':'7c5e4c3fda397617d412da67ede50896a7ebebb9',
 'src/security/windows-dpapi.ts':'d54fc512eeecf4fe53bea2f726f0cb77b39a9f1c',
 'src/version.ts':'06178e7a933de31b9e820e18a8c5f5efeb889ca2',
 'scripts/ci/assert-tap-summary.mjs':'38786c04295e41d9cdb7d511821a8d1064026fc1',
 'scripts/ci/test-inventory.mjs':'1e9ea6fa7697094c082c0a864fad7afa751b99f6'
};
// Separate exact policy for the one pre-existing platform-specific skip.
// The three nested suites still use the original zero-SKIP helper unchanged.
const diagnosticFile='test/native-agent-startup-diagnostic.test.ts';
const namedSkip='a symlink diagnostic is ignored rather than followed';
const names=[
 'persistent startup failure records a bounded redacted restart-loop diagnosis and preserves the original error',
 'successful local initialization clears the failure streak without claiming a live connection or CORE',
 'diagnostic I/O failure cannot mask journal rejection or turn it into successful startup',
 'malformed, oversized and forged authority diagnostic files are not accepted as state',
 'custom journal configuration keeps the diagnostic beside that profile and never edits journal bytes',
 namedSkip,
 'startup diagnostics bind the process and a cutover nonce without treating the nonce as authority',
 'persistent WAL snapshot instability preserves exact startup failure and journal history',
 'startup diagnostic distinguishes UNSTABLE, CORRUPT, IN_USE and unrecognized failures without leaking messages',
 'UNSTABLE diagnostic cannot claim readiness or authority and diagnostic I/O cannot mask the original error',
];
function assertDiagnosticTap(tap){
 const expected={tests:10,pass:9,fail:0,cancelled:0,skipped:1,todo:0};
 const counts={};
 const results=[];
 let plans=0;
 for(const line of tap.split(/\r?\n/)){
  const m=/^# (tests|pass|fail|cancelled|skipped|todo) (0|[1-9][0-9]*)$/.exec(line);
  if(m){if(Object.hasOwn(counts,m[1]))throw Error('DUPLICATE_DIAGNOSTIC_COUNTER');counts[m[1]]=Number(m[2]);}
  if(/^1\.\.\d+/.test(line)){if(line!=='1..10')throw Error('DIAGNOSTIC_PLAN');plans++;}
  if(/^(?:ok|not ok) /.test(line))results.push(line);
 }
 assert.deepEqual(counts,expected);
 assert.equal(plans,1);
 assert.deepEqual(results,names.map((name,i)=>'ok '+(i+1)+' - '+name+(name===namedSkip?' # SKIP':'')));
 return counts;
}
// Fail the lane if this receipt validator ever accepts a different skip,
// incomplete result, failed result, duplicate counter, or altered inventory.
function verifyPolicy(){
 const ok=names.map((n,i)=>'ok '+(i+1)+' - '+n+(n===namedSkip?' # SKIP':'')).join('\n')+
  '\n1..10\n# tests 10\n# pass 9\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n';
 assert.equal(assertDiagnosticTap(ok).pass,9);
 const bad=[
  ok.replace('ok 6 - '+namedSkip+' # SKIP','ok 6 - '+namedSkip).replace('ok 8 - '+names[7],'ok 8 - '+names[7]+' # SKIP'),
  ok.replace('ok 8 - ','not ok 8 - '),ok.replace('# pass 9','# pass 10'),
  ok.replace('# skipped 1','# skipped 0'),ok.replace('1..10','1..9'),
  ok+'\n# tests 10\n',ok.replace('ok 9 - '+names[8]+'\n',''),
 ];
 for(const tap of bad)assert.throws(()=>assertDiagnosticTap(tap));
 console.log('DIAGNOSTIC_RECEIPT_POLICY: 1 positive / 7 negative cases PASS');
}
verifyPolicy();

const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim();
const hash=b=>createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
const dir='ai04-combined-wal-receipts';
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
  r.counts=r.file===diagnosticFile?assertDiagnosticTap(tap):assertTapSummary(tap,r.expected);
  if(r.file===diagnosticFile)r.namedPlatformSkip=namedSkip;
  if(r.counts.tests!==r.expected)throw Error('EXACT_TEST_COUNT_MISMATCH');
  r.status='PASS';
 }catch(e){r.status='FAIL';r.failure=e.message;}
 save();
}
check();
console.log(JSON.stringify(receipt));
if(receipt.files.some(f=>f.status!=='PASS'))process.exitCode=1;
