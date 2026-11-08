import { pathToFileURL } from 'node:url';

// The P005 board counted 22 open Nexowire issues, but did not preserve every
// issue identity. This is a current API observation, not a reconstructed
// immutable P005 list. Use the updated-since query and issue events to detect
// intermediate transitions without treating a same-count result as proof.
export const source = Object.freeze({
  main: '52d452f717d891eeaf4c2b9aff3c6e1ea68369b0',
  observed: '2026-11-08',
  earlierBoard: 'https://github.com/SinsiVinci/Nexowire-fork/blob/ekip/ekip/PANO.md',
  issueSearch: 'https://github.com/Naveax/Nexowire/issues?q=is%3Aissue+is%3Aopen',
  oldOpenCount: 22,
  currentOpenIssues: [265, 269, 271, 322, 323, 402, 481, 482, 484, 485, 486,
    487, 539, 540, 587, 588, 617, 780, 812, 974, 1001, 1006],
  modifiedSinceNov7: [
    { number: 487, finalState: 'open', events: [
      { event: 'closed', at: '2026-11-08T12:14:44Z' },
      { event: 'reopened', at: '2026-11-08T12:16:55Z' },
    ] },
    { number: 1006, finalState: 'open', events: [] },
  ],
  updatedQueryCount: 2,
});

export function reconcileOpenIssues(input = source) {
  const ids = input.currentOpenIssues;
  if (!Array.isArray(ids) || ids.length !== 22 || new Set(ids).size !== ids.length ||
      ids.some((n) => !Number.isSafeInteger(n) || n < 1))
    throw new Error('Current open issue identity set is incomplete or duplicated');
  if (!Number.isSafeInteger(input.oldOpenCount) || input.oldOpenCount < 0 ||
      !Array.isArray(input.modifiedSinceNov7) || input.updatedQueryCount !== input.modifiedSinceNov7.length)
    throw new Error('Invalid historical count or updated-since pagination evidence');
  if (new Set(input.modifiedSinceNov7.map((row) => row.number)).size !== input.modifiedSinceNov7.length)
    throw new Error('Duplicate updated issue');

  const touched = input.modifiedSinceNov7.map((row) => {
    if (!['open', 'closed'].includes(row.finalState) || !Array.isArray(row.events))
      throw new Error(`Invalid state for issue #${row.number}`);
    let state = 'open';
    let last = '';
    for (const event of row.events) {
      if (!['closed', 'reopened'].includes(event.event) ||
          Number.isNaN(Date.parse(event.at)) || event.at <= last)
        throw new Error(`Invalid state event for issue #${row.number}`);
      const expected = state === 'open' ? 'closed' : 'reopened';
      if (event.event !== expected) throw new Error(`Non-alternating state transition for issue #${row.number}`);
      state = event.event === 'closed' ? 'closed' : 'open';
      last = event.at;
    }
    if (state !== row.finalState) throw new Error(`Unreconciled final state for issue #${row.number}`);
    if ((row.finalState === 'open') !== ids.includes(row.number))
      throw new Error(`Current open-issue set does not agree with issue #${row.number}`);
    return { number: row.number, finalState: row.finalState,
      stateChanges: row.events.length, transientClosed: row.events.some((event) => event.event === 'closed') && row.finalState === 'open' };
  });
  return {
    earlierCount: input.oldOpenCount, currentCount: ids.length,
    countDelta: ids.length - input.oldOpenCount, touched,
    // The historical P005 count does not store 22 exact identity keys.
    identityDelta: 'UNVERIFIED_PREVIOUS_FULL_SET',
    closedIssueAcceptance: 'NOT_VERIFIED',
  };
}

export function reportIssueTransitions(input = source) {
  const audit = reconcileOpenIssues(input);
  return `P005_OPEN ${audit.earlierCount}\nCURRENT_OPEN ${audit.currentCount}\n` +
    `COUNT_DELTA ${audit.countDelta}\nIDENTITY_DELTA ${audit.identityDelta}\n` +
    audit.touched.map((row) =>
      `ISSUE #${row.number}\t${row.finalState}\tEVENTS=${row.stateChanges}\tTRANSIENT_CLOSE=${row.transientClosed}\tACCEPTANCE=${audit.closedIssueAcceptance}`,
    ).join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.stdout.write(`${reportIssueTransitions()}\n`);
