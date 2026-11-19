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
  assert.match(workflow, /test\/delegated\/k13\/p005-pr-ci-coverage\.test\.mjs/);
  assert.match(workflow, /ref: 3ca2cd12f003768ac66dea0f242b6b8007587101/);
  assert.match(workflow, /test\/delegated\/k13\/main-ci-evidence-gate\.test\.mjs/);
  assert.doesNotMatch(workflow, /pull_request_target|secrets\.|contents: write|id-token: write/);
});


test('echo-only YAML path cannot claim explicit CI source call', () => {
  const ghost = 'test/delegated/k09/roadmap-evidence.test.mjs';
  const ciSource = 'name: '+ghost+'\nrun: echo node --test '+ghost+'\nrun: npm run check';
  const result = auditMainCiSource({ciSource,npmTestCommand:'node --test --import tsx test/**/*.test.ts',paths:[ghost]});
  assert.equal(result.explicit_source,0);
  assert.deepEqual(result.no_known_invocation,[ghost]);
});

test('real inline node --test beats echo decoy', () => {
  const real='test/delegated/k05/audit-html.test.mjs', ghost='test/delegated/k09/roadmap-evidence.test.mjs';
  const ciSource='run: echo '+ghost+'\nrun: node --test '+real;
  const result=auditMainCiSource({ciSource,npmTestCommand:'',paths:[real,ghost]});
  assert.equal(result.explicit_source,1);
  assert.deepEqual(result.no_known_invocation,[ghost]);
});

test('multiline test arguments count but later echo does not', () => {
  const a='test/delegated/k05/audit-html.test.mjs', b='test/delegated/k11/p005-s5-evidence.test.ts';
  const ghost='test/delegated/k09/roadmap-evidence.test.mjs';
  const ciSource='run: |\n  node --test --import tsx \\\n    '+a+' \\\n    '+b+'\n  echo '+ghost;
  const result=auditMainCiSource({ciSource,npmTestCommand:'',paths:[a,b,ghost]});
  assert.equal(result.explicit_source,2);
  assert.deepEqual(result.no_known_invocation,[ghost]);
});

test('k20 wildcard requires actual node --test invocation', () => {
  const path='test/delegated/k20/triage-open-issues.test.mjs';
  const fake=auditMainCiSource({ciSource:'run: echo test/delegated/k20/*.test.mjs',npmTestCommand:'',paths:[path]});
  assert.deepEqual(fake.no_known_invocation,[path]);
  const real=auditMainCiSource({ciSource:'run: node --test test/delegated/k20/*.test.mjs',npmTestCommand:'',paths:[path]});
  assert.equal(real.explicit_source,1);
});

test('a backup suffix does not impersonate a selected test', () => {
  const path='test/delegated/k09/roadmap-evidence.test.mjs';
  const result=auditMainCiSource({ciSource:'run: node --test '+path+'.bak',npmTestCommand:'',paths:[path]});
  assert.deepEqual(result.no_known_invocation,[path]);
});


test('folded YAML >- passes test paths as real node --test arguments', () => {
  const a = 'test/delegated/k13/p005-main-ci-inventory.test.mjs';
  const b = 'test/delegated/k13/p005-pr-ci-coverage.test.mjs';
  const decoy = 'test/delegated/k20/printed-only.test.mjs';
  const ciSource = '  - name: QA\n    run: >-\n      node --test\n      '+a+'\n      '+b+'\n      echo '+decoy;
  const out = auditMainCiSource({ ciSource, npmTestCommand:'', paths:[a,b,decoy] });
  assert.equal(out.explicit_source,2);
  assert.deepEqual(out.no_known_invocation,[decoy]);
});

test('folded YAML echo-only mentions never become test invocations', () => {
  const path = 'test/delegated/k09/roadmap-evidence.test.mjs';
  const ciSource = 'run: >-\n  echo node --test '+path+'\n  echo '+path;
  const out = auditMainCiSource({ ciSource, npmTestCommand:'', paths:[path] });
  assert.equal(out.explicit_source,0);
  assert.deepEqual(out.no_known_invocation,[path]);
});
