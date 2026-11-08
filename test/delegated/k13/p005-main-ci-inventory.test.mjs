import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { auditMainCiSource, listDelegatedTests } from '../../../scripts/delegated/k13/p005-main-ci-inventory.mjs';

test('source inventory separates explicit workflow invocation from npm glob selection', () => {
  const paths = [
    'test/delegated/k09/roadmap-evidence.test.mjs',
    'test/delegated/k16/environment-doctor-contract.test.ts',
    'test/delegated/prototype-contract.test.ts',
    'test/delegated/k20/triage-open-issues.test.mjs',
    'test/delegated/k05/audit-html.test.mjs',
  ];
  const ciSource = 'run: node --test test/delegated/k05/audit-html.test.mjs test/delegated/k20/*.test.mjs';
  const result = auditMainCiSource({ ciSource, npmTestCommand: 'node --test --import tsx test/**/*.test.ts', paths });
  assert.equal(result.total, 5);
  assert.equal(result.explicit_source, 2);
  assert.equal(result.npm_one_directory_glob, 1);
  assert.deepEqual(result.no_known_invocation, [
    'test/delegated/k09/roadmap-evidence.test.mjs',
    'test/delegated/k16/environment-doctor-contract.test.ts',
  ]);
  assert.equal(result.evidence_level, 'SOURCE_INVENTORY_NOT_EXECUTION_PROOF');
  assert.equal(result.physical_device, 'NOT_RUN');
});

test('a YAML comment cannot turn an omitted nested MJS path into a CI invocation', () => {
  const target = 'test/delegated/k09/roadmap-evidence.test.mjs';
  const outcome = auditMainCiSource({
    ciSource: '# run: node --test ' + target + '\nrun: npm run check',
    npmTestCommand: 'node --test --import tsx test/**/*.test.ts',
    paths: [target],
  });
  assert.deepEqual(outcome.no_known_invocation, [target]);
});

test('POSIX sh without globstar selects direct TS tests but misses nested delegated TS', () => {
  const temp = mkdtempSync(join(tmpdir(), 'k13-glob-'));
  try {
    mkdirSync(join(temp, 'test/delegated/k16'), { recursive: true });
    writeFileSync(join(temp, 'test/delegated/direct.test.ts'), '');
    writeFileSync(join(temp, 'test/delegated/k16/nested.test.ts'), '');
    const expanded = execFileSync('sh', ['-c', 'printf "%s\\n" test/**/*.test.ts'],
      { cwd: temp, encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(expanded, ['test/delegated/direct.test.ts']);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('recursive inventory reports only delegated TS/MJS test files in stable order', () => {
  const temp = mkdtempSync(join(tmpdir(), 'k13-tree-'));
  try {
    mkdirSync(join(temp, 'test/delegated/nested'), { recursive: true });
    writeFileSync(join(temp, 'test/delegated/nested/b.test.mjs'), '');
    writeFileSync(join(temp, 'test/delegated/a.test.ts'), '');
    writeFileSync(join(temp, 'test/delegated/nested/not-test.ts'), '');
    assert.deepEqual(listDelegatedTests(temp), [
      'test/delegated/a.test.ts', 'test/delegated/nested/b.test.mjs',
    ]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('branch-scoped discovery workflow is read-only and pins two Node versions and exact HEAD', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/delegated-noncore.yml', import.meta.url), 'utf8');
  assert.match(workflow, /branches: \["k13\/p005-ci-discovery"\]/);
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /node-version: \[22, 24\]/);
  assert.match(workflow, /git rev-parse HEAD.*GITHUB_SHA/);
  assert.match(workflow, /test\/delegated\/k09\/roadmap-evidence\.test\.mjs/);
  assert.match(workflow, /test\/delegated\/k16\/environment-doctor-contract\.test\.ts/);
  assert.doesNotMatch(workflow, /pull_request_target|secrets\.|contents: write|id-token: write/);
});
