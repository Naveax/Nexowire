#!/usr/bin/env node
// #539 / T-382: a source-only gate for four delegated UI suites at one Git HEAD.
// It never starts a server, agent, browser or external account connection.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const UI_SUITES = Object.freeze([
  { id: 'K01', file: 'test/delegated/k01/connect-state.test.ts', count: 13 },
  { id: 'K02', file: 'test/delegated/k02/responsive-css.test.ts', count: 17 },
  { id: 'K03', file: 'test/delegated/k03/panel-states.test.mjs', count: 13 },
  { id: 'K04', file: 'test/delegated/k04/admin-a11y.test.mjs', count: 13 },
]);

export function parseTestSummary(output) {
  const fields = {};
  for (const match of String(output).matchAll(/^(?:ℹ|#)\s*(tests|pass|fail|skipped|todo)\s+(\d+)\s*$/gm)) {
    fields[match[1]] = Number(match[2]);
  }
  return fields;
}

export function validateEvidence({ before, after, cleanBefore, cleanAfter, records }) {
  const issues = [];
  if (!/^[0-9a-f]{40}$/.test(before || '')) issues.push('missing-exact-head');
  if (before !== after) issues.push('head-changed-during-tests');
  if (!cleanBefore || !cleanAfter) issues.push('dirty-worktree');
  if (!Array.isArray(records)) return { ok: false, issues: [...issues, 'missing-test-records'] };

  for (const suite of UI_SUITES) {
    const matches = records.filter((row) => row.id === suite.id);
    if (matches.length !== 1) {
      issues.push(`${suite.id}:missing-or-duplicate`);
      continue;
    }
    const row = matches[0];
    if (row.head !== before || row.afterHead !== before) issues.push(`${suite.id}:different-head`);
    if (row.path !== suite.file) issues.push(`${suite.id}:unexpected-path`);
    if (row.exitCode !== 0) issues.push(`${suite.id}:failed-or-not-run`);
    const { tests, pass, fail, skipped, todo } = row.summary || {};
    if (tests !== suite.count || pass !== suite.count || fail !== 0 ||
        skipped !== 0 || todo !== 0) issues.push(`${suite.id}:incomplete-tap`);
  }
  if (records.length !== UI_SUITES.length) issues.push('unexpected-suite-count');
  return { ok: issues.length === 0, issues, head: before,
    suiteCount: UI_SUITES.length, expectedTests: UI_SUITES.reduce((sum, s) => sum + s.count, 0) };
}

function command(file, args, cwd, timeout = 120000) {
  const result = spawnSync(file, args, {
    cwd, encoding: 'utf8', shell: false, timeout, maxBuffer: 12 * 1024 * 1024,
  });
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '',
    error: result.error?.message };
}

function git(cwd, args) {
  const result = command('git', args, cwd, 10000);
  if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr || result.error || result.code}`);
  return result.stdout.trim();
}

export function runSingleHeadCheck(cwd = process.cwd()) {
  const missing = UI_SUITES.filter((suite) => !existsSync(resolve(cwd, suite.file)))
    .map((suite) => suite.file);
  if (missing.length) return { status: 'NOT_RUN', reason: 'missing-ui-test-files', missing };

  const before = git(cwd, ['rev-parse', 'HEAD']);
  const cleanBefore = git(cwd, ['status', '--porcelain', '--untracked-files=all']) === '';
  if (!cleanBefore) return { status: 'NOT_RUN', reason: 'dirty-worktree', head: before };

  const records = [];
  for (const suite of UI_SUITES) {
    // Require the file in HEAD, not merely an untracked local test fixture.
    git(cwd, ['ls-files', '--error-unmatch', suite.file]);
    const result = command(process.execPath, ['--import', 'tsx', suite.file], cwd);
    const summary = parseTestSummary(result.stdout + '\n' + result.stderr);
    records.push({ id: suite.id, path: suite.file, head: before,
      afterHead: git(cwd, ['rev-parse', 'HEAD']), exitCode: result.code, summary,
      error: result.error });
    // Do not continue into another suite after a failure or missing summary.
    if (result.code !== 0 || summary.tests === undefined || (summary.fail ?? 1) !== 0) break;
  }
  const after = git(cwd, ['rev-parse', 'HEAD']);
  const cleanAfter = git(cwd, ['status', '--porcelain', '--untracked-files=all']) === '';
  const validation = validateEvidence({ before, after, cleanBefore, cleanAfter, records });
  return { status: validation.ok ? 'PASS_SOURCE_ONLY' : 'FAIL', ...validation, records };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = runSingleHeadCheck(process.argv[2] ? resolve(process.argv[2]) : process.cwd());
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === 'PASS_SOURCE_ONLY' ? 0 : result.status === 'NOT_RUN' ? 2 : 1;
  } catch (error) {
    console.error('FAIL:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
