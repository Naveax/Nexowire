import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {assertTapSummary} from './assert-tap-summary.mjs';
import {readTestInventory} from './test-inventory.mjs';
const file='test/ai08/credential-atomicity-live.test.ts';
const pins={
 [file]:'a4d64489c5589500ad7f60a0421472bf13520fac',
 'src/agent/postgres-broker-dispatch-authority.ts':'2379c6f9d293ec8bb701b6c94ed941c186caf2c8',
 'src/agent/protected-broker-dispatch-service.ts':'a316ac46e2a34191d6c49f230daf733660efc87a',
 'src/agent/broker-dispatch-authority-handler.ts':'4a8733f9b53f75af58ca0cbd18686d33b64ff579',
 'src/agent/broker-external-dispatch-fence.ts':'95f96ce8160c84d743557f38c638261c08bfc363',
 'src/agent/postgres-dispatch-credential-store.ts':'acd931e125e01c8ccc601acde2a5cf7d8956049b',
 'sql/core-broker-dispatch-authority.sql':'a120585a92d7ab41bb2d1a3aaf5c0bc31f9ca74b',
 'sql/core-broker-dispatch-credentials.sql':'4cd511f8246025c7293202070527c66710b80a62',
 'sql/core-broker-dispatch-credential-fence.sql':'6c847b5386312a2550318f68792822feb5a93192'
};
const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim();
const hash=b=>createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
if(process.platform!=='linux'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||process.env.NEXOWIRE_PG_DISPATCH_INTEGRATION!=='1'||
 process.env.NEXOWIRE_PG_DISPATCH_TEST_PORT!=='5432'||process.versions.node.split('.')[0]!==process.env.NX_EXPECTED_NODE||!/^\d+$/.test(process.env.NX_JOB_ID??'')||!/^\d+$/.test(process.env.GITHUB_RUN_ID??''))throw Error('HOSTED_DISPOSABLE_POSTGRES_REQUIRED');
const {report,entries}=readTestInventory(process.cwd());
if(report.commitSha!==process.env.NEXOWIRE_EXPECTED_COMMIT_SHA||git('rev-parse','HEAD')!==report.commitSha)throw Error('HEAD_MISMATCH');
const check=()=>{for(const [f,b] of Object.entries(pins)){const s=lstatSync(f);if(!s.isFile()||s.isSymbolicLink()||git('rev-parse','HEAD:'+f)!==b||hash(readFileSync(f))!==b)throw Error('PIN_MISMATCH:'+f);}};
check();
if(!entries.some(e=>e.path===file&&e.blob===pins[file]))throw Error('INVENTORY_MISMATCH');
const dir='ai08-credential-atomicity-receipts';mkdirSync(dir,{recursive:true});
const receipt={schemaVersion:1,sourceCommitSha:report.commitSha,sourceManifestSha256:report.manifestSha256,platform:process.platform,nodeVersion:process.version,runId:process.env.GITHUB_RUN_ID,jobId:process.env.NX_JOB_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,pins,scope:'REAL_DISPOSABLE_POSTGRES_CREDENTIAL_ATOMICITY',expected:3,status:'FAIL',physicalNativeEffectAcceptance:'NOT_PROVEN'};
const save=()=>writeFileSync(path.join(dir,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
save();
const child=spawnSync(process.execPath,['--test','--test-reporter=tap','--test-concurrency=1','--import','tsx',file],{encoding:'utf8',timeout:240000,maxBuffer:8*1024*1024});
const tap=child.stdout??'';writeFileSync(path.join(dir,'credential-atomicity.tap'),tap);process.stdout.write(tap);if(child.stderr)process.stderr.write(child.stderr);
receipt.tapSha256=createHash('sha256').update(tap).digest('hex');
try{if(child.error||child.signal||child.status!==0)throw Error('CHILD_FAILED');receipt.counts=assertTapSummary(tap,3);if(receipt.counts.tests!==3)throw Error('EXACT_COUNT_MISMATCH');check();receipt.status='PASS';}catch(e){receipt.failure=e.message;}
save();console.log(JSON.stringify(receipt));if(receipt.status!=='PASS')process.exitCode=1;
