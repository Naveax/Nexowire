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
  [780, ['coding-agent', 'umbrella', 'Product epic: individual sandbox/Git/checkpoint requirements need their own evidence']],
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
]);

// Reviewed against the 22 actual open /issues records on 2026-11-07. These
// classifications describe issue lineage and severity, NOT completion or
// permission to work on a protected implementation. An unknown issue fails
// closed into "review" instead of inheriting a nearby issue's classification.
const ISSUE_LINEAGE = new Map([
  [1006, ['standalone', 'P0']], [1001, ['standalone', 'P0']],
  [974, ['standalone', 'P0']], [812, ['standalone', 'unspecified']],
  [780, ['umbrella', 'P1']], [617, ['standalone', 'P0']],
  [588, ['standalone', 'P1']], [587, ['standalone', 'P0']],
  [540, ['subtask', 'P1', 539, 'R07']], [539, ['umbrella', 'mixed']],
  [487, ['subtask', 'P0', 482, 'S5']], [486, ['subtask', 'P0', 482, 'S4']],
  [485, ['subtask', 'P0', 482, 'S3']], [484, ['subtask', 'P0', 482, 'S2']],
  [482, ['umbrella', 'P0']], [481, ['umbrella', 'index']],
  [402, ['standalone', 'P0']], [323, ['standalone', 'P0']],
  [322, ['standalone', 'P0']], [271, ['standalone', 'P0']],
  [269, ['standalone', 'P4']], [265, ['standalone', 'P2']],
]);

export function triage(pages) {
  if (!Array.isArray(pages) || pages.some(page => !Array.isArray(page))) {
    throw new TypeError('Expected a JSON array of GitHub issue-page arrays');
  }
  const byNumber = new Map();
  let pullRequests = 0;
  let duplicates = 0;
  let closedIssues = 0;
  for (const page of pages) {
    for (const item of page) {
      if (!item || !Number.isSafeInteger(item.number) || item.number < 1 ||
          typeof item.title !== 'string' || typeof item.html_url !== 'string' ||
          item.html_url !== `https://github.com/Naveax/Nexowire/issues/${item.number}`) {
        // A PR also appears under /issues, but its link is /pull/: never admit one.
        if (item?.pull_request && Number.isSafeInteger(item.number)) { pullRequests++; continue; }
        throw new TypeError('Malformed or foreign issue record');
      }
      if (item.pull_request) { pullRequests++; continue; }
      if (item.state === 'closed') { closedIssues++; continue; }
      if (item.state !== undefined && item.state !== 'open') {
        throw new TypeError('Issue state must be open or closed');
      }
      if (byNumber.has(item.number)) { duplicates++; continue; }
      byNumber.set(item.number, item);
    }
  }
  const issues = [...byNumber.values()].sort((a, b) => b.number - a.number).map(item => {
    const [topic, disposition, boundary, coverage = '—'] = REVIEWED.get(item.number) ||
      ['unreviewed', 'review', 'Unknown issue: manually verify scope before assigning'];
    const [kind = 'unreviewed', priority = 'unreviewed', parentIssue = null, parentSlice = null] =
      ISSUE_LINEAGE.get(item.number) || [];
    return { number: item.number, title: item.title, url: item.html_url,
      topic, disposition, boundary, coverage, kind, priority, parentIssue,
      parentSlice, onHold: item.number === 271 };
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
    closedIssuesExcluded: closedIssues,
    issueCount: issues.length,
    issues,
    byKind: {
      standalone: issues.filter(x => x.kind === 'standalone'),
      subtask: issues.filter(x => x.kind === 'subtask'),
      umbrella: issues.filter(x => x.kind === 'umbrella'),
      unreviewed: issues.filter(x => x.kind === 'unreviewed'),
    },
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
    `Closed issue entries excluded: ${result.closedIssuesExcluded}.`,
    `Lineage: ${result.byKind.standalone.length} standalone, ${result.byKind.subtask.length} subtasks, ${result.byKind.umbrella.length} umbrella/index, ${result.byKind.unreviewed.length} unreviewed.`,
    '#271 remains **ON HOLD** by #481 owner instruction; open/P0 does not authorize remediation.',
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
  lines.push('', '| Open issue | Lineage | Priority | Scope / hold |', '| --- | --- | --- | --- |');
  for (const item of result.issues) {
    const lineage = item.parentIssue ? `${item.kind} of #${item.parentIssue}/${item.parentSlice}` : item.kind;
    lines.push(`| [#${item.number}](${item.url}) | ${lineage} | ${item.priority} | ${item.onHold ? 'OWNER ON HOLD; no work' : item.disposition} |`);
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
