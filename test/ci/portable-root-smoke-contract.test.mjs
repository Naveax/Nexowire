import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readTestInventory} from '../../scripts/ci/test-inventory.mjs';
import {APPROVED_ROOT_TEST_FILES,commandForApprovedRootFile} from '../../scripts/ci/portable-root-execution-receipt.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const workflow=readFileSync(resolve(root,'.github/workflows/portable-root-test-smoke.yml'),'utf8')
  .replace(/\r\n/g,'\n');

const approved=Object.freeze([
  'test/version.test.ts',
  'test/release-tag.test.ts',
  'test/ai07-physical-cutover-gate.test.ts',
  'test/capability-policy.test.ts',
  'test/device-routing-policy-store.test.ts',
  'test/agent-protocol.test.ts',
  'test/product-usage-policy.test.ts',
  'test/product-transport-policy.test.ts',
  'test/task-os-sandbox-policy-p07.test.ts',
  'test/bridge-guardian-policy.test.ts',
  'test/product-pairing.test.ts',
  'test/daily-quota-proposal.test.ts',
  'test/product-usage-ledger.test.ts',
  'test/progress-supervisor.test.ts',
  'test/guardian-key-enrollment-proof.test.ts',
  'test/guardian-signed-receipt.test.ts',
  'test/private-display-plan.test.ts',
  'test/owner-public-wss-p256-migration-proposal.test.ts',
  'test/agent-request-cache.test.ts',
  'test/owner-public-wss-stream-flow-staging.test.ts',
'test/scale-elastic-capacity-model.test.ts',
  'test/scale-s5-cost-envelope.test.ts',
  'test/scale-s5-resource-reconciliation.test.ts',
  'test/scale-s5-durable-object-cost.test.ts',
  'test/scale-s5-chunk-receipt-audit.test.ts',
  'test/scale-transport-metrics.test.ts',
  'test/scale-s5-provider-meter-evidence.test.ts',
]);

test('portable root smoke invokes only twenty-seven reviewed isolated policy and source contracts',()=>{
  const target=workflow.match(/^      - name: Execute allowlisted root tests and reconcile source-bound coverage\n        timeout-minutes: 7\n        env:\n          NEXOWIRE_EXPECTED_COMMIT_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}\n        run: (.+)$/m);
  assert.ok(target,'missing separate timeout-bounded pure-contract step');
  const tokens=target[1].trim().split(/\s+/);
  assert.deepEqual(tokens,[
    'node','scripts/ci/portable-root-coverage-gate.mjs','--json',
  ],'unsafe or bypassed verified test runner');
  assert.deepEqual(APPROVED_ROOT_TEST_FILES,approved,'execution allowlist changed');
  for(const file of approved) assert.deepEqual(commandForApprovedRootFile(file),[
    '--test','--test-reporter=tap','--import','tsx','--test-concurrency=1',file,
  ]);
  const {entries,report}=readTestInventory(root);
  const selected=new Set(entries.map(item=>item.path));
  for(const file of approved) {
    assert.ok(/^test\/[^/]+\.test\.ts$/.test(file),'test not root-level');
    assert.ok(selected.has(file),'test not tracked by Git source inventory: '+file);
  }
  assert.equal(new Set(approved).size,approved.length);
  assert.equal(report.legacyBashGlob.matchedWithoutGlobstar,report.byDepth.oneDirectory);
  assert.ok(report.legacyBashGlob.omittedWithoutGlobstar>=approved.length);
});

test('portable root test smoke cannot silently skip, widen OS, or lose CI lockfile install',()=>{
  assert.match(workflow,/^    runs-on: ubuntu-latest$/m);
  assert.match(workflow,/^    timeout-minutes: 12$/m);
  assert.match(workflow,/^        node-version: \[22, 24\]$/m);
  assert.match(workflow,/^        run: npm ci$/m);
  assert.match(workflow,/run: node --test test\/ci\/pure-import-provenance\.test\.mjs/);
  assert.match(workflow,/run: node scripts\/ci\/pure-import-provenance\.mjs --json/);
  assert.match(workflow,/NEXOWIRE_EXPECTED_COMMIT_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.match(workflow,/^        run: node --test test\/ci\/portable-root-smoke-contract\.test\.mjs$/m);
  assert.match(workflow,/^        run: node --test test\/ci\/portable-root-execution-receipt\.test\.mjs$/m);
  assert.match(workflow,/^        run: node --test test\/ci\/portable-root-coverage-gate\.test\.mjs test\/ci\/test-execution-coverage\.test\.mjs$/m);
  assert.match(workflow,/^  contents: read$/m);
  assert.match(workflow,/^      - uses: actions\/checkout@v4\n        with:\n          ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}$/m);
  assert.match(workflow,/^  cancel-in-progress: true$/m);
  assert.doesNotMatch(workflow,/continue-on-error:|--test-skip-pattern|^\s+if:\s*false\s*$/m);
  assert.doesNotMatch(workflow,/windows-latest|self-hosted|powershell|workflow_call/);
});

test('source test discovery and acceptance claims remain separate',()=>{
  const {report}=readTestInventory(root);
  assert.equal(report.physicalWindowsAcceptance,'NOT_INFERRED');
  assert.equal(report.legacyBashGlob.coverageClaim,'PATH_DISCOVERY_ONLY_NOT_EXECUTION_PROOF');
  assert.ok(report.trackedTsTestFiles>approved.length);
  assert.ok(report.byDepth.root>approved.length);
});
