#!/usr/bin/env node
/** Offline, fail-closed triage of GitHub's /issues API JSON; no API calls or writes. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// A specific issue only suggests a non-core *slice*, not permission to alter its core work.
// A parent/umbrella issue is never counted as a second independent task.
const REVIEWED = new Map([
  [1006, ['release-gate', 'blocked', 'P0 release, CI approval and CORE integration are owner-gated']],
  [1001, ['journal-owner', 'blocked', 'Native journal ownership and process identity are CORE']],
  [974, ['journal-wal', 'blocked', 'WAL durability and installed-Agent restart are CORE']],
  [812, ['status-ux', 'candidate', 'Read-only status terminology QA only; authorization is CORE', 'K15 T-085–T-090']],
  [780, ['coding-agent', 'candidate', 'Reviewed-diff UX acceptance notes only; sandbox/Git authority is CORE', 'unassigned: request ŞEF scope']],
  [617, ['admin-bridge', 'blocked', 'Elevated Windows/Hyper-V control is CORE']],
  [588, ['file-ux', 'candidate', 'Offline transfer progress/error QA only; streaming/auth is CORE', 'K19 T-109–T-114']],
  [587, ['journal-rollback', 'blocked', 'Anti-replay and independent journal authority are CORE']],
  [540, ['process-manager', 'blocked', 'Process lifecycle, termination and ownership require CORE review']],
  [539, ['reliability', 'umbrella', 'Umbrella tracker; inspect individual work, do not create duplicate issue work']],
  [487, ['scale-cost', 'candidate', 'Offline measurement and truthful UNKNOWN reports only', 'K11 T-061–T-066; K12 T-067–T-072; K18 T-103–T-108']],
  [486, ['billing', 'blocked', 'Subscription and entitlement implementation is protected billing/auth']],
  [485, ['onboarding', 'candidate', 'Offline onboarding/recovery instructions only; pairing and installer are CORE', 'K06 T-031–T-036']],
  [484, ['quota', 'blocked', 'Quota identity, enforcement and migration are protected auth/billing']],
  [482, ['scale', 'umbrella', 'S1–S5 planning parent; child issue slices take precedence']],
  [481, ['handoff', 'umbrella', 'Parked-work handoff/index; not independent implementation permission']],
  [402, ['ai-screen', 'blocked', 'Private desktop and input isolation are critical control surfaces']],
  [323, ['admin-bridge', 'blocked', 'Broker device apply and acknowledgements are CORE']],
  [322, ['core-access', 'blocked', 'Persistent CORE grant and approval are protected']],
  [271, ['stack-acl', 'blocked', 'Privileged runtime ACLs require owner and Windows acceptance']],
  [269, ['onboarding', 'candidate', 'Signed bootstrap user guidance only; native installer/release is protected', 'K06 T-031–T-036']],
  [265, ['mcp-router', 'blocked', 'Live Hub rollout and owner-bound routing are protected']],
  [260, ['admin-bridge', 'blocked', 'Privileged Broker and installed Stack upgrade are CORE']],
]);

export function triage(pages) {
  if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) {
    throw new TypeError('Expected a JSON array of GitHub issue-page arrays');
  }
  const byNumber = new Map();
  let pullRequests = 0;
  let duplicates = 0;
  for (const page of pages) {
    for (const item of page) {
      if (!item || !Number.isSafeInteger(item.number) || item.number < 1 ||
          typeof item.title !== 'string' || typeof item.html_url !== 'string' ||
          !/^https:\/\/github\.com\/Naveax\/Nexowire\/issues\/\d+$/.test(item.html_url)) {
        // A PR also appears under /issues, but its link is /pull/: never admit one.
        if (item?.pull_request && Number.isSafeInteger(item.number)) { pullRequests++; continue; }
        throw new TypeError('Malformed or foreign issue record');
      }
      if (item.pull_request) { pullRequests++; continue; }
      if (byNumber.has(item.number)) { duplicates++; continue; }
      byNumber.set(item.number, item);
    }
  }
  const issues = [...byNumber.values()].sort((a, b) => b.number - a.number).map(item => {
    const [topic, disposition, boundary, coverage = '—'] = REVIEWED.get(item.number) ||
      ['unreviewed', 'review', 'Unknown issue: manually verify scope before assigning'];
    return { number: item.number, title: item.title, url: item.html_url,
      topic, disposition, boundary, coverage };
  });
  const candidates = issues.filter(x => x.disposition === 'candidate');
  const byTopic = new Map();
  for (const candidate of candidates) {
    const list = byTopic.get(candidate.topic) || [];
    list.push(candidate);
    byTopic.set(candidate.topic, list);
  }
  return {
    totalRecords: pages.reduce((n, p) => n + p.length, 0),
    pullRequestsExcluded: pullRequests,
    duplicateIssuesExcluded: duplicates,
    issueCount: issues.length,
    candidates,
    candidateGroups: [...byTopic].map(([topic, issueRefs]) => ({ topic, issueRefs,
      coverage: [...new Set(issueRefs.map(x => x.coverage))].join('; '),
      boundaries: [...new Set(issueRefs.map(x => x.boundary))] })),
    blocked: issues.filter(x => x.disposition === 'blocked'),
    umbrellas: issues.filter(x => x.disposition === 'umbrella'),
    needsReview: issues.filter(x => x.disposition === 'review'),
  };
}

export function markdown(result) {
  const lines = [
    '# Open-issue non-core triage (offline snapshot)',
    '',
    `Issues: ${result.issueCount}; excluded PR entries: ${result.pullRequestsExcluded}; repeated issue entries: ${result.duplicateIssuesExcluded}.`,
    `Non-core candidate slices (de-duplicated by topic): ${result.candidateGroups.length} from ${result.candidates.length} issue references.`,
    'Candidate means a **read-only/non-core subset**, not that the parent issue is resolved or implementation authorized.',
    '',
    '| Issue | Non-core slice | Existing assignment / next decision |',
    '| --- | --- | --- |',
  ];
  for (const group of result.candidateGroups) {
    // Escaping is needed because source titles/labels may contain Markdown syntax.
    const safe = s => s.replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
    const refs = group.issueRefs.map(x => `[#${x.number}](${x.url})`).join(', ');
    lines.push(`| ${refs} | ${safe(group.boundaries.join('; '))} | ${safe(group.coverage)} |`);
  }
  lines.push('', `Blocked CORE/billing/release issues: ${result.blocked.length}.`,
    `Umbrella/index issues (not separate tasks): ${result.umbrellas.length}.`,
    `Unreviewed issues (no automatic ownership): ${result.needsReview.length}.`, '');
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 2 || (args[0] !== '--input' && args.length !== 0)) {
    throw new Error('Usage: node triage-open-issues.mjs [--input issue-pages.json]; stdin otherwise');
  }
  let data;
  if (args.length) data = readFileSync(args[1], 'utf8');
  else {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    data = Buffer.concat(chunks).toString('utf8');
  }
  const parsed = JSON.parse(data);
  const pages = Array.isArray(parsed) && parsed.every(x => Array.isArray(x)) ? parsed : [parsed];
  process.stdout.write(markdown(triage(pages)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(`K20 triage: ${err.message}`); process.exitCode = 1; });
}
