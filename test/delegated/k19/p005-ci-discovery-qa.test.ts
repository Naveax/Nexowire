/** #588 / #1006: a green workflow must not imply these nested K19 tests ran. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8');

export const targetFiles = [
  'test/delegated/k19/issue588-large-file-acceptance.test.ts',
  'test/delegated/k19/issue588-limits-inventory.test.ts',
] as const;

/** Best-effort static detector for explicit node --test arguments in YAML run commands.
 * Static discovery is NOT proof that a hosted job actually executed the file. */
function executableRunCommands(yaml: string): string[] {
  const commands: string[] = [];
  let blockIndent: number | null = null;
  let pending = '';
  const flush = () => {
    if (pending.trim()) commands.push(pending.trim());
    pending = '';
  };
  for (const line of yaml.split(/\r?\n/)) {
    const start = /^(\s*)(?:-\s*)?run:\s*(.*)$/.exec(line);
    if (start) {
      flush();
      const value = (start[2] ?? '').trim();
      blockIndent = /^[|>][-+]?$/.test(value) ? (start[1] ?? '').length : null;
      if (blockIndent === null && value) commands.push(value);
      continue;
    }
    if (blockIndent === null || !line.trim()) continue;
    const indent = /^\s*/.exec(line)?.[0].length ?? 0;
    if (indent <= blockIndent) {
      flush();
      blockIndent = null;
      contintest('T-503: nested K19 tests are not selected by the POSIX npm test glob', () => {
  const expanded = expandedNpmTestPaths();
  assert.ok(expanded.some(path => path.endsWith('.test.ts')));
  for (const file of targetFiles) {
    assert.equal(expanded.includes(file), false,
      'nested file unexpectedly selected by npm test: re-evaluate coverage');
    assert.equal(discovered(file, expanded, workflow),
      explicitlyListedInWorkflow(file, workflow),
      'only an explicit workflow run command may select this nested file');
  }
});

test('K19 existing explicitly listed tests are detected (positive control)', () => {
  const expanded = expandedNpmTestPaths();
  assert.equal(discovered('test/delegated/k19/file-transfer-user-contract.test.ts', expanded, workflow), true);
  assert.equal(discovered('test/delegated/k19/file-transfer-copy-reference.test.ts', expanded, workflow), true);
});

test('workflow comment and echo-only text cannot masquerade as test execution', () => {
  const target = targetFiles[0];
  const spoof = [
    `# node --test --import tsx ${target}`,
    `- name: ${target}`,
    `- run: echo ${target}`,
    '  run: |',
    `    # node --test --import tsx ${target}`,
    `    echo ${target}`,
  ].join('\n');
  assert.equal(explicitlyListedInWorkflow(target, spoof), false);
  assert.equal(explicitlyListedInWorkflow(target, `- run: node --test --import tsx ${target}`), true);
  assert.equal(explicitlyListedInWorkflow(target, `- run: |\n    node --test --import tsx \\\n      ${target}`), true);
});

test('an explicit future workflow command changes source-discovery status, not hosted PASS', () => {
  const expanded = expandedNpmTestPaths();
  const oldYaml = '- run: echo no-test-invocation';
  const withCall = `${oldYaml}\n- run: node --test --import tsx ${targetFiles[0]}\n`;
  assert.equal(discovered(targetFiles[0], expanded, oldYaml), false);
  assert.equal(discovered(targetFiles[0], expanded, withCall), true);
});

test('green CI and selected source path are separate from per-file hosted execution', () => {
  const expanded = expandedNpmTestPaths();
  const ci = { completed: true, conclusion: 'success', jobs: 7 };
  assert.equal(ci.conclusion, 'success');
  assert.equal(ci.jobs, 7);
  const sourceListed = discovered(targetFiles[1], expanded, workflow);
  const hostedTestRun = false; // No run/job ID or TAP for this PR's test is supplied by a source scan.
  assert.equal(sourceListed, explicitlyListedInWorkflow(targetFiles[1], workflow));
  assert.equal(hostedTestRun, false);
});
