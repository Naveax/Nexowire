#!/usr/bin/env node
/** Bounded, read-only exact-head PR diff/CI acceptance evidence. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { classifyCi } from '../k14/integration-report.mjs';

const SHA = /^[a-f0-9]{40}$/i;
const REPO = /^[a-z\d_.-]+\/[a-z\d_.-]+$/i;

export function sensitivePath(path) {
  // Conservative ownership/risk flag, not a complete security classifier.
  return /^(?:\.github\/|src\/(?:core|security)\/|src\/agent\/(?:native-agent|operation-journal|privileged-broker|guardian)|src\/(?:hub|mcp|product)\/.*(?:auth|oauth|token|session)|native\/|installers\/)/i.test(path)
    || /(?:^|\/)(?:secrets?|credentials?)(?:\/|\.|-)/i.test(path);
}

function assertPr(pr) {
  if (!Number.isSafeInteger(pr?.number) || pr.number <= 0 || !SHA.test(pr?.head?.sha ?? '') || !SHA.test(pr?.base?.sha ?? '')) {
    throw new Error('Invalid or incomplete PR number/head/base snapshot');
  }
}

export function summarize(input) {
  const { before, after, files, filesComplete, runs, runsComplete, jobsComplete } = input;
  assertPr(before);
  assertPr(after);
  const stable = before.number === after.number && before.head.sha === after.head.sha && before.base.sha === after.base.sha;
  const changed = [...new Set(files.map(file => file.filename))].sort();
  const restricted = changed.filter(sensitivePath);
  const ci = !stable ? 'HEAD_CHANGED_RETRY' : (!runsComplete || !jobsComplete ? 'UNVERIFIED_INCOMPLETE_PAGINATION' : classifyCi(before.head.sha, runs));
  return {
    number: before.number,
    title: before.title,
    head: before.head.sha,
    base: before.base.sha,
    stableExactHead: stable,
    state: after.state,
    draft: Boolean(after.draft),
    mergeable: after.mergeable ?? null,
    fileCount: changed.length,
    files: changed,
    filesComplete,
    flaggedPaths: restricted,
    ci,
    review: 'NOT_CHECKED',
    acceptance: 'NOT_APPROVED_FOR_MERGE',
    reasons: [
      ...(stable ? [] : ['PR HEAD/base changed during inspection']),
      ...(filesComplete ? [] : ['Truncated diff file list']),
      ...(restricted.length ? ['Ownership/security-sensitive paths need owner review'] : []),
      ...(after.state === 'open' ? [] : ['PR is not open']),
      ...(after.draft ? ['Draft PR'] : []),
      ...(ci === 'OBSERVED_GREEN_JOBS_NOT_MERGE_APPROVAL' ? [] : [`CI: ${ci}`]),
      'Reviews, branch protection and hardware/real-provider gates NOT_CHECKED',
    ],
  };
}

export function markdown(summary) {
  return [
    `# PR #${summary.number} — read-only acceptance evidence`, '',
    `- HEAD: \`${summary.head}\``,
    `- Base SHA: \`${summary.base}\``,
    `- Stable across two PR reads: ${summary.stableExactHead}`,
    `- State/draft/mergeable: ${summary.state} / ${summary.draft} / ${summary.mergeable ?? 'UNKNOWN'}`,
    `- Files: ${summary.fileCount}${summary.filesComplete ? '' : '+ (incomplete)'}`,
    `- Flagged paths: ${summary.flaggedPaths.length ? summary.flaggedPaths.join(', ') : 'none observed'}`,
    `- CI: **${summary.ci}**`,
    `- Review: ${summary.review}`, `- Merge decision: **${summary.acceptance}**`, '',
    '## Changed paths', '',
    ...summary.files.map(path => `- \`${path}\``), '',
    '## Outstanding checks', '', ...summary.reasons.map(reason => `- ${reason}`), '',
  ].join('\n');
}

async function pages(get, path, field, maxPages = 3) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const raw = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const list = field ? raw?.[field] : raw;
    if (!Array.isArray(list)) throw new Error(`Unexpected array in ${path}`);
    out.push(...list);
    if (list.length < 100) return { items: out, complete: true };
  }
  return { items: out, complete: false };
}

export async function inspect(get, repository, number) {
  if (!REPO.test(repository) || !Number.isSafeInteger(number) || number < 1) throw new Error('Invalid repository or PR number');
  const root = `/repos/${repository}`;
  const before = await get(`${root}/pulls/${number}`);
  assertPr(before);
  const [files, workflowRuns] = await Promise.all([
    pages(get, `${root}/pulls/${number}/files`, null),
    pages(get, `${root}/actions/runs?head_sha=${before.head.sha}`, 'workflow_runs', 2),
  ]);
  let jobsComplete = true;
  const runs = await Promise.all(workflowRuns.items.map(async run => {
    const jobs = await pages(get, `${root}/actions/runs/${run.id}/jobs`, 'jobs');
    if (!jobs.complete) jobsComplete = false;
    return { head_sha: run.head_sha, status: run.status, conclusion: run.conclusion, jobs: jobs.items };
  }));
  const after = await get(`${root}/pulls/${number}`);
  return summarize({ before, after, files: files.items, filesComplete: files.complete,
    runs, runsComplete: workflowRuns.complete, jobsComplete });
}

async function main(args) {
  const offlineIndex = args.indexOf('--offline');
  let result;
  if (offlineIndex >= 0) {
    if (!args[offlineIndex + 1]) throw new Error('--offline requires path');
    result = summarize(JSON.parse(await readFile(args[offlineIndex + 1], 'utf8')));
  } else {
    const repoIndex = args.indexOf('--repo');
    const prIndex = args.indexOf('--pr');
    const repo = repoIndex >= 0 ? args[repoIndex + 1] : 'Naveax/Nexowire';
    const num = Number(prIndex >= 0 ? args[prIndex + 1] : null);
    const token = process.env.GITHUB_TOKEN;
    result = await inspect(async path => {
      const response = await fetch(`https://api.github.com${path}`, {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(`GitHub REST ${response.status} (${path.split('?')[0]})`);
      return response.json();
    }, repo, num);
  }
  process.stdout.write(args.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : markdown(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error(`PR report failed: ${error.message}`); process.exitCode = 1; });
}
