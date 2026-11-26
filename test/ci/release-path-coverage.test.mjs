import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = readFileSync(path.join(root,'.github/workflows/release-readiness.yml'),'utf8');
const prSection = /\n  pull_request:\s*\n    paths:\s*\n([\s\S]*?)\n  push:\s*\n/.exec(workflow)?.[1];
const required = [
  'scripts/Read-Nexowire-V109CoreReadiness.ps1',
  'scripts/ci/v109-experimental-source-audit.mjs',
  'test/ci/v109-core-readonly-preflight.test.mjs',
  'test/ci/v109-experimental-source-audit.test.mjs',
  'test/ci/release-path-coverage.test.mjs',
  'test/hub-boot-status-legacy-user.test.ts',
  'test/hub-boot-task-shell-trust.test.ts',
  'test/hub-boot-root-boundary.test.ts',
  'test/hub-boot-handoff-transaction.test.ts',
  'test/hub-boot-protected-state-gate.test.ts',
  'test/hub-boot-shared-ancestor-trust.test.ts',
  'test/hub-boot-uninstall-task-absence.test.ts',
  'test/hub-boot-staged-activation.test.ts',
  'test/hub-boot-machine-startup-admission.test.ts',
  'src/security/windows-machine-startup-admission.ts',
  'test/hub-boot-hidden-task-visibility.test.ts',
  'test/windows-unattended-reboot-readiness.test.ts',
  'test/windows-dpapi-shell-trust.test.ts',
  'scripts/ci/assert-tap-summary.mjs',
  'scripts/ci/test-inventory.mjs',
  'scripts/ci/test-execution-plan.mjs',
  'scripts/ci/test-execution-coverage.mjs',
  'scripts/ci/portable-root-execution-receipt.mjs',
  'scripts/ci/pure-import-provenance.mjs',
  'test/ci/test-inventory.test.mjs',
  'test/ci/test-execution-plan.test.mjs',
  'test/ci/test-execution-coverage.test.mjs',
  'test/ci/portable-root-execution-receipt.test.mjs',
  'test/ci/pure-import-provenance.test.mjs',
  '.github/workflows/ci.yml',
  'src/agent/process-launch-mode.ts',
  'src/agent/process-manager.ts',
  'src/agent/windows-job-owner.ts',
  'native/windows-job-owner.c',
  'scripts/build-windows-job-owner.ps1',
  'test/process-manager-tree-cleanup.test.ts',
  'test/ai05/personal-process-mode.test.ts',
  'src/mcp/cross-device-file-transfer.ts',
  'src/mcp/create-server.ts',
  'test/cross-device-file-transfer.test.ts',
  'test/cross-device-mcp-transfer.e2e.test.ts',
  'test/delegated/k19/issue588-large-file-acceptance.test.ts',
];

test('release readiness is triggered by changes in critical physical CORE and file-transfer sources',()=>{
  assert.ok(prSection,'workflow must have pull_request path rules before push triggers');
  const paths=[...prSection.matchAll(/^\s+- "([^"]+)"\s*$/gm)].map(match=>match[1]);
  assert.equal(paths.length,new Set(paths).size,'duplicate release trigger paths');
  assert.ok(paths.includes('test/windows-job-*.test.ts'),
    'Windows Job test-only changes must trigger Release Readiness');
  for(const file of required){
    assert.ok(paths.includes(file),'missing exact release trigger: '+file);
    assert.ok(existsSync(path.join(root,file)),'listed release trigger file missing from source: '+file);
  }
});

test('stable and experimental releases both run the release path coverage gate',()=>{
  const step=workflow.split('      - name: Verify release trigger coverage on all package versions\n')[1]
    ?.split('\n      - name:')[0];
  assert.ok(step,'release path coverage requires a dedicated package job step');
  assert.doesNotMatch(step,/^\s+if:/m,'stable tags must not skip the release path coverage');
  assert.match(step,/^\s+run: node --test test\/ci\/release-path-coverage\.test\.mjs\s*$/m);
  const command=/node --test ([^\n]*)/.exec(
    /- name: Verify experimental source and deny fake CORE acceptance([\s\S]*?)\n      - name:/.exec(workflow)?.[1]??'',
  )?.[1];
  assert.ok(command,'missing candidate source audit node test command');
  assert.doesNotMatch(command,/test\/ci\/release-path-coverage\.test\.mjs/);
  assert.match(command,/test\/ci\/v109-core-readonly-preflight\.test\.mjs/);
  assert.match(workflow,/\n  push:\s*\n    tags:\s*\n      - "v\*"\s*\n/);
});

