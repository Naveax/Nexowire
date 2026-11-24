/**
 * Exact-target collector. Independent reviewed source maps define each lane.
 * Receipts are produced in the same disposable CI job, never reused from another SHA.
 */
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,existsSync,lstatSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readTestInventory} from './test-inventory.mjs';
import {reconcileLaneCoverage} from './test-execution-coverage.mjs';
import {APPROVED_ROOT_TEST_FILES,REVIEWED_ROOT_GIT_BLOBS} from './portable-root-execution-receipt.mjs';
import {REVIEWED_BROKER_FIXTURES} from './windows-broker-fixture-receipt.mjs';
import {REVIEWED_STORAGE_FIXTURES} from './windows-storage-fixture-receipt.mjs';
import {PLATFORM_FIXTURES,expectedMixedStates} from './platform-acl-fixture-receipt.mjs';
import {REVIEWED_AUTHORITY_LEDGER_FIXTURES} from './windows-authority-ledger-fixture-receipt.mjs';
import {REVIEWED_CROSS_OWNER_FIXTURES} from './windows-cross-owner-fixture-receipt.mjs';
import {GROUPS} from './windows-installer-core-fixture-receipt.mjs';
const deny=reason=>{throw Error('COMBINED_COVERAGE_'+reason)};
const BOOT_WORKFLOW='.github/workflows/release-readiness.yml';
const BOOT_BLOB='faf4d285e4dc6ce8da7a8de0afa2fa59c9a2907b';
export const BOOT_FIXTURES=Object.freeze({
  'test/hub-boot-status-legacy-user.test.ts':Object.freeze({blob:'800ca3e6bc6b892c26f102ec7f250754cc1372f3',minimum:1}),
  'test/hub-boot-task-shell-trust.test.ts':Object.freeze({blob:'ce31e6c39b63647c5bb11e579262690694829b12',minimum:5}),
  'test/hub-boot-root-boundary.test.ts':Object.freeze({blob:'dee621f126f5b132cd0f25de8cb7469df244833c',minimum:11}),
  'test/hub-boot-handoff-transaction.test.ts':Object.freeze({blob:'8ad2c05bfe6c08ceae3e15792d493099e44ec20d',minimum:5}),
  'test/hub-boot-startup-trigger-integrity.test.ts':Object.freeze({blob:'61062ecab51d2852c750cccd03fae79f7b45286a',minimum:6}),
  'test/hub-boot-protected-state-gate.test.ts':Object.freeze({blob:'40994c7a1178b20946b4432c7ff2716f5a074dd1',minimum:3}),
  'test/hub-boot-shared-ancestor-trust.test.ts':Object.freeze({blob:'5ef2a796bd617c10130ad44ebd88bed22f6f2466',minimum:5}),
  'test/hub-boot-uninstall-task-absence.test.ts':Object.freeze({blob:'00457b3720774254d62b0cc378286e17bcbd30f2',minimum:2}),
  'test/windows-dpapi-shell-trust.test.ts':Object.freeze({blob:'638804ff36f66555d220bb0757ce189354703775',minimum:4}),
});
const asPins=map=>Object.entries(map).map(([p,v])=>({path:p,gitBlobSha:v.blob,minimum:v.minimum}));
const lane=(target,id,scope,schemaVersion,files,script,args=['--json'],timeoutMs=1800000)=>
  ({policy:{...target,id,scope,schemaVersion,files},script,args,timeoutMs});
