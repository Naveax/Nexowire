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

function explicitlyListedInWorkflow(file: string, yaml: string): boolean {
  // Match an actual shell argument, not a substring of a different filename.
  return yaml.split(/\s+/).some(token => token.replace(/\\$/, '') === file);
}

function discovered(file: string, expandedShellArgs: readonly string[], yaml: string): boolean {
  return expandedShellArgs.includes(file) || explicitlyListedInWorkflow(file, yaml);
}

function expandedNpmTestPaths(): string[] {
  const script = packageJson.scripts.test;
  assert.equal(script, 'node --test --import tsx test/**/*.test.ts',
    'npm test command changed: update the discovery proof before interpreting CI');
  // CI invokes npm through a POSIX shell on Linux; this is the shell's expansion
  // of the exact fixed wildcard, NOT Node's recursive globSync semantics.
  return execFileSync('sh', ['-c', 'printf "%s\\n" test/**/*.test.ts'], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
  }).trim().split('\n');
}

test('T-503: exact source tests are not covered by current npm glob or explicit CI commands', () => {
  const expanded = expandedNpmTestPaths();
  assert.ok(expanded.some(path => path.endsWith('.test.ts')));
  for (const file of targetFiles) {
    assert.equal(discovered(file, expanded, workflow), false,
      `test discovery changed for ${file}: re-evaluate the hosted evidence`);
  }
});

test('K19 existing explicitly listed tests are detected (positive control)', () => {
  const expanded = expandedNpmTestPaths();
  assert.equal(discovered('test/delegated/k19/file-transfer-user-contract.test.ts', expanded, workflow), true);
  assert.equal(discovered('test/delegated/k19/file-transfer-copy-reference.test.ts', expanded, workflow), true);
});

test('an explicit future workflow command would correctly change discovery to true', () => {
  const expanded = expandedNpmTestPaths();
  assert.equal(discovered(targetFiles[0], expanded,
    `${workflow}\nnode --test --import tsx ${targetFiles[0]}\n`), true);
});

test('green CI is never proof of a nested test without its own discovery path', () => {
  const expanded = expandedNpmTestPaths();
  const ci = { completed: true, conclusion: 'success', jobs: 7 };
  assert.equal(ci.conclusion, 'success');
  assert.equal(ci.jobs, 7);
  assert.equal(discovered(targetFiles[1], expanded, workflow), false);
  // Host job success and test-file discovery are independent evidence levels.
  const testEvidence = discovered(targetFiles[1], expanded, workflow) ? 'DISCOVERED' : 'NOT_RUN';
  assert.equal(testEvidence, 'NOT_RUN');
});
