#!/usr/bin/env node
/** Read-only evidence of distinct K01–K20 task credits and paginated PR snapshots. */
const SHA = /^[0-9a-f]{40}$/i;

export function auditP006Board(board) {
  if (typeof board !== 'string' || !board.includes('P006')) throw new TypeError('P006 board required');
  const first = board.indexOf('### K01 —');
  const last = board.indexOf('\n## HAVUZ', first);
  if (first < 0 || last < 0) throw new TypeError('Missing worker roster or HAVUZ boundary');
  const roster = board.slice(first, last);
  const sections = [...roster.matchAll(/^### K(\d{2}) —[^\n]*/gm)];
  const assignment = [];
  for (let i = 0; i < sections.length; i++) {
    const worker = `K${sections[i][1]}`;
    const body = roster.slice(sections[i].index, sections[i + 1]?.index ?? roster.length);
    const ids = [...body.matchAll(/\*\*(?:AKTİF\s+)?T-(\d+):\*\*/g)]
      .map(x => Number(x[1])).filter(id => id >= 535 && id <= 654);
    assignment.push(...ids.map(task => ({ worker, task })));
  }
  const owners = new Map();
  const duplicates = [];
  for (const x of assignment) {
    if (owners.has(x.task)) duplicates.push({ task: x.task, workers: [owners.get(x.task), x.worker] });
    else owners.set(x.task, x.worker);
  }
  const missing = Array.from({ length: 120 }, (_, i) => i + 535).filter(x => !owners.has(x));
  const uniqueWorkers = new Set(sections.map(x => x[1]));
  const prior = board.match(/P005 T-395…T-514:\s*\*\*(\d+)\/120[^\n]*?\*\*/);
  const priorCompleted = prior ? Number(prior[1]) : null;
  const priorOpen = priorCompleted === null ? null : 120 - priorCompleted;
  return { version: 'P006', workers: uniqueWorkers.size, tasks: assignment.length,
    uniqueTasks: owners.size, duplicates, missing, priorCompletedReported: priorCompleted,
    priorOpenReported: priorOpen, priorCreditIndependentlyVerified: false,
    valid: sections.length === 20 && uniqueWorkers.size === 20 &&
      assignment.length === 120 && !duplicates.length && !missing.length &&
      priorCompleted === 92 && priorOpen === 28 };
}

export function auditPrCohort(prs, { first = 1099, last = 1142 } = {}) {
  if (!Array.isArray(prs) || !Number.isSafeInteger(first) ||
      !Number.isSafeInteger(last) || first <= 0 || last < first) throw new TypeError('PR range required');
  const byNumber = new Map();
  for (const pr of prs) {
    if (!Number.isSafeInteger(pr?.number) || pr.number < first || pr.number > last ||
        byNumber.has(pr.number) || !SHA.test(pr.head_sha ?? '') ||
        !['open', 'closed'].includes(pr.state) || typeof pr.merged !== 'boolean' ||
        typeof pr.draft !== 'boolean') throw new TypeError('Invalid, duplicate or missing-sha PR');
    byNumber.set(pr.number, pr);
  }
  const missing = Array.from({ length: last - first + 1 }, (_, i) => first + i)
    .filter(n => !byNumber.has(n));
  const values = [...byNumber.values()];
  const draft = values.filter(pr => pr.state === 'open' && pr.draft && !pr.merged);
  const merged = values.filter(pr => pr.state === 'closed' && pr.merged);
  const irregular = values.filter(pr => !draft.includes(pr) && !merged.includes(pr));
  return { first, last, observed: values.length, draft: draft.length,
    merged: merged.map(pr => pr.number).sort((a,b) => a-b), irregular: irregular.map(pr => pr.number),
    missing, complete: missing.length === 0 && irregular.length === 0 && values.length === last - first + 1,
    issueAcceptanceInferred: false };
}

/** Read every status file, dedupe repeated self-claims, award each shared pool ID once. */
export function auditCrossWorkerPoolClaims(statusFiles) {
  if (!Array.isArray(statusFiles) || statusFiles.some(x =>
    !/^K(?:0[1-9]|1\d|20)$/.test(x?.worker ?? '') || typeof x.text !== 'string')) {
    throw new TypeError('Worker status files with K01–K20 identities required');
  }
  if (new Set(statusFiles.map(x => x.worker)).size !== statusFiles.length)
    throw new TypeError('Duplicate worker status documents');
  const claims = new Map();
  for (const file of statusFiles) {
    for (const match of file.text.matchAll(/ÜSTLENDİM:\s*T-(\d+)/g)) {
      const task = Number(match[1]);
      if (!Number.isSafeInteger(task)) throw new TypeError('Bad task ID');
      if (!claims.has(task)) claims.set(task, new Set());
      claims.get(task).add(file.worker);
    }
  }
  const shared = [...claims].filter(([, owners]) => owners.size > 1).map(([task, owners]) => {
    const ordered = [...owners].sort();
    return { task, creditedTo: ordered[0], noCredit: ordered.slice(1) };
  }).sort((a,b)=>a.task-b.task);
  return { workersScanned: statusFiles.length, distinctPoolTasks: claims.size,
    shared, duplicateCreditAfterTieBreak: 0, creditVerifiedByStatusTextOnly: true };
}
