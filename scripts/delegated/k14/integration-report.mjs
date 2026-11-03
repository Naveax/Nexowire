#!/usr/bin/env node
/**
 * Read-only, bounded GitHub integration inventory for fork-owned PRs.
 * No Git pushes, merges, approvals, branch updates or credential output.
 * Node >= 22, no third-party dependencies.
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const UPSTREAM = 'Naveax/Nexowire';
export const FORK = 'SinsiVinci/Nexowire-fork';

const SHA = /^[0-9a-f]{40}$/i;
const MAX_PAGES = 6;
const PAGE_SIZE = 100;

function assertSha(sha, context) {
  if (!SHA.test(sha ?? '')) throw new Error(`${context}: exact 40-character SHA required`);
  return sha;
}

export function classifySync(upstreamSha, forkSha, comparison) {
  assertSha(upstreamSha, 'upstream');
  assertSha(forkSha, 'fork');
  if (upstreamSha === forkSha) return 'IN_SYNC';
  if (!comparison || !Number.isInteger(comparison.ahead_by) || !Number.isInteger(comparison.behind_by)) return 'UNKNOWN';
  if (comparison.ahead_by < 0 || comparison.behind_by < 0) return 'UNKNOWN';
  if (comparison.ahead_by === 0 && comparison.behind_by > 0) return 'FORK_BEHIND_FAST_FORWARD_CANDIDATE';
  if (comparison.ahead_by > 0 && comparison.behind_by === 0) return 'FORK_AHEAD_NO_SYNC';
  if (comparison.ahead_by > 0 && comparison.behind_by > 0) return 'DIVERGED_NO_SYNC';
  return 'UNKNOWN';
}

export function fileOverlaps(prs) {
  const owners = new Map();
  for (const pr of prs) {
    for (const file of pr.files ?? []) {
      if (typeof file !== 'string') throw new TypeError('PR file path must be a string');
      const numbers = owners.get(file) ?? [];
      numbers.push(pr.number);
      owners.set(file, numbers);
    }
  }
  return [...owners].filter(([, numbers]) => numbers.length > 1)
    .map(([path, prs]) => ({ path, prs: [...new Set(prs)].sort((a, b) => a - b) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function classifyCi(prHead, runs) {
  assertSha(prHead, 'PR head');
  if (!Array.isArray(runs) || runs.length === 0) return 'UNVERIFIED_NO_RUN';
  const matching = runs.filter(run => run.head_sha === prHead);
  if (matching.length !== runs.length) return 'UNVERIFIED_WRONG_SHA';
  if (matching.some(run => run.conclusion === 'action_required' && (!Array.isArray(run.jobs) || run.jobs.length === 0))) return 'ACTION_REQUIRED_EMPTY_JOBS';
  if (matching.some(run => !Array.isArray(run.jobs) || run.jobs.length === 0)) return 'UNVERIFIED_EMPTY_JOBS';
  if (matching.some(run => run.status !== 'completed')) return 'PENDING';
  if (matching.some(run => run.conclusion !== 'success' || run.jobs.some(job => job.conclusion !== 'success'))) return 'NON_GREEN';
  return 'OBSERVED_GREEN_JOBS_NOT_MERGE_APPROVAL';
}

export function buildReport(input) {
  const { upstreamSha, forkSha, comparison, prs } = input;
  const sync = classifySync(upstreamSha, forkSha, comparison);
  const cleanPrs = prs.map(pr => {
    const touched = [...new Set(pr.files ?? [])].sort();
    const mainChanged = pr.mainComparisonComplete === true && Array.isArray(pr.mainChangedPaths)
      ? touched.filter(path => pr.mainChangedPaths.includes(path)) : null;
    const ci = pr.ci === undefined ? 'NOT_CHECKED' : classifyCi(pr.head, pr.ci);
    return {
      number: pr.number,
      title: pr.title,
      draft: Boolean(pr.draft),
      author: pr.author,
      head: assertSha(pr.head, `PR #${pr.number}`),
      headRepo: pr.headRepo,
      files: touched,
      filesComplete: pr.filesComplete === true,
      base: pr.base,
      mainPathOverlap: mainChanged,
      ci,
      ciJobGate: ci === 'OBSERVED_GREEN_JOBS_NOT_MERGE_APPROVAL' ? 'OBSERVED_GREEN' : 'BLOCKED_OR_UNVERIFIED',
      mergeReady: false, // Reviews, branch protection and physical acceptance are not inspected here.
    };
  }).sort((a, b) => a.number - b.number);
  return { source: 'GitHub REST, read-only; snapshot only', upstreamSha, forkSha, sync,
    scope: 'Open fork-head PRs only; not all upstream PRs',
    prs: cleanPrs, overlaps: fileOverlaps(cleanPrs),
    mergeDecision: 'NOT_AUTHORIZED: exact-head CI, reviews, protection, ownership and live test gates require independent verification',
  };
}

export function markdownReport(report) {
  const lines = [
    '# Read-only fork integration snapshot', '',
    `- Upstream main: \`${report.upstreamSha}\``,
    `- Fork main: \`${report.forkSha}\``,
    `- Sync: **${report.sync}** (no branch was modified)`,
    `- Scope: ${report.scope}`,
    `- Merge: ${report.mergeDecision}`, '',
    '| PR | Owner | Exact HEAD | Files | CI | Job gate | Main path overlap |',
    '| --- | --- | --- | ---: | --- | --- | --- |',
  ];
  for (const pr of report.prs) {
    const overlap = pr.mainPathOverlap === null ? 'UNKNOWN' : (pr.mainPathOverlap.join(', ') || 'none');
    lines.push(`| #${pr.number}${pr.draft ? ' (draft)' : ''} | ${pr.author} | \`${pr.head}\` | ${pr.files.length}${pr.filesComplete ? '' : '+'} | ${pr.ci} | ${pr.ciJobGate} | ${overlap} |`);
  }
  lines.push('', '## Same-path conflicts within selected PRs', '');
  lines.push(...(report.overlaps.length ? report.overlaps.map(item => `- \`${item.path}\`: ${item.prs.map(n => `#${n}`).join(' / ')}`) : ['- None observed among the completely fetched file lists.']));
  lines.push('', '## Evidence limits', '',
    '- Main path overlap compares each PR base SHA to the observed upstream main SHA, not just the fork main.',
    '- Same-path absence does not prove merge safety; semantic conflicts and stacked PRs require separate review.',
    '- `files+` denotes a truncated file inventory. No overlap claim is conclusive when any list is truncated.',
    '- CI NOT_CHECKED / UNVERIFIED / PENDING / NON_GREEN is never PASS.',
    '- Static reports are not real Windows, two-PC, Cloudflare, billing or release acceptance.', '');
  return lines.join('\n');
}

export function apiRequester(token = process.env.GITHUB_TOKEN) {
  return async path => {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`GitHub REST ${response.status} at ${path.split('?')[0]}`);
    return response.json();
  };
}

async function collectPages(get, path, maxPages = MAX_PAGES, arrayKey = null) {
  const out = [];
  let complete = false;
  for (let page = 1; page <= maxPages; page++) {
    const join = path.includes('?') ? '&' : '?';
    const raw = await get(`${path}${join}per_page=${PAGE_SIZE}&page=${page}`);
    const batch = arrayKey ? raw?.[arrayKey] : raw;
    if (!Array.isArray(batch)) throw new Error('Expected a paginated JSON array');
    out.push(...batch);
    if (batch.length < PAGE_SIZE) { complete = true; break; }
  }
  return { items: out, complete };
}

export async function collectSnapshot(get, { includeCi = false, onlyNumbers = null } = {}) {
  const [upstream, fork, pulls] = await Promise.all([
    get(`/repos/${UPSTREAM}/branches/main`),
    get(`/repos/${FORK}/branches/main`),
    collectPages(get, `/repos/${UPSTREAM}/pulls?state=open`),
  ]);
  if (!pulls.complete) throw new Error('PR listing incomplete; refusing a misleading full-fork inventory');
  const upstreamSha = assertSha(upstream.commit?.sha, 'upstream main');
  const forkSha = assertSha(fork.commit?.sha, 'fork main');
  let comparison = null;
  if (upstreamSha !== forkSha) {
    try { comparison = await get(`/repos/${FORK}/compare/${upstreamSha}...${forkSha}`); }
    catch { comparison = null; } // Missing upstream commit in fork is UNKNOWN, never sync.
  }
  const selected = pulls.items.filter(pr => pr.head?.repo?.full_name === FORK && (onlyNumbers === null || onlyNumbers.includes(pr.number)));
  const mainChangesByBase = new Map();
  for (const base of [...new Set(selected.map(pr => pr.base?.sha))]) {
    if (!SHA.test(base ?? '')) { mainChangesByBase.set(base, null); continue; }
    if (base === upstreamSha) { mainChangesByBase.set(base, []); continue; }
    try {
      const delta = await get(`/repos/${UPSTREAM}/compare/${base}...${upstreamSha}`);
      mainChangesByBase.set(base, delta.status === 'ahead' && delta.behind_by === 0 && Array.isArray(delta.files) && delta.files.length < 300
        ? delta.files.map(file => file.filename) : null);
    } catch { mainChangesByBase.set(base, null); } // Cannot conclude path safety.
  }
  const prs = await Promise.all(selected.map(async pr => {
    const files = await collectPages(get, `/repos/${UPSTREAM}/pulls/${pr.number}/files`, 3);
    const item = {
      number: pr.number, title: pr.title, author: pr.user?.login ?? 'UNKNOWN', draft: pr.draft,
      head: pr.head.sha, headRepo: pr.head.repo.full_name, base: pr.base?.sha,
      files: files.items.map(file => file.filename), filesComplete: files.complete,
      mainChangedPaths: mainChangesByBase.get(pr.base?.sha),
      mainComparisonComplete: Array.isArray(mainChangesByBase.get(pr.base?.sha)),
    };
    if (includeCi) {
      const runs = await collectPages(get, `/repos/${UPSTREAM}/actions/runs?head_sha=${pr.head.sha}`, 2, 'workflow_runs');
      if (!runs.complete) throw new Error(`CI listing incomplete for #${pr.number}`);
      item.ci = await Promise.all(runs.items.map(async run => {
        const jobs = await collectPages(get, `/repos/${UPSTREAM}/actions/runs/${run.id}/jobs`, 3, 'jobs');
        if (!jobs.complete) throw new Error(`CI jobs incomplete for run ${run.id}`);
        return { head_sha: run.head_sha, status: run.status, conclusion: run.conclusion, jobs: jobs.items };
      }));
    }
    return item;
  }));
  // Open PRs may be amended while their file lists/runs are fetched.
  // Fail the whole snapshot instead of presenting mixed-SHA evidence.
  const fresh = await Promise.all(selected.map(pr => get(`/repos/${UPSTREAM}/pulls/${pr.number}`)));
  for (let i = 0; i < selected.length; i++) {
    if (fresh[i].head?.sha !== selected[i].head.sha || fresh[i].base?.sha !== selected[i].base?.sha) {
      throw new Error(`PR #${selected[i].number} changed HEAD/base during inspection; retry`);
    }
  }
  return buildReport({ upstreamSha, forkSha, comparison, prs });
}

async function main(args) {
  let report;
  const fixtureIndex = args.indexOf('--offline');
  if (fixtureIndex !== -1) {
    if (!args[fixtureIndex + 1]) throw new Error('--offline requires JSON file');
    report = buildReport(JSON.parse(await readFile(args[fixtureIndex + 1], 'utf8')));
  } else {
    const includeCi = args.includes('--ci');
    const numbersIndex = args.indexOf('--numbers');
    const onlyNumbers = numbersIndex < 0 ? null : (args[numbersIndex + 1] ?? '').split(',').map(Number);
    if (onlyNumbers && onlyNumbers.some(n => !Number.isSafeInteger(n) || n < 1)) throw new Error('Invalid PR number list');
    report = await collectSnapshot(apiRequester(), { includeCi, onlyNumbers });
  }
  process.stdout.write(args.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : markdownReport(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error(`Read-only report failed: ${error.message}`); process.exitCode = 1; });
}
