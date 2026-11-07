#!/usr/bin/env node
/** Deterministic, read-only owner PR transfer and CI evidence audit. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const shaPattern = /^[0-9a-f]{40}$/i;

function validFiles(files) {
  return Array.isArray(files) && files.every(f => typeof f.path === 'string' && shaPattern.test(f.blob ?? ''));
}

export function mapClosedTransfers(closed, mergedOwners, absentMain = {}) {
  if (!Array.isArray(closed) || !Array.isArray(mergedOwners)) throw new TypeError('Expected source and merged owner arrays');
  return closed.map(source => {
    if (!Number.isSafeInteger(source.number) || !validFiles(source.files) || !source.files.length) {
      throw new Error(`Incomplete closed source file list: #${source.number}`);
    }
    const evidence = mergedOwners.map(owner => {
      if (!shaPattern.test(owner.mergeCommit ?? '') || !validFiles(owner.files)) throw new Error('Unverified merged owner payload');
      const byPath = new Map(owner.files.map(file => [file.path, file.blob]));
      const shared = source.files.filter(file => byPath.has(file.path));
      const exact = shared.filter(file => byPath.get(file.path) === file.blob);
      return { owner: owner.number, mergeCommit: owner.mergeCommit,
        shared: shared.length, exact: exact.length, total: source.files.length };
    }).filter(m => m.shared > 0).sort((a, b) => b.exact - a.exact || b.shared - a.shared || a.owner - b.owner);
    const exact = evidence.find(m => m.exact === m.total);
    const transformed = evidence.find(m => m.shared === m.total && m.exact < m.total);
    const best = exact ?? transformed ?? evidence[0] ?? null;
    let status = exact ? 'EXACT_BLOB_TRANSFER' : transformed ? 'PATH_TRANSFER_CONTENT_ADAPTED'
      : best ? 'PARTIAL_PATH_TRANSFER_REVIEW' : 'NO_VERIFIED_MERGED_OWNER';
    if (!best && (absentMain[source.number] ?? []).length === source.files.length) status = 'NO_CURRENT_MAIN_EVIDENCE';
    return { source: source.number, sourceHead: source.head, status, ...(best ?? {}),
      total: source.files.length, exact: best?.exact ?? 0, shared: best?.shared ?? 0,
      missingFromCurrentMain: absentMain[source.number] ?? [], candidateOwners: evidence.map(x => x.owner) };
  }).sort((a, b) => a.source - b.source);
}

export function compareOpenSources(open, coordinator) {
  if (!validFiles(coordinator.files)) throw new Error('Incomplete coordinator file inventory');
  const target = new Map(coordinator.files.map(f => [f.path, f.blob]));
  return open.map(pr => {
    if (!validFiles(pr.files)) throw new Error(`Incomplete open source #${pr.number}`);
    const overlaps = pr.files.filter(f => target.has(f.path)).map(f => ({ path: f.path,
      sameBlob: f.blob === target.get(f.path), sourceBlob: f.blob, coordinatorBlob: target.get(f.path) }));
    return { source: pr.number, sourceHead: pr.head, coordinator: coordinator.number,
      coordinatorHead: coordinator.head, pathOverlap: overlaps.length, totalPaths: pr.files.length,
      sameBlob: overlaps.filter(f => f.sameBlob).length,
      mismatches: overlaps.filter(f => !f.sameBlob),
      independent: pr.files.filter(f => !target.has(f.path)).map(f => f.path) };
  }).sort((a, b) => a.source - b.source);
}

export function analyzeSnapshot(data) {
  if (!shaPattern.test(data.upstreamMain ?? '') || !shaPattern.test(data.forkMain ?? '')) throw new Error('Exact main SHAs required');
  const transfers = mapClosedTransfers(data.closed, data.mergedOwners, data.unmatchedCurrentMain);
  const open = compareOpenSources(data.open, data.owner1068);
  const owner1096 = new Set(data.owner1096?.paths ?? []);
  const mainDeltaOverlap = data.mainDeltaOwner1096Intersection ?? [];
  if (!Array.isArray(mainDeltaOverlap) || mainDeltaOverlap.some(path => !owner1096.has(path))) {
    throw new Error('Main delta / owner overlap is not backed by the captured owner path list');
  }
  const counts = {};
  for (const t of transfers) counts[t.status] = (counts[t.status] ?? 0) + 1;
  const ci1068 = data.ci.owner1068;
  const sevenOfSeven = ci1068.sha === data.owner1068.head && ci1068.complete === true && ci1068.successJobs === 7 && ci1068.totalJobs === 7 && ci1068.skipped === 0;
  return {
    source: data.capturedAt,
    main: { upstream: data.upstreamMain, fork: data.forkMain, synchronized: data.upstreamMain === data.forkMain },
    transfers, transferCounts: counts, open,
    upstreamDelta: { totalPaths: data.mainDeltaTotal, protectedPaths: data.mainDeltaProtectedPaths,
      owner1096SamePaths: [...mainDeltaOverlap].sort(), owner1096Total: data.owner1096.filesTotal },
    ci: { owner1068Head: data.owner1068.head, run: ci1068.run, sevenOfSeven,
      owner1096: data.ci.owner1096 },
    mergeReady: false,
    acceptance: 'Read-only evidence. Draft/review/CORE/branch-protection/physical acceptance NOT inferred; do not auto-merge or close issues.',
  };
}

export function markdown(report) {
  const lines = [
    '# #1006 / #539 — K14 read-only integration evidence', '',
    `- Main synchronized: ${report.main.synchronized} (fork ${report.main.fork})`,
    `- Historical closed source PRs: ${report.transfers.length}`,
    `- Transfer types: ${JSON.stringify(report.transferCounts)}`,
    `- #1068 exact-head 7/7 observed green jobs: ${report.ci.sevenOfSeven} (still Draft)`,
    `- Merge-ready conclusion: ${report.mergeReady}`, '',
    '## Source-to-owner transfer evidence', '',
    '| Source PR | Status | Merged owner | Matching blobs | Merge commit |',
    '| --- | --- | --- | --- | --- |',
    ...report.transfers.map(t => `| #${t.source} | ${t.status} | ${t.owner ? `#${t.owner}` : 'UNKNOWN'} | ${t.exact ?? 0}/${t.total ?? '?'} | ${t.mergeCommit ? `\`${t.mergeCommit}\`` : 'UNKNOWN'} |`),
    '', '## Remaining six open source PRs vs #1068', '',
    '| Source | Same path | Identical blob | Different blob |',
    '| --- | ---: | ---: | ---: |',
    ...report.open.map(p => `| #${p.source} | ${p.pathOverlap}/${p.totalPaths} | ${p.sameBlob} | ${p.mismatches.length} |`),
    '', '## #1096 preserved-source review paths', '',
    ...report.upstreamDelta.owner1096SamePaths.map(path => `- \`${path}\``),
    '', report.acceptance, '',
  ];
  return lines.join('\n');
}

async function main(args) {
  const ix = args.indexOf('--offline');
  if (ix < 0 || !args[ix + 1]) throw new Error('Supply --offline <verified-rest-snapshot.json>; no live writes or implicit network');
  const report = analyzeSnapshot(JSON.parse(await readFile(args[ix + 1], 'utf8')));
  process.stdout.write(args.includes('--json') ? `${JSON.stringify(report, null, 2)}\n` : markdown(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error(`Integration audit failed: ${error.message}`); process.exitCode = 1; });
}
