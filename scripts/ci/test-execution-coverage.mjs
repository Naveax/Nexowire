import {readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {readTestInventory,summarizeTestFiles} from './test-inventory.mjs';
import {APPROVED_ROOT_TEST_FILES,REVIEWED_ROOT_GIT_BLOBS} from './portable-root-execution-receipt.mjs';

function deny(reason) {throw new Error('TEST_COVERAGE_' + reason)}
const sha=/^[0-9a-f]{40}$/;
const manifest=/^[0-9a-f]{64}$/;
const safeInt=x=>Number.isSafeInteger(x)&&x>=0;

/**
 * Cross-check a separately produced execution receipt against immutable Git
 * test inventory. This is reconciliation, not proof of independent execution.
 */
export function reconcileCoverage(entries,inventory,receipt) {
  if (!Array.isArray(entries) || !inventory || !receipt ||
      inventory.schemaVersion!==1 || receipt.schemaVersion!==1 ||
      !sha.test(inventory.commitSha) || !manifest.test(inventory.manifestSha256) ||
      receipt.sourceCommitSha!==inventory.commitSha ||
      receipt.sourceManifestSha256!==inventory.manifestSha256)
    deny('SOURCE_MISMATCH');
  if (!safeInt(inventory.trackedTsTestFiles) ||
      inventory.trackedTsTestFiles!==entries.length ||
      receipt.scope!=='ONLY_EXPLICIT_APPROVED_ROOT_TEST_FILES' ||
      receipt.physicalWindowsAcceptance!=='NOT_INFERRED' ||
      receipt.fail!==0 || receipt.skipped!==0 || receipt.todo!==0 ||
      receipt.cancelled!==0 ||
      !Array.isArray(receipt.files) || !safeInt(receipt.executedFileCount) ||
      receipt.executedFileCount!==receipt.files.length ||
      !safeInt(receipt.testsPassed)) deny('INVALID_RECEIPT');
  const tracked=new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.path!=='string' || !sha.test(entry.blob) ||
        tracked.has(entry.path)) deny('INVALID_INVENTORY');
    tracked.set(entry.path,entry.blob);
  }
  // A caller may supply the correct 40/64-character labels alongside a
  // different set of unreviewed files. Recompute the canonical Git manifest
  // before emitting NOT_RUN counts; a matching file count is not a proof.
  let actualInventory;
  try { actualInventory=summarizeTestFiles(entries,inventory.commitSha); }
  catch {deny('INVALID_INVENTORY');}
  if(actualInventory.manifestSha256!==inventory.manifestSha256 ||
     actualInventory.trackedTsTestFiles!==inventory.trackedTsTestFiles ||
     !inventory.byDepth ||
     ['root','oneDirectory','deeper'].some(k=>
       actualInventory.byDepth[k]!==inventory.byDepth[k]))
    deny('INVENTORY_MANIFEST_MISMATCH');
  // This receipt format promises reviewed portable-root execution only.
  // A matching Git manifest is insufficient: an unapproved tracked test must
  // never acquire PASS evidence merely by being included in a forged receipt.
  const approved=new Set(APPROVED_ROOT_TEST_FILES);
  if(approved.size!==APPROVED_ROOT_TEST_FILES.length ||
     Object.keys(REVIEWED_ROOT_GIT_BLOBS).length!==approved.size ||
     [...approved].some(file=>!Object.hasOwn(REVIEWED_ROOT_GIT_BLOBS,file)))
    deny('REVIEWED_ALLOWLIST_INVALID');
  const executed=new Set();
  let passed=0;
  for(const f of receipt.files) {
    if(!f || typeof f.path!=='string' || !tracked.has(f.path) ||
       executed.has(f.path) || f.gitBlobSha!==tracked.get(f.path))
      deny('FILE_NOT_BOUND_TO_SOURCE');
    if(!approved.has(f.path) ||
       !Object.hasOwn(REVIEWED_ROOT_GIT_BLOBS,f.path) ||
       f.gitBlobSha!==REVIEWED_ROOT_GIT_BLOBS[f.path])
      deny('UNAPPROVED_ROOT_FILE');
    if(f.result!=='PASS' || !safeInt(f.tests) || f.tests===0 ||
       !safeInt(f.pass) || f.pass!==f.tests ||
       f.fail!==0 || f.skipped!==0 || f.todo!==0 || f.cancelled!==0)
      deny('FILE_COUNTERS_INVALID');
    executed.add(f.path);
    passed+=f.pass;
  }
  if(passed!==receipt.testsPassed)deny('TOTAL_COUNTERS_INVALID');
  const notRun=entries.map(e=>e.path).filter(p=>!executed.has(p)).sort();
  const fileStates=entries.map(e=>({
    path:e.path, gitBlobSha:e.blob,
    result:executed.has(e.path)?'PASS':'NOT_RUN',
  })).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  const statusCounts={PASS:executed.size,FAIL:0,SKIP:0,NOT_RUN:notRun.length};
  return {
    schemaVersion:1, sourceCommitSha:inventory.commitSha,
    sourceManifestSha256:inventory.manifestSha256,
    trackedFileCount:entries.length, executedFileCount:executed.size,
    notRunFileCount:notRun.length, passedAssertions:passed,
    executedFiles:[...executed].sort(),notRunFiles:notRun,
    fileStates,statusCounts,
    statusSemantics:'RECEIPT_ONLY_NO_GLOBAL_CI_INFERENCE',
    scope:'RECEIPT_RECONCILIATION_ONLY',
    comprehensiveCoverage:executed.size===entries.length,
    physicalWindowsAcceptance:'NOT_INFERRED',
  };
}

