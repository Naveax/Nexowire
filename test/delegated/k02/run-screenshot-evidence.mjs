#!/usr/bin/env node
// Explicit nested .mjs runner for K13's non-core auxiliary CI workflow.
// A broad green npm test must not imply this suite ran by accident.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const paths = [
  resolve(root, 'browser-screenshot-evidence.test.mjs'),
  resolve(root, 'platform-evidence-gate.test.mjs'),
];
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const child = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...paths],
  { encoding: 'utf8', env, timeout: 30_000, maxBuffer: 1024 * 1024 });
process.stdout.write(child.stdout || '');
process.stderr.write(child.stderr || '');

const count = (key) => {
  const entries = [...(child.stdout || '').matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))];
  return entries.length === 1 ? Number(entries[0][1]) : null;
};
const tests = count('tests');
const pass = count('pass');
const fail = count('fail');
const skipped = count('skipped');
const todo = count('todo');
const cancelled = count('cancelled');
if (child.error || child.status !== 0 || tests === null || tests === 0 ||
    pass !== tests || fail !== 0 || skipped !== 0 || todo !== 0 || cancelled !== 0) {
  process.stderr.write('K02 OFFLINE EVIDENCE QA: NOT ACCEPTED (missing/partial/failing TAP)\n');
  process.exitCode = 1;
} else {
  process.stdout.write(`K02 OFFLINE EVIDENCE QA: ${pass}/${tests} isolated assertions executed locally\n`);
}
