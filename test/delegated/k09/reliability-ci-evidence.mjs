import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const gitSha = (bytes) => createHash('sha1')
  .update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

// Explicit GitHub API observations at 2026-11-08 (not a live network fetch).
// A CI run's success proves nothing about a nested test unless that test was
// actually invoked; this distinction applies independently to both PRs.
export const snapshot = Object.freeze({
  main: 'b5a3f8840517d65ecbd6a018699c4c8bdde09987',
  issue: 539,
  issueState: 'open',
  issueIds: Array.from({ length: 22 }, (_, i) => `R${String(i + 1).padStart(2, '0')}`),
  prs: [
    { number: 1099, head: '2ae40bd36a3e97b8544102a96b4e63673f6a5fd0',
      state: 'open', mergedAt: null, exactHeadCi: 'success', jobsSucceeded: 7,
      test: 'test/delegated/k09/issue539-coverage.test.mjs' },
    { number: 1127, head: '32f76f575c4baf68c4c3c105bbcc7726c3999610',
      state: 'open', mergedAt: null, exactHeadCi: 'success', jobsSucceeded: 7,
      test: 'test/delegated/k09/handoff-drift.test.mjs' },
  ],
  source: {
    'docs/NEXOWIRE_CROSS_PROJECT_RELIABILITY_BACKLOG_20261018.md':
      '0e786feb00183d2769445562afd2403f559429f6',
    '.github/workflows/ci.yml': '90185b6f4297bc3e4feaca44817ed6a8248bd4be',
    'package.json': '55ef2e50e1914016770b3c890476cf7a3f434db2',
  },
});

export function reconcileReliability(input = snapshot, dir = root) {
  const data = {};
  for (const [file, sha] of Object.entries(input.source)) {
    if (!/^(docs\/|\.github\/workflows\/|package\.json$)/.test(file) || file.includes('..'))
      throw new Error(`Invalid repository source path: ${file}`);
    // For testing a newer main against an older local checkout, a caller can
    // supply the exact CI blob in a separate, read-only snapshot file. The
    // Git blob SHA below is still enforced; stale or invented data fails.
    const sourcePath = file === '.github/workflows/ci.yml' && process.env.K09_CI_WORKFLOW_SNAPSHOT
      ? process.env.K09_CI_WORKFLOW_SNAPSHOT : resolve(dir, file);
    const bytes = readFileSync(sourcePath);
    if (gitSha(bytes) !== sha) throw new Error(`Source drift: ${file}`);
    data[file] = bytes.toString('utf8');
  }
  const backlog = data['docs/NEXOWIRE_CROSS_PROJECT_RELIABILITY_BACKLOG_20261018.md'];
  const actualIds = [...new Set(backlog.match(/\bR\d{2}\b/g) ?? [])].sort();
  const reportedIds = [...new Set(input.issueIds)].sort();
  if (reportedIds.length !== input.issueIds.length || actualIds.length !== 22 ||
      reportedIds.length !== 22 || actualIds.some((id, i) => id !== reportedIds[i]))
    throw new Error('Issue #539 IDs diverge from current canonical backlog');

  const ciWorkflow = data['.github/workflows/ci.yml'];
  const packageJson = JSON.parse(data['package.json']);
  const npmTest = packageJson.scripts?.test ?? '';
  const results = input.prs.map((pr) => {
    if (!/^[0-9a-f]{40}$/.test(pr.head) || !['open', 'closed'].includes(pr.state) ||
        !['success', 'failure', 'pending', 'action_required', 'not_run'].includes(pr.exactHeadCi) ||
        !Number.isSafeInteger(pr.jobsSucceeded) || pr.jobsSucceeded < 0)
      throw new Error(`Invalid PR or CI observation: #${pr.number}`);
    if (pr.mergedAt && pr.state !== 'closed') throw new Error('Merged PR cannot be open');
    const direct = ciWorkflow.includes(pr.test);
    const knownMjsDiscovery = pr.test.endsWith('.test.mjs') && /test\/\*\*\/\*\.test\.mjs/.test(npmTest);
    const ciTestEvidence = direct || knownMjsDiscovery ? 'DISCOVERABLE_SOURCE_ONLY' : 'NOT_PROVEN';
    return {
      pr: pr.number, head: pr.head, state: pr.mergedAt ? 'MERGED' : 'UNMERGED',
      hostedCi: pr.exactHeadCi === 'success' && pr.jobsSucceeded > 0 ? 'RUN_SUCCESS' : 'CI_NOT_GREEN',
      delegatedTest: ciTestEvidence,
      issue539: input.issueState === 'closed' ? 'CLOSED_NEEDS_ACCEPTANCE' : 'OPEN_NOT_RESOLVED',
      physical: 'NOT_RUN',
    };
  });
  if (new Set(results.map((row) => row.pr)).size !== results.length)
    throw new Error('Duplicated PR identity in issue reliability audit');
  return { main: input.main, rCount: actualIds.length, rows: results };
}

export function reportReliability(input = snapshot, dir = root) {
  const { main, rCount, rows } = reconcileReliability(input, dir);
  return [`MAIN ${main}`, `ISSUE #539 ${input.issueState} / R01–R${rCount}`]
    .concat(rows.map((row) =>
      `PR #${row.pr}\t${row.head}\t${row.state}\t${row.hostedCi}\tK09_TEST_${row.delegatedTest}\t${row.issue539}\tPHYSICAL_${row.physical}`,
    )).join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.stdout.write(`${reportReliability()}\n`);
