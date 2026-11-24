import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Only reviewed, synthetic K18 test files. Never call a live device or Hub.
const sources={
  'src/workspace/artifact-bridge.ts':'c36a6c0ce3c373f622d862e4a41a6aaa13adf04a',
  'src/mcp/artifact-bridge-device-ingest.ts':'ebee8010de8c5e05d8d5e8bf81ebee70991707f9',
  'src/ops/scale-transport-metrics.ts':'bb79ba0635f862dfb19f92b9d4a461bc185cde48',
  'package-lock.json':'b4b0e6feacc5a340133363f68ff63b44ee649dc5',
};
const suites=[
  {path:'test/delegated/k18/ai07-cross-device-transfer-evidence.test.ts',blob:'a73b5290829820ca5aa9b5bf35585693af855927',expected:5},
  {path:'test/delegated/k18/ai07-offline-progress-boundary.test.ts',blob:'4571fd0c5b54ec944d9e8a9794ebaf88a43d417f',expected:8},
  {path:'test/delegated/k18/ai07-source-receipt.test.mjs',blob:'89219217bcb6a8f31ac69c39c031455670f54598',expected:7},
];
const keys=['tests','pass','fail','cancelled','skipped','todo'];
export function gitBlob(bytes){
  return createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');
}
export function exactTap(tap,expected){
  if(!Number.isSafeInteger(expected)||expected<1)throw Error('INVALID_EXPECTED_COUNT');
  const counts=Object.create(null);
  for(const line of tap.split(/\r?\n/)){
    const match=/^# (tests|pass|fail|cancelled|skipped|todo) (0|[1-9][0-9]*)$/.exec(line);
    if(!match)continue;
    const [,key,raw]=match;
    if(Object.hasOwn(counts,key))throw Error('DUPLICATE_TAP_'+key);
    const value=Number(raw);
    if(!Number.isSafeInteger(value))throw Error('INVALID_TAP_'+key);
    counts[key]=value;
  }
  for(const key of keys)if(!Object.hasOwn(counts,key))throw Error('MISSING_TAP_'+key);
  if(counts.tests!==expected||counts.pass!==expected||keys.slice(2).some(k=>counts[k]!==0)){
    throw Error('TAP_COUNTS_DO_NOT_MATCH_REVIEWED_SUITE');
  }
  return {...counts};
}
// Node's test worker sets NODE_TEST_CONTEXT. Passing it to another node
// --test invocation may silently skip test files while returning exit 0.
export function childTestEnv(parent=process.env){
  const env={...parent,NODE_OPTIONS:''};
  delete env.NODE_TEST_CONTEXT;
  return env;
}
export function acceptChild(result,expected){
  if(result.error||result.signal||result.status!==0)throw Error('TEST_PROCESS_FAILED');
  return exactTap(result.stdout,expected);
}
function git(root,args){
  const r=spawnSync('git',args,{cwd:root,encoding:'utf8',timeout:15000,maxBuffer:1048576});
  if(r.error||r.status!==0)throw Error('GIT_PREFLIGHT_FAILED');
  return r.stdout.trim();
}
function preflight(root,expectedSha){
  if(!/^[a-f0-9]{40}$/.test(expectedSha))throw Error('EXACT_SHA_REQUIRED');
  if(![22,24].includes(Number(process.versions.node.split('.')[0])))throw Error('NODE_MAJOR_UNREVIEWED');
  if(git(root,['rev-parse','HEAD'])!==expectedSha)throw Error('HEAD_MISMATCH');
  if(git(root,['status','--porcelain','--untracked-files=all']))throw Error('DIRTY_CHECKOUT');
  for(const [path,pin] of Object.entries({...sources,...Object.fromEntries(suites.map(s=>[s.path,s.blob]))})){
    if(git(root,['rev-parse','HEAD:'+path])!==pin||gitBlob(readFileSync(resolve(root,path)))!==pin){
      throw Error('UNREVIEWED_BLOB:'+path);
    }
  }
  const require=createRequire(resolve(root,'package.json'));
  for(const dependency of ['tsx','zod'])require.resolve(dependency);
}
function run(root,expectedSha){
  const receipt={schemaVersion:1,classification:'SYNTHETIC_SOURCE_ONLY',physicalAcceptance:'NOT_RUN',sourceCommitSha:expectedSha,node:process.version,reviewedSourceBlobs:sources,suites:suites.map(s=>({...s,status:'NOT_RUN',counts:null})),status:'NOT_RUN'};
  try{preflight(root,expectedSha)}catch(error){receipt.reason=error.message;return receipt}
  for(const suite of receipt.suites){
    const result=spawnSync(process.execPath,['--import','tsx','--test','--test-reporter=tap','--test-concurrency=1',suite.path],{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024,env:childTestEnv()});
    process.stderr.write(result.stdout||'');
    try{
      suite.counts=acceptChild(result,suite.expected);
      suite.status='PASS';
    }catch(error){suite.status='FAIL';suite.reason=error.message;}
    if(result.stderr)process.stderr.write(result.stderr);
  }
  // Revalidate tracked source after execution; a modified checkout cannot certify PASS.
  try{preflight(root,expectedSha)}catch(error){receipt.status='FAIL';receipt.reason=error.message;return receipt}
  receipt.status=receipt.suites.every(s=>s.status==='PASS')?'PASS':'FAIL';
  return receipt;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const receipt=run(process.cwd(),process.argv[2]||'');
  process.stdout.write(JSON.stringify(receipt)+'\n');
  process.exitCode=receipt.status==='PASS'?0:1;
}
