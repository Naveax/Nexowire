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
  assert.match(workflow,/  attest:[\s\S]*?needs: \[package, ai08-coverage-reconciliation\]/);
  assert.match(workflow,/  publish:[\s\S]*?needs: \[package, ai08-coverage-reconciliation, attest\]/);
});
