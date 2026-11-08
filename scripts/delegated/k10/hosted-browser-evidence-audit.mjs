#!/usr/bin/env node
/**
 * Read-only audit of CI source versus K10 browser acceptance claims.
 * GitHub's browser-live job name is not proof of a rendered K10 UI state.
 * No workflow, authorization or real device is modified by this script.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA = /^[a-f\d]{40}$/;
export const K10_EVIDENCE_PATHS = Object.freeze({
  baseline: 'test/delegated/k10/offline-web-smoke.test.mjs',
  sourceNegatives: 'test/delegated/k10/issue-browser-negative.test.mjs',
  pngContract: 'test/delegated/k10/issue-evidence-contract.test.mjs',
  visualCapture: 'scripts/delegated/k10/browser-visual-smoke.mjs',
  threeStateCapture: 'scripts/delegated/k10/hosted-connect-three-state.mjs',
});

function jobSection(workflow, name) {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^  [a-z][a-z\d_-]*:\s*(?:#.*)?$/.test(lines[index])) { end = index; break; }
  }
  return lines.slice(start + 1, end);
}

function runCommands(jobLines) {
  if (!jobLines) return [];
  const commands = [];
  for (let index = 0; index < jobLines.length; index++) {
    const match = /^(\s*)(?:-\s*)?run:\s*(.*?)\s*$/.exec(jobLines[index]);
    if (!match) continue;
    const indent = match[1].length;
    if (match[2] && !['|', '>', '|-', '>-'].includes(match[2])) {
      commands.push(match[2]);
      continue;
    }
    const lines = [];
    while (index + 1 < jobLines.length) {
      const next = jobLines[index + 1];
      const nextIndent = /^\s*/.exec(next)[0].length;
      if (next.trim() && nextIndent <= indent) break;
      index++;
      if (next.trim() && !next.trim().startsWith('#')) lines.push(next.trim());
    }
    commands.push(lines.join(' '));
  }
  return commands;
}

function invokesNodePath(commands, path) {
  return commands.some((command) => {
    // Recognize explicit node executions, not a comment, environment variable,
    // step name or echo mentioning a file. A workflow is still not execution proof.
    if (!/(?:^|[;&|]\s*)node(?:\.exe)?\s/.test(command)) return false;
    const index = command.indexOf(path);
    return index >= 0 && !/[\w./-]/.test(command[index - 1] ?? ' ') &&
      !/[\w./-]/.test(command[index + path.length] ?? ' ');
  });
}

export function auditHostedBrowserEvidence({ workflow, targetSha, runSha, jobs }) {
  const browser = runCommands(jobSection(workflow, 'browser-live'));
  const testJob = runCommands(jobSection(workflow, 'test'));
  const checks = {
    browserJobConfigured: Boolean(jobSection(workflow, 'browser-live')),
    baselineOfflineTestListed: invokesNodePath(testJob, K10_EVIDENCE_PATHS.baseline),
    issueNegativesListed: invokesNodePath(testJob, K10_EVIDENCE_PATHS.sourceNegatives),
    pngContractListed: invokesNodePath(testJob, K10_EVIDENCE_PATHS.pngContract),
    staticVisualCaptureListed: invokesNodePath(browser, K10_EVIDENCE_PATHS.visualCapture),
    threeStateCaptureListed: invokesNodePath(browser, K10_EVIDENCE_PATHS.threeStateCapture),
    genericBrowserTestListed: invokesNodePath(browser, 'test/browser-live.test.ts'),
  };
  const acceptedSha = typeof targetSha === 'string' && SHA.test(targetSha);
  const observedSha = typeof runSha === 'string' && SHA.test(runSha);
  const matchingHead = acceptedSha && observedSha && targetSha === runSha;
  const browserJob = Array.isArray(jobs) ? jobs.find((job) => job?.name === 'browser-live') : null;
  const browserJobSucceeded = browserJob?.status === 'completed' && browserJob?.conclusion === 'success';
  const reason = !acceptedSha || !observedSha ? 'MISSING_EXACT_SHA'
    : !matchingHead ? 'STALE_RUN_SHA'
    : !checks.browserJobConfigured ? 'BROWSER_JOB_MISSING'
    : !browserJobSucceeded ? 'BROWSER_JOB_NOT_SUCCESSFUL'
    : !checks.threeStateCaptureListed ? 'THREE_STATE_CAPTURE_NOT_IN_WORKFLOW'
    : 'CAPTURE_ARTIFACTS_NOT_PROVIDED';
  return {
    issue: 485,
    targetSha: acceptedSha ? targetSha : null,
    runSha: observedSha ? runSha : null,
    checks,
    browserJob: browserJob ? { name: 'browser-live', status: browserJob.status, conclusion: browserJob.conclusion } : null,
    status: reason === 'STALE_RUN_SHA' ? 'FAIL_STALE_SHA' : 'NOT_RUN',
    reason,
    realThreeStateScreenshots: 'NOT_VERIFIED',
    livePairing: 'NOT_RUN',
    physicalWindows: 'NOT_RUN',
    note: 'Workflow and job success cannot prove K10 screenshots, focus navigation, visual states or device pairing.',
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (flag) => { const index = args.indexOf(flag); return index < 0 ? null : args[index + 1]; };
  const path = option('--workflow');
  const targetSha = option('--target-sha');
  const runSha = option('--run-sha');
  if (!path) {
    process.stderr.write('Usage: node hosted-browser-evidence-audit.mjs --workflow ci.yml --target-sha <40-hex> --run-sha <40-hex>\n');
    process.exitCode = 2;
  } else {
    let workflow = '';
    try { workflow = readFileSync(path, 'utf8'); }
    catch { process.stderr.write('Workflow source unavailable; CI coverage NOT_RUN.\n'); process.exitCode = 2; }
    if (workflow) {
      const result = auditHostedBrowserEvidence({ workflow, targetSha, runSha, jobs: [] });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.status === 'FAIL_STALE_SHA' ? 1 : 2;
    }
  }
}
