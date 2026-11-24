import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Source-only acceptance. Never use a self-hosted runner or production DB.
const pins = {
  'native/windows-transfer-volume-flush.cs':'7a62bf6c027544dfceb14f3ca939d7d76eb2ced9',
  'src/agent/protected-transfer-receipt-store.ts':'8aa3a0748e35ba677124e594d45d2345f83299e8',
  'src/agent/windows-protected-transfer-publisher.ts':'c58489edc11eb54b9a01584868ff729b087d93bf',
  'src/agent/native-transfer-publisher.ts':'e920d8a736aacc81882baefea156329b9d580ec5',
  'src/security/windows-programdata-acl.ts':'55d5814efd87f66e3ff553b415c42f37e23fce12',
  'test/mcp/ai07-protected-transfer-receipt.test.ts':'aaf5397796773028cd5453a3c92d0fd910f4130c',
  'test/mcp/ai07-windows-protected-publisher.test.ts':'77f28cbc08edf07a716b7e24acee78590d3e62a7',
  'test/mcp/ai07-postgres-transfer-authority.test.ts':'56d0504fd36473db49e7f678bbafdc6f23f1907b',
  'sql/large-transfer-authority.sql':'ab495d8c34b10cdd04f88e5ad1b2d40fde8b082d',
  'sql/core-broker-dispatch-authority.sql':'a120585a92d7ab41bb2d1a3aaf5c0bc31f9ca74b',
  'src/security/postgres-protected-transfer-authority.ts':'7af2bbc273cfb67be2ca40b22bf6177788a67982',
  'src/security/protected-transfer-authority.ts':'f4bfb778b17dd2c9005059605051ec27cca27f08',
  'src/security/protected-transfer-service.ts':'95e15f06e0485fc7e8f736ed27991110f8e96ed3',
  'src/mcp/durable-large-transfer.ts':'5e5f5873fefba4724ee83bf7ac80a6296cbed726',
  'package-lock.json':'b4b0e6feacc5a340133363f68ff63b44ee649dc5'
};
const lanes = {
  publisher: { platform:'win32', files:[
    ['test/mcp/ai07-windows-protected-publisher.test.ts',2],
    ['test/mcp/ai07-protected-transfer-receipt.test.ts',3]
  ] },
  postgres: { platform:'linux', files:[
    ['test/mcp/ai07-postgres-transfer-authority.test.ts',2]
  ] }
};
export function parseTapSummary(tap) {
  const fields = ['tests','pass','fail','cancelled','skipped','todo'];
  const result = {};
  for (const field of fields) {
    const matches = [...tap.matchAll(new RegExp('^# '+field+' (\\d+)\\r?$', 'gm'))];
    if (matches.length !== 1) throw new Error('TAP_SUMMARY_INVALID:'+field);
    const value = Number(matches[0][1]);
    if (!Number.isSafeInteger(value)) throw new Error('TAP_COUNT_INVALID:'+field);
    result[field] = value;
  }
  if (result.tests !== result.pass + result.fail + result.cancelled + result.skipped + result.todo)
    throw new Error('TAP_COUNT_MISMATCH');
  return result;
}
function git(...args) {
  return execFileSync('git',args,{encoding:'utf8',maxBuffer:16*1024*1024}).trim();
}
function run() {
  const laneName = process.argv[2], lane = lanes[laneName];
  if (!lane || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
      process.platform !== lane.platform || process.versions.node.split('.')[0] !== process.env.NX_EXPECTED_NODE)
    throw new Error('DISPOSABLE_HOSTED_LANE_REQUIRED');
  if (!/^[0-9]+$/.test(process.env.NX_JOB_ID ?? '') || !/^[0-9]+$/.test(process.env.GITHUB_RUN_ID ?? ''))
    throw new Error('EXACT_JOB_ID_REQUIRED');
  const sha = git('rev-parse','HEAD');
  if (sha !== process.env.NEXOWIRE_EXPECTED_COMMIT_SHA) throw new Error('EXACT_HEAD_MISMATCH');
  if (laneName === 'postgres' && (process.env.NEXOWIRE_PG_DISPATCH_INTEGRATION !== '1' ||
      process.env.NEXOWIRE_PG_DISPATCH_TEST_PORT !== '5432'))
    throw new Error('DISPOSABLE_POSTGRES_REQUIRED');
  for (const [file,blob] of Object.entries(pins)) {
    if (git('rev-parse','HEAD:'+file)!==blob || git('hash-object','--path='+file,file)!==blob)
      throw new Error('SOURCE_PIN_MISMATCH:'+file);
  }
  const inventory = git('ls-tree','-r','HEAD','--','test');
  const inventoryHash = createHash('sha256').update(inventory).digest('hex');
  const output = path.resolve('ai08-transfer-receipts');
  mkdirSync(output,{recursive:true});
  writeFileSync(path.join(output,'inventory.txt'),inventory+'\n');
  const receipt = {
    schemaVersion:1, sourceCommitSha:sha, sourceInventorySha256:inventoryHash,
    platform:process.platform,nodeVersion:process.version,workflowRunId:process.env.GITHUB_RUN_ID,
    jobId:process.env.NX_JOB_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,lane:laneName,
    scope:'HOSTED_SOURCE_FIXTURE_ONLY',pins,files:lane.files.map(([file,expected])=>({
      file,blob:pins[file],expected,status:'NOT_RUN'
    }))
  };
  const save=()=>writeFileSync(path.join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
  save();
  const env={...process.env};
  delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
  for(const record of receipt.files) {
    const started=Date.now();
    const child=spawnSync(process.execPath,['--test','--test-reporter=tap','--test-concurrency=1','--import','tsx',record.file],
      {env,encoding:'utf8',timeout:240000,maxBuffer:8*1024*1024,windowsHide:true});
    const tap=child.stdout??'';
    record.durationMs=Date.now()-started;
    record.exitCode=child.status;
    record.signal=child.signal;
    const tapPath=path.join(output,path.basename(record.file)+'.tap');
    writeFileSync(tapPath,tap);
    record.tapSha256=createHash('sha256').update(tap).digest('hex');
    process.stdout.write(tap);
    if(child.stderr) process.stderr.write(child.stderr);
    try {
      record.counts=parseTapSummary(tap);
      const c=record.counts;
      record.status=child.error||child.signal||child.status!==0||c.fail||c.cancelled||c.tests!==record.expected ? 'FAIL':
        c.skipped?'SKIP':c.todo?'TODO':c.pass===record.expected?'PASS':'FAIL';
    } catch(e) { record.status='FAIL'; record.failure=String(e.message); }
    if(child.error) record.failure=child.error.code??'CHILD_PROCESS_FAILED';
    save();
  }
  console.log(JSON.stringify(receipt));
  if(receipt.files.some(x=>x.status!=='PASS')) process.exitCode=1;
}
if (process.argv[1] && path.resolve(process.argv[1])===path.resolve('scripts/ci/ai08-transfer-acceptance.mjs')) run();
