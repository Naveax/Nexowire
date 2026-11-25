import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {WINDOWS_PLAN as windows,COMPOSITION,COMPOSITION_IMPORTS,validateWindowsPlan,assertCoreExactTap} from './ai08-core-authority-plan.mjs';
import {readTestInventory} from './test-inventory.mjs';
validateWindowsPlan();
const postgres={
 'test/ai08/core-credential-postgres-live.test.ts':['3763a40865c7b79435eb05f555138f826a1e1d69',5]
};
const deps={
 'src/agent/windows-core-consent-transport.ts':'bcf994f6d23bc139ce43b26dcb77f8e1fdaf9cab',
 'src/agent/windows-core-console-provider.ts':'2e305fbaefa8f3fdcbfe26d98aefc5e4564bd317',
 'src/security/core-webauthn-approval.ts':'4b66824edb04d0fea503012f83b70c068a8c5c14',
 'src/agent/broker-dispatch-authority-handler.ts':'f559be00a35a683f0f3e8bb10fc9b7c2ec7fbb58',
 'src/agent/broker-dispatch-mtls-fetch.ts':'a5e8dc574a047095f77f7b9dec1278e30b3555a9',
 'src/agent/protected-broker-dispatch-service.ts':'eb29ce4ea890accc7fbdc84912852eb889d4e3d0',
 'src/agent/https-broker-dispatch-authority.ts':'40e044f35b4ea55a4f2b35a6ff0ef75fcc66bb74',
 'src/agent/protected-dispatch-native-installation-readback.ts':'4d5502266fc1f9789cc578abcb9d66ab2a8d4260',
 'src/agent/postgres-dispatch-credential-store.ts':'acd931e125e01c8ccc601acde2a5cf7d8956049b',
 'src/protocol/core-native-consent-transport.ts':'9a64ded9ef6d6c50bfd5e3d627495e253c2f14ee',
 'src/security/core-native-verifier-server.ts':'78ffdc36ff6728ae8880b10db21d2fc5bf225394',
 'src/security/core-native-mtls-fetch.ts':'d824def6dd40ad2973d4d21a07c2425e2d09a0cb',
 'src/security/core-native-verifier-service.ts':'2dcc44d341dd0c98e3ed099ed910fcbb5b42ced5',
 'src/security/postgres-core-approval-ledger.ts':'13c1cf64080548e1d1ace9f8aeb84c5fefb4053e',
 'src/agent/postgres-broker-dispatch-authority.ts':'bd20c41dc1f08329e937ca7463cfa1e92eca3ee7',
 'src/agent/protected-postgres-dispatch-pool.ts':'65d65241171c71b436a5e7606a77aeb9d0fcb0cc',
 'sql/core-broker-dispatch-authority.sql':'a120585a92d7ab41bb2d1a3aaf5c0bc31f9ca74b',
 'sql/core-broker-dispatch-credentials.sql':'4cd511f8246025c7293202070527c66710b80a62',
 'src/agent/protected-native-completion-reader.ts':'b6f6c298ee0863064942fa4d8dbb4847b22965d6',
 'src/agent/broker-external-dispatch-fence.ts':'95f96ce8160c84d743557f38c638261c08bfc363',
 'sql/core-broker-native-completion.sql':'a70fc4ec2311e073b099e9168a9bcdc6859234cc',
 'sql/core-broker-dispatch-credential-fence.sql':'6c847b5386312a2550318f68792822feb5a93192'
};
const lane=process.argv[2],tests=lane==='windows'?windows:lane==='postgres'?postgres:null;
if(!tests||process.platform!==(lane==='windows'?'win32':'linux')||process.env.GITHUB_ACTIONS!=='true'||
 process.env.RUNNER_ENVIRONMENT!=='github-hosted'||process.versions.node.split('.')[0]!==process.env.NX_EXPECTED_NODE||
 !/^\d+$/.test(process.env.NX_JOB_ID??'')||!/^\d+$/.test(process.env.GITHUB_RUN_ID??''))throw Error('HOSTED_EXACT_TARGET_REQUIRED');
if(lane==='postgres'&&(process.env.NEXOWIRE_PG_DISPATCH_INTEGRATION!=='1'||process.env.NEXOWIRE_PG_DISPATCH_TEST_PORT!=='5432'))throw Error('DISPOSABLE_POSTGRES_REQUIRED');
const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim();
const blob=b=>createHash('sha1').update('blob '+b.length+'\0').update(b).digest('hex');
const {report,entries}=readTestInventory(process.cwd());
if(report.commitSha!==process.env.NEXOWIRE_EXPECTED_COMMIT_SHA||git('rev-parse','HEAD')!==report.commitSha)throw Error('HEAD_MISMATCH');
const covered=lane==='windows'?COMPOSITION_IMPORTS:{};
const pins={...deps,...Object.fromEntries(Object.entries(covered).map(([f,p])=>[f,p.blob])),...Object.fromEntries(Object.entries(tests).map(([f,[b]])=>[f,b]))};
const check=()=>{for(const [f,b] of Object.entries(pins)){
 const st=lstatSync(f);
 if(!st.isFile()||st.isSymbolicLink()||git('rev-parse','HEAD:'+f)!==b||blob(readFileSync(f))!==b)throw Error('PIN_MISMATCH:'+f);
}};
check();
for(const [f,[b]] of Object.entries(tests))if(!entries.some(e=>e.path===f&&e.blob===b))throw Error('INVENTORY_MISMATCH:'+f);
for(const [f,p] of Object.entries(covered))if(!entries.some(e=>e.path===f&&e.blob===p.blob))throw Error('IMPORTED_INVENTORY_MISMATCH:'+f);
const dir='ai08-core-authority-receipts';mkdirSync(dir,{recursive:true});
const receipt={schemaVersion:1,sourceCommitSha:report.commitSha,sourceManifestSha256:report.manifestSha256,platform:process.platform,nodeVersion:process.version,workflowRunId:process.env.GITHUB_RUN_ID,jobId:process.env.NX_JOB_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,lane,scope:'HOSTED_CORE_AUTHORITY_SOURCE_ONLY',pins,importedSuites:Object.entries(covered).map(([file,p])=>({file,blob:p.blob,expected:p.tests,executedVia:COMPOSITION})),files:Object.entries(tests).map(([file,[blob,expected]])=>({file,blob,expected,status:'NOT_RUN'}))};
const save=()=>writeFileSync(path.join(dir,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
save();
for(const r of receipt.files){
 check();
 const child=spawnSync(process.execPath,['--test','--test-reporter=tap','--test-concurrency=1','--import','tsx',r.file],{encoding:'utf8',timeout:240000,maxBuffer:8*1024*1024,windowsHide:true});
 const tap=child.stdout??'';
 writeFileSync(path.join(dir,path.basename(r.file)+'.tap'),tap);
 process.stdout.write(tap);if(child.stderr)process.stderr.write(child.stderr);
 r.tapSha256=createHash('sha256').update(tap).digest('hex');r.exitCode=child.status;r.signal=child.signal;
 try{
  if(child.error||child.signal||child.status!==0)throw Error('CHILD_FAILED');
  r.counts=assertCoreExactTap(r.file,tap,r.expected);
  r.status='PASS';
 }catch(e){r.status='FAIL';r.failure=e.message;}
 save();
}
console.log(JSON.stringify(receipt));
if(receipt.files.some(f=>f.status!=='PASS'))process.exitCode=1;