/**
 * Reconcile separately obtained raw lane receipts against caller-supplied,
 * independently reviewed lane policies. Never use a receipt as its own policy.
 * All inputs must describe one exact Git tree, OS and full Node version.
 * This validates evidence structure; it is not an execution attestation.
 */
export function reconcileLaneCoverage(entries,inventory,target,policies,receipts) {
  let actual;
  try {actual=summarizeTestFiles(entries,inventory.commitSha);}
  catch {deny('UNION_INVALID_INVENTORY');}
  if(inventory.schemaVersion!==1||actual.manifestSha256!==inventory.manifestSha256||
     actual.trackedTsTestFiles!==inventory.trackedTsTestFiles||
     !inventory.byDepth||Object.keys(actual.byDepth).some(k=>actual.byDepth[k]!==inventory.byDepth[k]))
    deny('UNION_INVENTORY_MISMATCH');
  if(!target||!['win32','linux','darwin'].includes(target.platform)||
     typeof target.nodeVersion!=='string'||!/^v(?:22|24)\.\d+\.\d+$/.test(target.nodeVersion))
    deny('UNION_TARGET_INVALID');
  if(!Array.isArray(policies)||policies.length===0||!Array.isArray(receipts))
    deny('UNION_POLICY_REQUIRED');
  const tracked=new Map(entries.map(e=>[e.path,e.blob]));
  const expected=new Map();
  const cleanId=x=>typeof x==='string'&&/^[a-z0-9][a-z0-9_-]{0,79}$/.test(x);
  const scopes=new Set([
    'ONLY_EXPLICIT_APPROVED_ROOT_TEST_FILES','EXPLICIT_WINDOWS_SOURCE_FIXTURES_ONLY',
    'REVIEWED_WINDOWS_BROKER_AND_PRELOGIN_SOURCE_FIXTURES_ONLY',
    'REVIEWED_WINDOWS_STORAGE_AND_RECOVERY_SOURCE_FIXTURES_ONLY',
    'REVIEWED_PLATFORM_ACL_AND_SIDECAR_SOURCE_FIXTURES_ONLY',
    'REVIEWED_WINDOWS_AUTHORITY_AND_LEDGER_SOURCE_FIXTURES_ONLY',
    'REVIEWED_WINDOWS_CROSS_OWNER_SOURCE_FIXTURES_ONLY',
    'REVIEWED_WINDOWS_CORE_NEGATIVE_SOURCE_FIXTURES_ONLY',
    'REVIEWED_WINDOWS_DISPOSABLE_INSTALLER_FIXTURES_ONLY',
  ]);
  for(const policy of policies){
    if(!policy||!cleanId(policy.id)||expected.has(policy.id)||!scopes.has(policy.scope)||
       policy.platform!==target.platform||policy.nodeVersion!==target.nodeVersion||
       ![1,2].includes(policy.schemaVersion)||!Array.isArray(policy.files)||!policy.files.length)
      deny('UNION_POLICY_INVALID');
    if(policy.scope.includes('WINDOWS')&&target.platform!=='win32')
      deny('UNION_POLICY_PLATFORM');
    if(([
      'REVIEWED_WINDOWS_AUTHORITY_AND_LEDGER_SOURCE_FIXTURES_ONLY',
      'REVIEWED_WINDOWS_CROSS_OWNER_SOURCE_FIXTURES_ONLY',
      'REVIEWED_WINDOWS_CORE_NEGATIVE_SOURCE_FIXTURES_ONLY',
      'REVIEWED_WINDOWS_DISPOSABLE_INSTALLER_FIXTURES_ONLY',
    ].includes(policy.scope))!==(policy.schemaVersion===2))deny('UNION_POLICY_SCHEMA');
    const files=new Map();
    for(const f of policy.files){
      if(!f||!tracked.has(f.path)||tracked.get(f.path)!==f.gitBlobSha||
         files.has(f.path)||!safeInt(f.minimum)||f.minimum<1)
        deny('UNION_POLICY_FILE_INVALID');
      if(f.caseStates!==undefined){
        if(policy.scope!=='REVIEWED_PLATFORM_ACL_AND_SIDECAR_SOURCE_FIXTURES_ONLY'||
           !Array.isArray(f.caseStates)||f.caseStates.length<f.minimum||
           f.caseStates.some(c=>!c||typeof c.name!=='string'||!c.name||
             !['PASS','SKIP'].includes(c.result))||
           new Set(f.caseStates.map(c=>c.name)).size!==f.caseStates.length||
           !f.caseStates.some(c=>c.result==='SKIP')||
           !f.caseStates.some(c=>c.result==='PASS'))deny('UNION_POLICY_CASES_INVALID');
      }
      files.set(f.path,f);
    }
    expected.set(policy.id,{policy,files});
  }
  const received=new Map();
  for(const item of receipts){
    if(!item||!expected.has(item.id)||received.has(item.id)||!item.receipt)
      deny('UNION_UNKNOWN_OR_DUPLICATE_RECEIPT');
    received.set(item.id,item.receipt);
  }
  const observations=new Map(entries.map(e=>[e.path,[]]));
  const laneStates=[];
  for(const [id,{policy,files}] of expected){
    const r=received.get(id);
    if(!r){
      laneStates.push({id,result:'NOT_RUN',attemptedFileCount:0});
      for(const file of files.keys())observations.get(file).push({id,result:'NOT_RUN'});
      continue;
    }
    if(r.sourceCommitSha!==inventory.commitSha||r.sourceManifestSha256!==inventory.manifestSha256||
       r.platform!==target.platform||r.nodeVersion!==target.nodeVersion||
       r.schemaVersion!==policy.schemaVersion||r.scope!==policy.scope||
       r.physicalWindowsAcceptance!=='NOT_INFERRED')
      deny('UNION_RECEIPT_SOURCE_OR_TARGET');
    if(!Array.isArray(r.files)||r.files.length!==files.size||
       r.executedFileCount!==files.size)deny('UNION_RECEIPT_FILE_SET');
    const seen=new Set();
    const counts={PASS:0,FAIL:0,SKIP:0,NOT_RUN:entries.length-files.size};
    let passed=0;
    for(const f of r.files){
      const pin=f&&files.get(f.path);
      if(!pin||seen.has(f.path)||f.gitBlobSha!==pin.gitBlobSha)
        deny('UNION_RECEIPT_FILE_SET');
      seen.add(f.path);
      if(f.result==='FAIL'){
        if(r.schemaVersion!==2||['tests','pass','fail','skipped','todo','cancelled'].some(k=>Object.hasOwn(f,k)))
          deny('UNION_FAILED_COUNTERS');
      }else {
        if(!safeInt(f.tests)||f.tests<pin.minimum||!safeInt(f.pass)||
           !safeInt(f.skipped)||f.fail!==0||f.cancelled!==0||f.todo!==0||
           f.pass+f.skipped!==f.tests)deny('UNION_FILE_COUNTERS');
        if(pin.caseStates){
          if(f.result!=='SKIP'||!Array.isArray(f.caseStates)||
             f.caseStates.length!==pin.caseStates.length||f.tests!==pin.caseStates.length||
             f.caseStates.some((c,i)=>!c||c.name!==pin.caseStates[i].name||
               c.result!==pin.caseStates[i].result)||
             f.skipped!==pin.caseStates.filter(c=>c.result==='SKIP').length)
            deny('UNION_CASE_STATES');
        }else if(f.result!=='PASS'||f.skipped!==0||f.caseStates!==undefined)
          deny('UNION_UNEXPECTED_SKIP');
        passed+=f.pass;
        if(!safeInt(passed))deny('UNION_TOTAL_OVERFLOW');
      }
      counts[f.result]++;
      observations.get(f.path).push({id,result:f.result});
    }
    const portable=policy.scope==='ONLY_EXPLICIT_APPROVED_ROOT_TEST_FILES';
    if(portable){
      if(r.testsPassed!==passed||r.fail!==0||r.skipped!==0||r.todo!==0||r.cancelled!==0)
        deny('UNION_LANE_TOTALS');
    }else{
      if(r.trackedFileCount!==entries.length||r.notRunFileCount!==counts.NOT_RUN||
         r.passedAssertions!==passed||!r.statusCounts||
         Object.keys(counts).some(k=>r.statusCounts[k]!==counts[k]))
        deny('UNION_LANE_TOTALS');
    }
    if(r.schemaVersion===2&&(r.attemptedFileCount!==files.size||
       r.acceptance!==(counts.FAIL?'FAIL':'PASS')))deny('UNION_LANE_ACCEPTANCE');
    laneStates.push({id,result:counts.FAIL?'FAIL':counts.SKIP?'SKIP':'PASS',
      attemptedFileCount:files.size,passedAssertions:passed,statusCounts:counts});
  }
  const statusCounts={PASS:0,FAIL:0,SKIP:0,NOT_RUN:0};
  const fileStates=entries.map(e=>{
    const lanes=observations.get(e.path).sort((a,b)=>a.id.localeCompare(b.id,'en'));
    // A PASS cannot override a FAIL or a partial SKIP in another lane.
    const result=['FAIL','SKIP','PASS','NOT_RUN'].find(s=>lanes.some(l=>l.result===s))??'NOT_RUN';
    statusCounts[result]++;
    return {path:e.path,gitBlobSha:e.blob,result,lanes};
  }).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  laneStates.sort((a,b)=>a.id.localeCompare(b.id,'en'));
  const missing=laneStates.filter(l=>l.result==='NOT_RUN').map(l=>l.id);
  return {schemaVersion:1,sourceCommitSha:inventory.commitSha,
    sourceManifestSha256:inventory.manifestSha256,platform:target.platform,
    nodeVersion:target.nodeVersion,trackedFileCount:entries.length,statusCounts,fileStates,
    lanes:laneStates,missingLaneIds:missing,
    requiredLaneAcceptance:statusCounts.FAIL?'FAIL':missing.length?'INCOMPLETE':
      statusCounts.SKIP?'PASS_WITH_EXPECTED_PLATFORM_SKIPS':'PASS',
    uniqueAttemptedFileCount:entries.length-statusCounts.NOT_RUN,
    comprehensiveCoverage:statusCounts.PASS===entries.length&&missing.length===0,
    assertionAggregation:'PER_LANE_ONLY_NO_CROSS_LANE_SUM',
    scope:'EXACT_TARGET_LANE_RECEIPT_RECONCILIATION_ONLY',
    physicalWindowsAcceptance:'NOT_INFERRED'};
}

const invoked=process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url;
if(invoked) {
  try {
    if(process.argv.length!==4||process.argv[2]!=='--receipt')deny('USAGE');
    const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
    const {entries,report}=readTestInventory(root);
    if(process.env.CI==='true' && !Object.hasOwn(process.env,'NEXOWIRE_EXPECTED_COMMIT_SHA'))
      deny('EXPECTED_HEAD_SHA_REQUIRED_IN_CI');
    if(Object.hasOwn(process.env,'NEXOWIRE_EXPECTED_COMMIT_SHA')&&
       process.env.NEXOWIRE_EXPECTED_COMMIT_SHA!==report.commitSha)
      deny('EXPECTED_HEAD_SHA_MISMATCH');
    const receipt=JSON.parse(readFileSync(process.argv[3],'utf8').replace(/^\uFEFF/,''));
    process.stdout.write(JSON.stringify(reconcileCoverage(entries,report,receipt))+'\n');
  } catch(e) {
    process.stderr.write((e instanceof Error?e.message:'TEST_COVERAGE_UNKNOWN')+'\n');
    process.exitCode=1;
  }
}