export function reviewedLanes(target){
  const {platform}=target;
  if(!['win32','linux'].includes(platform))deny('PLATFORM');
  const platformFiles=asPins(PLATFORM_FIXTURES[platform]).map(f=>
    PLATFORM_FIXTURES[platform][f.path].mixed?{...f,caseStates:expectedMixedStates(platform)}:f);
  const common=lane(target,'platform-acl','REVIEWED_PLATFORM_ACL_AND_SIDECAR_SOURCE_FIXTURES_ONLY',1,platformFiles,'platform-acl-fixture-receipt.mjs');
  if(platform==='linux')return [
    lane(target,'portable','ONLY_EXPLICIT_APPROVED_ROOT_TEST_FILES',1,
      APPROVED_ROOT_TEST_FILES.map(p=>({path:p,gitBlobSha:REVIEWED_ROOT_GIT_BLOBS[p],minimum:1})),
      'portable-root-execution-receipt.mjs'),common,
  ];
  return [
    lane(target,'boot','EXPLICIT_WINDOWS_SOURCE_FIXTURES_ONLY',1,asPins(BOOT_FIXTURES),null,[],2400000),
    lane(target,'broker','REVIEWED_WINDOWS_BROKER_AND_PRELOGIN_SOURCE_FIXTURES_ONLY',1,asPins(REVIEWED_BROKER_FIXTURES),'windows-broker-fixture-receipt.mjs'),
    lane(target,'storage','REVIEWED_WINDOWS_STORAGE_AND_RECOVERY_SOURCE_FIXTURES_ONLY',1,asPins(REVIEWED_STORAGE_FIXTURES),'windows-storage-fixture-receipt.mjs'),
    common,
    lane(target,'authority','REVIEWED_WINDOWS_AUTHORITY_AND_LEDGER_SOURCE_FIXTURES_ONLY',2,asPins(REVIEWED_AUTHORITY_LEDGER_FIXTURES),'windows-authority-ledger-fixture-receipt.mjs'),
    lane(target,'cross-owner','REVIEWED_WINDOWS_CROSS_OWNER_SOURCE_FIXTURES_ONLY',2,asPins(REVIEWED_CROSS_OWNER_FIXTURES),'windows-cross-owner-fixture-receipt.mjs',['--json'],3300000),
    lane(target,'core',GROUPS.core.scope,2,asPins(GROUPS.core.fixtures),'windows-installer-core-fixture-receipt.mjs',['core','--json']),
    lane(target,'runtime',GROUPS.runtime.scope,2,asPins(GROUPS.runtime.fixtures),'windows-installer-core-fixture-receipt.mjs',['runtime','--json']),
    lane(target,'installer',GROUPS.installer.scope,2,asPins(GROUPS.installer.fixtures),'windows-installer-core-fixture-receipt.mjs',['installer','--json']),
  ];
}
export function extractReviewedBootSource(bytes){
  const hash=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
  if(hash!==BOOT_BLOB)deny('BOOT_WORKFLOW_REVIEW_REQUIRED');
  const text=bytes.toString('utf8'),start="          @'\n          import {spawnSync} from 'node:child_process';",
    end="\n          '@ | node --input-type=module";
  const i=text.indexOf(start),j=text.indexOf(end,i);
  if(i<0||j<0||text.indexOf(start,i+start.length)>=0)deny('BOOT_SOURCE_BOUNDARY');
  return text.slice(i+"          @'\n".length,j).split('\n').map(l=>l.slice(10)).join('\n');
}
function executeLane(root,spec,dir){
  const file=path.join(dir,spec.policy.id+'.json');
  if(existsSync(file))deny('DUPLICATE_LANE_RECEIPT');
  const args=spec.script?[path.join(root,'scripts','ci',spec.script),...spec.args]:['--input-type=module'];
  const input=spec.script?undefined:extractReviewedBootSource(readFileSync(path.join(root,BOOT_WORKFLOW)));
  const r=spawnSync(process.execPath,args,{cwd:root,input,encoding:'utf8',timeout:spec.timeoutMs,maxBuffer:24*1024*1024,windowsHide:true});
  if(r.stderr)process.stderr.write(r.stderr);
  const lines=(r.stdout??'').split(/\r?\n/).filter(Boolean);
  let receipt;
  try{receipt=JSON.parse(lines.at(-1)??'');}catch{}
  if(spec.script===null&&lines.length>1)process.stderr.write(lines.slice(0,-1).join('\n')+'\n');
  if(receipt&&receipt.scope===spec.policy.scope&&!r.error&&r.signal==null&&
     (r.status===0||(r.status===1&&receipt.schemaVersion===2&&receipt.acceptance==='FAIL'))){
    writeFileSync(file,JSON.stringify(receipt)+'\n',{flag:'wx'});
  }else process.stderr.write(JSON.stringify({lane:spec.policy.id,result:'NO_VALID_RECEIPT',exitCode:r.status,errorCode:r.error?.code??null})+'\n');
  return r.status===0&&!r.error&&r.signal==null&&!!receipt&&receipt.scope===spec.policy.scope;
}
export function reconcileDirectory(entries,inventory,target,dir){
  const lanes=reviewedLanes(target),receipts=[];
  for(const {policy} of lanes){
    const file=path.join(dir,policy.id+'.json');
    if(!existsSync(file))continue;
    const st=lstatSync(file);
    if(!st.isFile()||st.isSymbolicLink()||st.size>4*1024*1024)deny('RECEIPT_FILE');
    receipts.push({id:policy.id,receipt:JSON.parse(readFileSync(file,'utf8'))});
  }
  return reconcileLaneCoverage(entries,inventory,target,lanes.map(l=>l.policy),receipts);
}
const invoked=process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url;
if(invoked){
  try{
    const mode=process.argv[2],dir=path.resolve(process.argv[3]??'');
    if(process.argv.length!==4||!['--run-source','--run-installer','--reconcile'].includes(mode))deny('USAGE');
    const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
    const {entries,report}=readTestInventory(root);
    if(!process.env.NEXOWIRE_EXPECTED_COMMIT_SHA||report.commitSha!==process.env.NEXOWIRE_EXPECTED_COMMIT_SHA)deny('HEAD_MISMATCH');
    const target={platform:process.platform,nodeVersion:process.version};
    const lanes=reviewedLanes(target);
    mkdirSync(dir,{recursive:true});
    reconcileLaneCoverage(entries,report,target,lanes.map(l=>l.policy),[]);
    if(mode==='--reconcile'){
      const r=reconcileDirectory(entries,report,target,dir);
      writeFileSync(path.join(dir,'combined.json'),JSON.stringify(r)+'\n',{flag:'wx'});
      process.stdout.write(JSON.stringify({...r,fileStates:undefined})+'\n');
      if(!['PASS','PASS_WITH_EXPECTED_PLATFORM_SKIPS'].includes(r.requiredLaneAcceptance))process.exitCode=1;
    }else{
      const selected=lanes.filter(l=>(l.policy.id==='installer')===(mode==='--run-installer'));
      if(!selected.length)deny('EMPTY_SELECTION');
      let ok=true;
      for(const spec of selected){try{if(!executeLane(root,spec,dir))ok=false;}catch(e){ok=false;process.stderr.write(spec.policy.id+': '+(e instanceof Error?e.message:'UNKNOWN')+'\n');}}
      if(!ok)process.exitCode=1;
    }
  }catch(e){process.stderr.write((e instanceof Error?e.message:'UNKNOWN')+'\n');process.exitCode=1;}
}
