import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

// #1006 / T-642. A green seven-job workflow is not file-level test evidence.
// These are the added K18 tests in the still-Draft PRs, not the four prior
// K18 files explicitly invoked by the owner-controlled CI workflow. Each
// SHA/run is a historical exact-head run, not a prediction of the next run.
const added=[
  {pr:1107,run:42410160885,sha:'fed3b1c67a413a175e67593f87203e8610840d79',
    file:'test/delegated/k18/issue-487-588-evidence.test.ts'},
  {pr:1119,run:42411734969,sha:'6515f3777e510a6f62c8bc6cf9333d2fbe67877e',
    file:'test/delegated/k18/byte-unit-contract.test.ts'},
  {pr:1139,run:42474146267,sha:'51d8400430dd0b78bee6afb300cfe44ac67e560d',
    file:'test/delegated/k18/capacity-evidence-compat.test.ts'},
  {pr:1139,run:42474146267,sha:'51d8400430dd0b78bee6afb300cfe44ac67e560d',
    file:'test/delegated/k18/ingest-ack-loss.test.ts'},
  {pr:1151,run:42514934917,sha:'6ccf58e6f0e7ea2e84035c14bde1382ab8b2422e',
    file:'test/delegated/k18/p006-ack-digest-readback.test.ts'},
  {pr:1151,run:42514934917,sha:'6ccf58e6f0e7ea2e84035c14bde1382ab8b2422e',
    file:'test/delegated/k18/p006-ci-discovery-audit.test.ts'},
  {pr:1151,run:42514934917,sha:'6ccf58e6f0e7ea2e84035c14bde1382ab8b2422e',
    file:'test/delegated/k18/p006-evidence-classification.test.ts'},
  {pr:1151,run:42514934917,sha:'6ccf58e6f0e7ea2e84035c14bde1382ab8b2422e',
    file:'test/delegated/k18/p007-transfer-replay-integrity.test.ts'},
] as const;

type Evidence=typeof added[number];
type SourceCoverage={file:string;pr:number;headSha:string;workflowRun:number;
  callsitePresent:boolean;executedExactSha:boolean;classification:
    'NOT_RUN_OR_UNVERIFIED'|'EXACT_SHA_FILE_EXECUTED'};

/** Caller supplies exact file-execution evidence, never just a green job count. */
export function auditK18Coverage(workflow:string,items:readonly Evidence[],
  executedFiles:ReadonlySet<string>=new Set()):readonly SourceCoverage[]{
  const explicitlySelected=new Set(
    [...workflow.matchAll(/^\s+(test\/delegated\/k18\/[\w.-]+\.test\.ts)\s*\\?\s*$/gm)]
      .map(match=>match[1]!),
  );
  return items.map(({pr,run,sha,file})=>{
    const callsitePresent=explicitlySelected.has(file);
    // A file marked executed must first be named in the exact workflow;
    // hosted evidence for another SHA is deliberately not accepted.
    const executedExactSha=callsitePresent&&executedFiles.has(`${sha}:${run}:${file}`);
    return {pr,file,headSha:sha,workflowRun:run,callsitePresent,executedExactSha,
      classification:executedExactSha?'EXACT_SHA_FILE_EXECUTED':'NOT_RUN_OR_UNVERIFIED'};
  });
}

const ci=readFileSync(resolve('.github/workflows/ci.yml'),'utf8');
const pkg=JSON.parse(readFileSync(resolve('package.json'),'utf8')) as
  {scripts:{test:string}};

test('T-642 #1006 owner CI callsite audit distinguishes selected from unverified files',(t)=>{
  const selected=[...ci.matchAll(/^\s+(test\/delegated\/k18\/[\w.-]+\.test\.ts)\s*\\?\s*$/gm)]
    .map(match=>match[1]);
  for(const previous of [
    'test/delegated/k18/s5-report-contract.test.ts',
    'test/delegated/k18/telemetry-fixtures.test.ts',
    'test/delegated/k18/transport-metrics-parser.test.ts',
    'test/delegated/k18/transport-metrics-report.test.ts',
  ])assert.ok(selected.includes(previous),`Missing established K18 test ${previous}`);
  // The current npm test glob is single-level unless the invoking shell turns
  // on globstar. Do not infer an exact-file run from this string alone.
  t.diagnostic(`npm test script: ${pkg.scripts.test}`);
  const statuses=auditK18Coverage(ci,added);
  assert.equal(statuses.length,8);
  const absent=statuses.filter(x=>!x.callsitePresent);
  t.diagnostic(`New K18 PR tests absent from direct CI callsite: ${absent.map(x=>x.file).join(', ')||'none'}`);
  assert.ok(statuses.every(x=>x.classification==='NOT_RUN_OR_UNVERIFIED'));
});

test('T-642 #1006 even adding a callsite does not prove file execution on exact SHA',()=>{
  const file=added[0]!.file;
  const augmented=ci+`\n        ${file} \\\n`;
  const [observed]=auditK18Coverage(augmented,[added[0]!]);
  assert.equal(observed?.callsitePresent,true);
  assert.equal(observed?.classification,'NOT_RUN_OR_UNVERIFIED');
  const wrongSha=new Set([`0000000000000000000000000000000000000000:${added[0]!.run}:${file}`]);
  assert.equal(auditK18Coverage(augmented,[added[0]!],wrongSha)[0]?.executedExactSha,false);
  const wrongRun=new Set([`${added[0]!.sha}:0:${file}`]);
  assert.equal(auditK18Coverage(augmented,[added[0]!],wrongRun)[0]?.executedExactSha,false);
  const wrongFile=new Set([`${added[0]!.sha}:${added[0]!.run}:test/delegated/k18/other.test.ts`]);
  assert.equal(auditK18Coverage(augmented,[added[0]!],wrongFile)[0]?.executedExactSha,false);
  const exact=new Set([`${added[0]!.sha}:${added[0]!.run}:${file}`]);
  assert.equal(auditK18Coverage(augmented,[added[0]!],exact)[0]?.classification,
    'EXACT_SHA_FILE_EXECUTED');
});
