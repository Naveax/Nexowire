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
]);

test('portable root smoke invokes only the three reviewed read-only contract files',()=>{
  const target=workflow.match(/^      - name: Execute allowlisted root tests and assert SHA-bound TAP receipt\n        timeout-minutes: 7\n        run: (.+)$/m);
  assert.ok(target,'missing separate timeout-bounded pure-contract step');
  const tokens=target[1].trim().split(/\s+/);
  assert.deepEqual(tokens,[
    'node','scripts/ci/portable-root-execution-receipt.mjs','--json',
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
  assert.match(workflow,/^        run: node --test test\/ci\/portable-root-smoke-contract\.test\.mjs$/m);
  assert.match(workflow,/^        run: node --test test\/ci\/portable-root-execution-receipt\.test\.mjs$/m);
  assert.match(workflow,/^  contents: read$/m);
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
