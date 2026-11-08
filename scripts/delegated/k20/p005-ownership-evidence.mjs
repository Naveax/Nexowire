/** P005 board ownership and #540 source-vs-installed acceptance checks. */
const SHA = /^[0-9a-f]{40}$/i;

export function auditP005Ownership(board) {
  if (typeof board !== 'string') throw new TypeError('Markdown board expected');
  const heads = [...board.matchAll(/^### K(\d{2}) — ([^\n]+)/gm)];
  const workers = heads.map((m, i) => {
    const body = board.slice(m.index, heads[i + 1]?.index ?? board.indexOf('## HAVUZ', m.index));
    const scope = body.match(/^- \*\*ROL\/ALAN:\*\*\s*([^\n]+)/m)?.[1];
    const focus = body.match(/^- \*\*ODAK \/ ISSUE:\*\*\s*([^\n]+)/m)?.[1];
    if (!scope || !focus) throw new Error(`Incomplete P005 worker K${m[1]}`);
    const paths = scope.replace(/\.$/, '').split(/[;,]/)
      .map(x => x.trim().replace(/\s+\([^)]*\)$/, ''))
      .filter(Boolean);
    const tasks = body.split('\n').filter(x =>
      /^- \*\*AKTİF T-\d+:/u.test(x) || /^\s*\d+\. \*\*T-\d+:/u.test(x))
      .map(line => {
        const id = Number(line.match(/T-(\d+)/)[1]);
        return { id, issues: [...line.matchAll(/#(\d+)\b/g)].map(x => Number(x[1])) };
      });
    return { worker: `K${m[1]}`, role: m[2], paths,
      focusIssues: [...new Set([...focus.split('**Önceki açık:')[0].matchAll(/#(\d+)\b/g)]
        .map(x => Number(x[1])))], tasks };
  });
  const collisions = [];
  for (let i = 0; i < workers.length; i++) for (let j = i + 1; j < workers.length; j++) {
    for (const a of workers[i].paths) for (const b of workers[j].paths) {
      const aRoot = a.replace(/\*\*$/, '');
      const bRoot = b.replace(/\*\*$/, '');
      if (a === b || (a.endsWith('**') && b.startsWith(aRoot)) ||
          (b.endsWith('**') && a.startsWith(bRoot))) {
        collisions.push({ workers: [workers[i].worker, workers[j].worker], paths: [a, b] });
      }
    }
  }
  const assignments = workers.flatMap(w => w.tasks.map(t => ({ worker: w.worker, ...t })));
  const seen = new Map();
  const duplicateTaskIds = [];
  for (const t of assignments) {
    if (seen.has(t.id)) duplicateTaskIds.push({ task: t.id, workers: [seen.get(t.id), t.worker] });
    else seen.set(t.id, t.worker);
  }
  return { workers, assignments, duplicateTaskIds, collisions };
}

/** Previously claimed pool items are awarded to the smallest eligible K number. */
export function resolveDuplicatePoolClaim(task, claimants) {
  if (!Number.isSafeInteger(task) || !Array.isArray(claimants) ||
      !claimants.length || claimants.some(x => !/^K(?:0[1-9]|1\d|20)$/.test(x)))
    throw new TypeError('Worker claims must be K01–K20');
  const ordered = [...new Set(claimants)].sort();
  return { task, owner: ordered[0], nonCredit: ordered.slice(1) };
}

/** Tests/docs and a green hosted workflow do not fix Windows descendant cleanup. */
export function classifyWindowsProcessIssue({ issue, pull, paths, ci, physical = null }) {
  if (issue?.number !== 540 || !['open','closed'].includes(issue.state) ||
      !Number.isSafeInteger(pull?.number) || !SHA.test(pull?.headSha ?? '') ||
      !['open', 'closed'].includes(pull.state) || !Array.isArray(paths) ||
      !paths.length || paths.some(x => typeof x !== 'string' || !x.trim())) {
    throw new TypeError('Exact #540 source and PR evidence required');
  }
  const implementationFiles = paths.filter(x =>
    !x.startsWith('test/') && !x.startsWith('docs/') && !x.startsWith('scripts/delegated/'));
  const sourceClass = implementationFiles.length ? 'PRODUCTION_SOURCE_TOUCHED' : 'QA_SOURCE_ONLY';
  const ciVerdict = ci?.headSha !== pull.headSha ? 'STALE_OR_UNKNOWN_HEAD'
    : ci.conclusion === 'success' ? 'GREEN_REPORTED' : 'NOT_GREEN';
  const physicalVerdict = physical?.environment === 'physical-windows' &&
    physical.status === 'PASS' && physical.evidenceId &&
    physical.installedBuildSha && SHA.test(physical.installedBuildSha)
    ? 'PHYSICAL_PASS_REPORTED_UNVERIFIED' : 'PHYSICAL_NOT_VERIFIED';
  return { issueState: issue.state.toUpperCase(), pullNumber: pull.number,
    sourceClass, implementationFiles, ciVerdict, physicalVerdict,
    resolvedClaim: false };
}
