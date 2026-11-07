#!/usr/bin/env node
/** Offline evidence checks. No GitHub mutations, network operations, or process kills. */

const SHA = /^[0-9a-f]{40}$/i;

/** GitHub's merged_at, NOT state=closed or a similar patch, decides merged. */
export function classifyPullRequest(pr, supersession = null) {
  if (!pr || !Number.isSafeInteger(pr.number) ||
      !['open', 'closed'].includes(pr.state) ||
      !(pr.merged_at === null || pr.merged_at === undefined ||
        (typeof pr.merged_at === 'string' && Number.isFinite(Date.parse(pr.merged_at))))) {
    throw new TypeError('Invalid GitHub pull request response');
  }
  const merged = Boolean(pr.merged_at);
  if (merged && pr.state !== 'closed') throw new TypeError('Merged PR cannot be open');
  const lifecycle = merged ? 'merged' : pr.state === 'open' ? 'open' : 'closed-unmerged';
  let sourceDisposition = 'no-independent-integration-proof';
  if (supersession !== null) {
    if (lifecycle !== 'closed-unmerged' ||
        !Number.isSafeInteger(supersession.ownerPrNumber) ||
        supersession.ownerPrNumber < 1 ||
        !supersession.ownerMergedAt ||
        !Number.isFinite(Date.parse(supersession.ownerMergedAt)) ||
        !SHA.test(supersession.sourceMainSha || '') ||
        !SHA.test(supersession.sourcePrHeadSha || '') ||
        !Array.isArray(supersession.verifiedMatchingPaths) ||
        supersession.verifiedMatchingPaths.length === 0 ||
        supersession.verifiedMatchingPaths.some(x => typeof x !== 'string' || !x.trim())) {
      throw new TypeError('Insufficient exact-source proof of supersession');
    }
    sourceDisposition = 'superseded-with-source-evidence';
  }
  return { number: pr.number, lifecycle, sourceDisposition };
}

const refs = text => [...text.matchAll(/#(\d+)\b/g)].map(x => Number(x[1]));

/** Parse the team's current board; overlapping exact or wildcard paths are not safe. */
export function auditTeamBoard(board) {
  if (typeof board !== 'string') throw new TypeError('Expected team board Markdown');
  const sections = [...board.matchAll(/^### K(\d{2}) — ([^\n]+)/gm)];
  const workers = sections.map((match, i) => {
    const body = board.slice(match.index, sections[i + 1]?.index ?? board.length);
    const scopeLine = body.match(/^- ROL\/ALAN: ([^\n]+)/m)?.[1];
    const issueLine = body.match(/^- İLGİLİ ISSUE: ([^\n]+)/m)?.[1];
    if (!scopeLine || !issueLine) throw new Error(`Incomplete K${match[1]} board section`);
    const paths = [...scopeLine.matchAll(/`([^`]+)`/g)]
      .flatMap(x => x[1].split(/[;,]/)
        .map(y => y.trim().replace(/\s+\([^)]*\)$/, ''))
        .filter(Boolean));
    const taskLines = body.split('\n').filter(x => /^- \*\*AKTİF: T-\d+|^  - T-\d+/.test(x));
    const normalizedTasks = taskLines.map(line => {
      const id = line.match(/T-(\d+)/);
      return { task: Number(id[1]), issues: refs(line), text: line.trim() };
    });
    return { worker: `K${match[1]}`, role: match[2], paths,
      issues: [...new Set(refs(issueLine.split('SAHİPLİK/BAĞIMLILIK:')[0]))],
      tasks: normalizedTasks };
  });
  const overlaps = [];
  for (let i = 0; i < workers.length; i++) {
    for (let j = i + 1; j < workers.length; j++) {
      for (const a of workers[i].paths) for (const b of workers[j].paths) {
        const rootA = a.replace(/\*\*$/, '');
        const rootB = b.replace(/\*\*$/, '');
        if (a === b || (a.endsWith('**') && b.startsWith(rootA)) ||
            (b.endsWith('**') && a.startsWith(rootB))) {
          overlaps.push({ workers: [workers[i].worker, workers[j].worker], paths: [a, b] });
        }
      }
    }
  }
  return { workers, overlaps };
}

/** #481 explicitly freezes #271. Open issue/P0 is NOT authorization to lift hold. */
export function auditHold271(handoffBody, board) {
  if (typeof handoffBody !== 'string' ||
      !/#271[^\n]{0,120}(?:ON HOLD|OWNER HOLD|DEFERRED)/i.test(handoffBody)) {
    throw new Error('#481 owner hold not verified; fail closed');
  }
  const mapping = auditTeamBoard(board);
  const mentions = mapping.workers.flatMap(w => w.tasks
    .filter(t => t.issues.includes(271))
    .map(t => ({ worker: w.worker, task: t.task, text: t.text })));
  // An audit assignment to *preserve* the hold is permitted. An assignment
  // to remediate ACLs or resume #271 is not. Unclear descriptions fail closed.
  const isProtectiveCheck = text =>
    /(?:engelle|prevent|koru|preserve|on hold.*(?:denet|kontrol|check|audit))/i.test(text) &&
    !/(?:hold.{0,20}kaldır|resume|remediat|acl.{0,20}(?:düzelt|fix|değiştir))/i.test(text);
  return {
    hold: '#271 owner ON HOLD',
    protectiveChecks: mentions.filter(x => isProtectiveCheck(x.text))
      .map(({ worker, task }) => ({ worker, task })),
    invalidAssignments: mentions.filter(x => !isProtectiveCheck(x.text))
      .map(({ worker, task }) => ({ worker, task })),
  };
}

/** Exact-HEAD CI + machine acceptance: synthetic and skipped are not PASS. */
export function evaluateAcceptance({ expectedHead, ci, physical = [] }) {
  if (!SHA.test(expectedHead || '') || !ci || !Array.isArray(ci.jobs) ||
      !Array.isArray(physical)) throw new TypeError('Invalid evidence envelope');
  const blockers = [];
  if (ci.head_sha !== expectedHead) blockers.push('CI_HEAD_MISMATCH');
  if (ci.jobs.length === 0) blockers.push('CI_ZERO_JOBS');
  for (const job of ci.jobs) {
    if (job.head_sha !== expectedHead) blockers.push(`JOB_HEAD_MISMATCH:${job.name}`);
    if (job.status !== 'completed' || job.conclusion !== 'success') {
      blockers.push(`JOB_NOT_SUCCESS:${job.name}:${job.status}/${job.conclusion}`);
    }
  }
  for (const check of physical) {
    if (check.status !== 'PASS' || check.environment !== 'physical-windows' ||
        !check.evidenceId || !check.observedAt ||
        !Number.isFinite(Date.parse(check.observedAt))) {
      blockers.push(`PHYSICAL_NOT_ACCEPTED:${check.name || 'unknown'}`);
    }
  }
  return { decision: blockers.length ? 'NO_GO' : 'PASS', blockers };
}
