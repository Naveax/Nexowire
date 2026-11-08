import { pathToFileURL } from 'node:url';

// Issue #481 is a dated preservation record. These observations are explicitly
// point-in-time GitHub API reads, not a network check or production evidence.
export const handoffObservedAt = '2026-11-07';
export const handoffSource = 'https://github.com/Naveax/Nexowire/issues/481';
export const currentBase = '4e7db16f4233048a956664bef6b607781eb63fb7';

export const observations = Object.freeze([
  {
    type: 'pull_request', number: 480, previousState: 'draft',
    previousHead: 'f9c37df006c1b068b63b79983e4f2129f6a8dce4',
    previousCi: 'success', previousCiRun: 38625711335,
    currentState: 'closed', mergedAt: null,
    currentHead: 'ec3c54d77e3b9fabb4c85831222fb48b112cd7b2',
  },
  { type: 'issue', number: 260, previousState: 'open', currentState: 'closed', hold: false },
  { type: 'issue', number: 265, previousState: 'open', currentState: 'open', hold: false },
  { type: 'issue', number: 269, previousState: 'open', currentState: 'open', hold: false },
  { type: 'issue', number: 271, previousState: 'open', currentState: 'open', hold: true },
  { type: 'issue', number: 322, previousState: 'open', currentState: 'open', hold: false },
  { type: 'issue', number: 323, previousState: 'open', currentState: 'open', hold: false },
  { type: 'issue', number: 402, previousState: 'open', currentState: 'open', hold: false },
]);

export function reconcileHandoff(observationsToAudit) {
  if (!Array.isArray(observationsToAudit)) throw new TypeError('Observations must be an array');
  const seen = new Set();
  return observationsToAudit.map((row) => {
    const key = `${row.type}:${row.number}`;
    if (seen.has(key)) throw new Error(`Duplicate handoff identity: ${key}`);
    seen.add(key);
    if (!['issue', 'pull_request'].includes(row.type) || !Number.isSafeInteger(row.number))
      throw new Error(`Invalid identity: ${key}`);

    if (row.type === 'issue') {
      if (!['open', 'closed'].includes(row.previousState) ||
          !['open', 'closed'].includes(row.currentState))
        throw new Error(`Invalid issue state: ${key}`);
      const changed = row.previousState !== row.currentState;
      return {
        key, old: row.previousState, now: row.currentState,
        drift: changed ? 'STALE_HANDOFF' : 'UNCHANGED',
        completion: 'NOT_VERIFIED',
        restriction: row.hold ? 'OWNER_HOLD_DO_NOT_RESUME' : 'NONE',
      };
    }

    if (!['open', 'draft', 'closed'].includes(row.previousState) ||
        !['open', 'closed'].includes(row.currentState) ||
        !(row.mergedAt === null || typeof row.mergedAt === 'string'))
      throw new Error(`Invalid pull request state: ${key}`);
    if (typeof row.previousHead !== 'string' || !/^[0-9a-f]{40}$/.test(row.previousHead) ||
        typeof row.currentHead !== 'string' || !/^[0-9a-f]{40}$/.test(row.currentHead))
      throw new Error(`Invalid pull request HEAD: ${key}`);
    // Closed is not merged. Prior CI success does not attest to the new HEAD.
    const now = row.mergedAt ? 'merged' : row.currentState === 'closed' ? 'closed_unmerged' : 'open_unmerged';
    return {
      key, old: row.previousState, now,
      drift: row.previousState !== now || row.previousHead !== row.currentHead
        ? 'STALE_HANDOFF' : 'UNCHANGED',
      completion: 'NOT_VERIFIED',
      ci: row.previousHead !== row.currentHead ? 'OLD_HEAD_CI_NOT_TRANSFERABLE' : 'CI_NOT_RECHECKED',
      restriction: 'NONE',
    };
  });
}

export function reportHandoff(rows = observations) {
  return reconcileHandoff(rows).map((row) =>
    `${row.key}\t${row.old}\t${row.now}\t${row.drift}\t${row.completion}\t${row.restriction}`,
  ).join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`SOURCE ${handoffSource}\nOBSERVED ${handoffObservedAt}\nMAIN ${currentBase}\n${reportHandoff()}\n`);
}
