import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export function collectTests(root) {
  const result = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && /\.test\.(ts|mjs)$/.test(entry.name)) {
        result.push(relative(root, full).split(sep).join('/'));
      }
    }
  }
  visit(join(root, 'test/delegated'));
  return result.sort();
}

export function sourceInventory(paths, ciYaml, npmTest) {
  const activeCi = ciYaml.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n');
  const k20Glob = activeCi.includes('test/delegated/k20/*.test.mjs');
  const npmGlob = /(?:^|\s)test\/\*\*\/\*\.test\.ts(?:\s|$)/.test(npmTest);
  const rows = [...paths].sort().map(path => {
    const explicit = activeCi.includes(path) || k20Glob && /^test\/delegated\/k20\/[^/]+\.test\.mjs$/.test(path);
    const npmDirect = npmGlob && /^test\/[^/]+\/[^/]+\.test\.ts$/.test(path);
    return { path, source: explicit ? 'EXPLICIT_CI_SOURCE' :
      npmDirect ? 'ONE_DIRECTORY_NPM_GLOB' : 'NO_KNOWN_INVOCATION' };
  });
  return {
    evidence: 'SOURCE_ONLY_NOT_EXECUTION_PROOF',
    total: rows.length,
    explicit: rows.filter(x => x.source === 'EXPLICIT_CI_SOURCE').length,
    npmDirect: rows.filter(x => x.source === 'ONE_DIRECTORY_NPM_GLOB').length,
    missing: rows.filter(x => x.source === 'NO_KNOWN_INVOCATION').map(x => x.path),
    physical: 'NOT_RUN',
  };
}

// A green TAP process can still fail a workflow's fixed-count grep check.
// This parser keeps assertion health and workflow acceptance as separate facts.
export function assessTap(tap, hardcodedCount = null) {
  const number = label => {
    const lines = [...tap.matchAll(new RegExp(`^# ${label} (\\d+)\\s*$`, 'gm'))];
    return lines.length === 1 ? Number(lines[0][1]) : null;
  };
  const counts = {
    tests: number('tests'), pass: number('pass'), fail: number('fail'),
    cancelled: number('cancelled'), skipped: number('skipped'), todo: number('todo'),
  };
  const assertions = Object.values(counts).every(Number.isSafeInteger) &&
    counts.tests > 0 && counts.tests === counts.pass &&
    counts.fail === 0 && counts.cancelled === 0 && counts.skipped === 0 && counts.todo === 0 ? 'PASS' : 'NOT_PASS';
  const fixedGate = hardcodedCount === null ? 'NOT_APPLICABLE' :
    !Number.isSafeInteger(hardcodedCount) || counts.tests !== hardcodedCount ||
      counts.pass !== hardcodedCount ? 'FAIL_COUNT_MISMATCH' : 'PASS';
  return {
    counts, assertions, fixed_gate: fixedGate,
    job_acceptance: assertions === 'PASS' && (fixedGate === 'PASS' || fixedGate === 'NOT_APPLICABLE') ? 'PASS' : 'NOT_PASS',
  };
}

// Source PR execution is distinct from the workflow run that checked out that
// source. Pinned auxiliary checkouts never become required PR checks by proxy.
export function classifyHostedEvidence({
  prHead, runHead, runEvent, runId, workflowName, runStatus, runConclusion,
  checkoutHead, required, selectedFiles, observedFiles, jobs, totalJobs,
}) {
  const knownSha = value => /^[0-9a-f]{40}$/i.test(value ?? '');
  const base = { required_pr_ci: 'NOT_PROVEN', selected_test_execution: 'NOT_PROVEN', physical_device: 'NOT_RUN' };
  if (!knownSha(prHead) || !knownSha(runHead) || !knownSha(checkoutHead) || checkoutHead !== prHead) {
    return { ...base, reason: 'SOURCE_SHA_MISMATCH' };
  }
  if (!Number.isSafeInteger(runId) || runId <= 0 ||
    runStatus !== 'completed' || runConclusion !== 'success' ||
    !Array.isArray(jobs) || jobs.length === 0 || totalJobs !== jobs.length ||
    jobs.some(job => job.run_id !== runId || job.status !== 'completed' || job.conclusion !== 'success')) {
    return { ...base, reason: 'JOB_NOT_SUCCESS' };
  }
  if (!Array.isArray(selectedFiles) || !selectedFiles.length || !Array.isArray(observedFiles) ||
    !selectedFiles.every(path => observedFiles.includes(path))) {
    return { ...base, reason: 'SELECTED_TEST_EXECUTION_UNVERIFIED' };
  }
  if (runHead !== prHead || runEvent !== 'pull_request' || workflowName !== 'CI' || !required ||
    !['test (22)', 'test (24)', 'browser-live'].every(name =>
      jobs.filter(job => job.name === name).length === 1)) {
    return { ...base, selected_test_execution: 'AUXILIARY_ONLY', reason: 'DIFFERENT_RUN_HEAD_OR_EVENT' };
  }
  return { ...base, required_pr_ci: 'PASS', selected_test_execution: 'HOSTED_EXECUTED', reason: 'PR_HEAD_AND_TEST_SELECTION_PROVEN' };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args[0] === '--tap' && args[1]) {
    const result = assessTap(readFileSync(resolve(args[1]), 'utf8'));
    console.log(JSON.stringify(result, null, 2));
    if (result.job_acceptance !== 'PASS') process.exitCode = 1;
  } else if (args[0] === '--inventory') {
    const root = resolve(args[1] ?? '.');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    console.log(JSON.stringify({ checkout_sha: process.env.GITHUB_SHA ?? 'UNKNOWN',
      ...sourceInventory(collectTests(root), ci, pkg.scripts.test) }, null, 2));
  } else {
    console.error('Usage: p006-ci-gates.mjs --inventory [ROOT] | --tap TAP_FILE');
    process.exitCode = 2;
  }
}