test('tag release attestation and publication require exact-head AI-08 receipt checks',()=>{
  assert.match(workflow,/\n  ai08-coverage-reconciliation:\s*\n/);
  assert.match(workflow,/ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.match(workflow,/NEXOWIRE_EXPECTED_COMMIT_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.match(workflow,/matrix:\s*\n\s*node-version: \[22, 24\]/);
  assert.match(workflow,/run: node --test test\/ci\/test-execution-coverage\.test\.mjs/);
  assert.match(workflow,/  package:\s*\n    needs: \[ai08-coverage-reconciliation, ai08-windows-hub-boot-fixtures\]/);
  assert.match(workflow,/  attest:[\s\S]*?needs: package/);
  assert.match(workflow,/  publish:[\s\S]*?needs: \[package, attest\]/);
});

test('Windows Hub Boot source fixture lane is exact-head, bounded and mandatory for packaging',()=>{
  const lane=workflow.split('\n  ai08-windows-hub-boot-fixtures:\n')[1]?.split('\n  package:')[0];
  assert.ok(lane,'missing independent Windows fixture job');
  assert.match(lane,/runs-on: windows-latest/);
  assert.match(lane,/timeout-minutes: 40/);
  assert.match(lane,/node-version: \[22, 24\]/);
  assert.match(lane,/ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/);
  assert.match(lane,/persist-credentials: false/);
  assert.match(lane,/WINDOWS_FIXTURE_HEAD_MISMATCH/);
  assert.match(lane,/WINDOWS_FIXTURE_REVIEW_REQUIRED/);
  assert.match(lane,/WINDOWS_FIXTURE_PLATFORM_REQUIRED/);
  assert.match(lane,/assertTapSummary\(r\.stdout,minimum\)/);
  assert.match(lane,/r\.error\|\|r\.status!==0/);
  assert.match(lane,/physicalWindowsAcceptance:'NOT_INFERRED'/);
  assert.match(lane,/hasStartup\?startupReviewed:baselineReviewed/);
  assert.match(lane,/'test\/hub-boot-startup-trigger-integrity\.test\.ts':'61062ecab51d2852c750cccd03fae79f7b45286a'/);
  assert.match(prSection,/"test\/hub-boot-startup-trigger-integrity\.test\.ts"/,
    'future AI-01 fixture-only changes must trigger release review');
  assert.doesNotMatch(lane,/continue-on-error:\s*true|self-hosted/);
});

test('legacy boot profiles retain shared guards and staged activation uses one exact independent profile',()=>{
  const lane=workflow.split('\n  ai08-windows-hub-boot-fixtures:\n')[1]?.split('\n  package:')[0];
  assert.ok(lane);
  const shared=lane.split('const sharedReviewed = {')[1]?.split('};')[0];
  assert.ok(shared,'shared reviewed fixture set is required');
  const pins=Object.fromEntries([...shared.matchAll(/'([^']+)':'([0-9a-f]{40})'/g)].map(m=>[m[1],m[2]]));
  assert.deepEqual(pins, {
    "test/hub-boot-protected-state-gate.test.ts": "40994c7a1178b20946b4432c7ff2716f5a074dd1",
    "test/hub-boot-shared-ancestor-trust.test.ts": "5ef2a796bd617c10130ad44ebd88bed22f6f2466",
    "test/hub-boot-uninstall-task-absence.test.ts": "00457b3720774254d62b0cc378286e17bcbd30f2",
    "test/windows-dpapi-shell-trust.test.ts": "638804ff36f66555d220bb0757ce189354703775"
  });
  assert.equal([...shared.matchAll(/'([^']+)':'([0-9a-f]{40})'/g)].length,4);
  assert.ok(lane.includes('const profileReviewed=hasStartup?startupReviewed:baselineReviewed;'));
  assert.ok(lane.includes('WINDOWS_FIXTURE_DUPLICATE_REVIEW_PATH'));
  const staged=lane.split('const stagedReviewed = {')[1]?.split('};')[0];
  assert.ok(staged,'complete staged activation profile required');
  const stagedRows=[...staged.matchAll(/'([^']+)':'([0-9a-f]{40})'/g)];
  const stagedPins=Object.fromEntries(stagedRows.map(m=>[m[1],m[2]]));
  assert.equal(stagedRows.length,12);
  assert.deepEqual(stagedPins,{
    'test/hub-boot-status-legacy-user.test.ts':'800ca3e6bc6b892c26f102ec7f250754cc1372f3',
    'test/hub-boot-task-shell-trust.test.ts':'ce31e6c39b63647c5bb11e579262690694829b12',
    'test/hub-boot-root-boundary.test.ts':'b3d168159456820b5b7e8f8c3b06695732b537b4',
    'test/hub-boot-handoff-transaction.test.ts':'0d9cccd65c58dffd19ce532dd978f22efb2e670d',
    'test/hub-boot-startup-trigger-integrity.test.ts':'61062ecab51d2852c750cccd03fae79f7b45286a',
    'test/hub-boot-protected-state-gate.test.ts':'40994c7a1178b20946b4432c7ff2716f5a074dd1',
    'test/hub-boot-shared-ancestor-trust.test.ts':'7fb4ee2bc47fcc6543b70e0441bb795f7e8759b8',
    'test/hub-boot-uninstall-task-absence.test.ts':'9612d67e0e3042d0c07aa9f8b054203496adbc35',
    'test/windows-dpapi-shell-trust.test.ts':'638804ff36f66555d220bb0757ce189354703775',
    'test/hub-boot-staged-activation.test.ts':'8fd5be6b05550dfe16d8d5f3c24c6a2a072f2933',
    'test/hub-boot-hidden-task-visibility.test.ts':'29bdbe9b57f3889b4ff444c72d747e816545ed2c',
    'test/windows-unattended-reboot-readiness.test.ts':'291b663e099f78bc6391a429b7aa53b1b278f217'
  });
  assert.ok(lane.includes("const hasStaged=tracked.has('test/hub-boot-staged-activation.test.ts');"));
  assert.ok(lane.includes('const reviewed=hasCanonical?canonicalReviewed:hasStaged?stagedReviewed:{...profileReviewed,...sharedReviewed};'));
  assert.ok(lane.includes('AI01_STAGED_ACTIVATION_C614956A'));
  assert.ok(lane.includes('COORDINATED_RECOVERY_DENIAL_C614956A'));
  assert.ok(lane.includes('for(const [file,blob] of Object.entries(reviewed))check(file,blob);'));
  assert.ok(lane.includes('schemaVersion:1,reviewProfile,reviewExtension,sourceCommitSha:'));
  assert.ok(lane.includes("STATE_ACL_UNINSTALL_DPAPI_D2696376"));
});

test('DPAPI fixture budget preserves inner deadlines and does not relax other fixture bounds',()=>{
  const lane=workflow.split('\n  ai08-windows-hub-boot-fixtures:\n')[1]?.split('\n  package:')[0];
  assert.ok(lane);
  assert.match(lane,/const fixtureTimeoutMs=file=>file==='test\/windows-dpapi-shell-trust\.test\.ts'\s*\?7\*180000\+60000:90000;/);
  assert.match(lane,/const timeoutMs=fixtureTimeoutMs\(file\)/);
  assert.match(lane,/timeout:timeoutMs,maxBuffer:2\*1024\*1024,windowsHide:true/);
  assert.match(lane,/errorCode:r\.error\?\.code\?\?null/);
  assert.match(lane,/exitCode:r\.status,signal:r\.signal,elapsedMs,timeoutMs/);
  assert.match(lane,/throw Error\('WINDOWS_FIXTURE_EXECUTION_FAILED: '\+file\)/);
  assert.match(lane,/const counts=assertTapSummary\(r\.stdout,minimum\)/);
  assert.match(lane,/result:'PASS',elapsedMs,timeoutMs,\.\.\.counts/);
});

test('canonical boot profile retains all 13 exact fixtures and 69 minimum tests',()=>{
  const lane=workflow.split('\n  ai08-windows-hub-boot-fixtures:\n')[1]?.split('\n  package:')[0];
  assert.ok(lane.includes("const canonicalReviewed={...stagedReviewed,'test/hub-boot-machine-startup-admission.test.ts':'21399d24da8ae7ca6b0c0bd994c5109f2b1d3094'};"));
  assert.ok(lane.includes("const hasCanonical=tracked.has('test/hub-boot-machine-startup-admission.test.ts');"));
  assert.ok(lane.includes('WINDOWS_FIXTURE_CANONICAL_PROFILE_INCOMPLETE'));
  const minima=lane.split('const canonicalMinimums={')[1]?.split('};')[0];
  const counts=Object.fromEntries([...minima.matchAll(/'([^']+)':(\d+)/g)].map(m=>[m[1],Number(m[2])]));
  assert.deepEqual(counts,{"test/hub-boot-status-legacy-user.test.ts":1,"test/hub-boot-task-shell-trust.test.ts":5,"test/hub-boot-root-boundary.test.ts":11,"test/hub-boot-handoff-transaction.test.ts":5,"test/hub-boot-startup-trigger-integrity.test.ts":6,"test/hub-boot-protected-state-gate.test.ts":3,"test/hub-boot-shared-ancestor-trust.test.ts":5,"test/hub-boot-uninstall-task-absence.test.ts":2,"test/windows-dpapi-shell-trust.test.ts":4,"test/hub-boot-staged-activation.test.ts":9,"test/hub-boot-hidden-task-visibility.test.ts":5,"test/windows-unattended-reboot-readiness.test.ts":7,"test/hub-boot-machine-startup-admission.test.ts":6});
  assert.equal(Object.keys(counts).length,13);
  assert.equal(Object.values(counts).reduce((n,p)=>n+p,0),69);
  assert.match(lane,/assertTapSummary\(r\.stdout,minimum\)/);
});
