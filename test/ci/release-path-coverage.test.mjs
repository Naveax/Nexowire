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
  for(const file of required){
    assert.ok(paths.includes(file),'missing exact release trigger: '+file);
    assert.ok(existsSync(path.join(root,file)),'listed release trigger file missing from source: '+file);
  }
});

test('source-only experimental audit checks the release trigger regression on PRs',()=>{
  const command=/node --test ([^\n]*)/.exec(
    /- name: Verify experimental source and deny fake CORE acceptance([\s\S]*?)\n      - name:/.exec(workflow)?.[1]??'',
  )?.[1];
  assert.ok(command,'missing candidate source audit node test command');
  assert.match(command,/test\/ci\/release-path-coverage\.test\.mjs/);
  assert.match(command,/test\/ci\/v109-core-readonly-preflight\.test\.mjs/);
  assert.match(workflow,/\n  push:\s*\n    tags:\s*\n      - "v\*"\s*\n/);
});
