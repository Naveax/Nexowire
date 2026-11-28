#!/usr/bin/env node
// #539: Run UI source tests against exactly one verified upstream/main web tree.
// This checks source provenance, not browser accessibility or R11 acceptance.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SUITES = Object.freeze([
  'test/delegated/k05/audit-html.test.mjs',
  'test/delegated/k05/dynamic-id-contract.test.mjs',
]);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const SHA = /^[0-9a-f]{40}$/;
const TREE = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;

function command(binary, args, { timeout = 15000 } = {}) {
  const run = spawnSync(binary, args, { cwd: root, encoding: 'utf8', timeout, maxBuffer: 10 * 1024 * 1024 });
  if (run.error || run.status !== 0) throw new Error(`${binary} ${args[0]} exited ${run.status ?? 'unknown'}`);
  return run.stdout.trim();
}

function git(...args) { return command('git', args); }

export function validateUiProvenance(state) {
  const failures = [];
  if (!SHA.test(state.expectedMainSha ?? '') || !SHA.test(state.currentMainSha ?? '')) failures.push('invalid-main-sha');
  else if (state.expectedMainSha !== state.currentMainSha) failures.push('stale-main-ref');
  if (!TREE.test(state.checkoutWebTree ?? '') || !TREE.test(state.mainWebTree ?? '')) failures.push('invalid-web-tree');
  else if (state.checkoutWebTree !== state.mainWebTree) failures.push('mixed-web-source-tree');
  if ((state.webStatusBefore ?? '').trim()) failures.push('dirty-web-source-before');
  if ((state.webStatusAfter ?? '').trim()) failures.push('dirty-web-source-after');
  if (!DIGEST.test(state.sourceHashBefore ?? '') || !DIGEST.test(state.sourceHashAfter ?? '')) failures.push('invalid-source-hash');
  else if (state.sourceHashBefore !== state.sourceHashAfter) failures.push('changed-web-source-during-tests');
  return failures;
}

function webDigest() {
  const paths = git('ls-files', '--cached', '--', 'web/').split('\n').filter(Boolean).sort();
  if (paths.length === 0) throw new Error('No tracked web source files');
  const digest = createHash('sha256');
  for (const path of paths) {
    digest.update(`${path}\0`);
    digest.update(readFileSync(new URL(`../../../${path}`, import.meta.url)));
    digest.update('\0');
  }
  return digest.digest('hex');
}

function reportTests(stdout) {
  const total = /^# tests (\d+)\s*$/m.exec(stdout);
  const passed = /^# pass (\d+)\s*$/m.exec(stdout);
  const failed = /^# fail (\d+)\s*$/m.exec(stdout);
  if (!total || !passed || !failed) throw new Error('Missing TAP test counts');
  return { total: Number(total[1]), passed: Number(passed[1]), failed: Number(failed[1]) };
}

export function runUiProvenance(expectedMainSha) {
  if (!SHA.test(expectedMainSha ?? '')) throw new Error('Supply an exact 40-character --main commit SHA');
  const currentMainSha = git('rev-parse', '--verify', 'upstream/main^{commit}');
  const checkoutWebTree = git('rev-parse', '--verify', 'HEAD:web');
  const mainWebTree = git('rev-parse', '--verify', `${expectedMainSha}:web`);
  const state = {
    expectedMainSha, currentMainSha, checkoutWebTree, mainWebTree,
    webStatusBefore: git('status', '--porcelain', '--', 'web/'),
    sourceHashBefore: webDigest(),
  };
  const preflight = validateUiProvenance({ ...state, webStatusAfter: '', sourceHashAfter: state.sourceHashBefore });
  if (preflight.length) return { verified: false, failures: preflight, state };

  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...DEFAULT_SUITES], {
    cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 10 * 1024 * 1024,
  });
  state.webStatusAfter = git('status', '--porcelain', '--', 'web/');
  state.sourceHashAfter = webDigest();
  const failures = validateUiProvenance(state);
  if (run.error || run.status !== 0) failures.push('ui-suite-failed-or-timed-out');
  let tests;
  try { tests = reportTests(run.stdout ?? ''); }
  catch { failures.push('missing-test-counts'); }
  if (tests && (!tests.total || tests.failed || tests.total !== tests.passed)) failures.push('ui-tests-not-all-passed');
  return {
    verified: failures.length === 0,
    failures, mainSha: expectedMainSha,
    webTreeSha: checkoutWebTree, beforeHash: state.sourceHashBefore,
    afterHash: state.sourceHashAfter, tests,
    scope: 'SOURCE_ONLY', browser: 'NOT_RUN', screenReader: 'NOT_RUN', physical: 'NOT_RUN',
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const sha = args.length === 2 && args[0] === '--main' ? args[1] : undefined;
  try {
    const result = runUiProvenance(sha);
    console.log(JSON.stringify(result, null, 2));
    if (!result.verified) process.exitCode = 1;
  } catch (error) {
    console.error(`UI_PROVENANCE_NOT_VERIFIED: ${error.message}`);
    process.exitCode = 1;
  }
}
