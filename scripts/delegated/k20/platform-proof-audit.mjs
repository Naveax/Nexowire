/** An offline distinction between unexecuted, failing, partial and physical tests. */
const PLATFORMS = new Set(['win32', 'linux', 'darwin']);

export function auditPlatformProof(evidence) {
  if (!evidence || !PLATFORMS.has(evidence.targetPlatform) ||
      !PLATFORMS.has(evidence.runnerPlatform) ||
      typeof evidence.attempted !== 'boolean' ||
      typeof evidence.physical !== 'boolean') {
    throw new TypeError('Invalid platform evidence metadata');
  }
  const platformMatch = evidence.targetPlatform === evidence.runnerPlatform;
  if (!evidence.attempted || !platformMatch) {
    return { verdict: 'NOT_RUN', reason: platformMatch ? 'NO_EXECUTION' : 'OTHER_PLATFORM' };
  }
  if (evidence.timedOut === true) return { verdict: 'FAIL', reason: 'RUN_TIMED_OUT' };
  const { exitCode, tests, passed, failed, skipped } = evidence;
  if (!Number.isSafeInteger(exitCode) || exitCode < 0 ||
      ![tests, passed, failed, skipped].every(x => Number.isSafeInteger(x) && x >= 0) ||
      passed + failed + skipped !== tests) {
    return { verdict: 'INCOMPLETE', reason: 'MISSING_OR_INCONSISTENT_TAP' };
  }
  if (exitCode !== 0 || failed > 0) {
    return { verdict: 'FAIL', reason: exitCode !== 0 ? 'PROCESS_EXIT_NONZERO' : 'ASSERTION_FAILED' };
  }
  if (tests === 0 || skipped === tests) return { verdict: 'NOT_RUN', reason: 'NO_EXECUTED_TESTS' };
  if (skipped > 0) return { verdict: 'PARTIAL', reason: 'SOME_TESTS_SKIPPED' };
  if (evidence.targetPlatform === 'win32' && evidence.physical &&
      !(typeof evidence.machineEvidenceId === 'string' && evidence.machineEvidenceId.trim())) {
    return { verdict: 'INCOMPLETE', reason: 'MISSING_PHYSICAL_MACHINE_EVIDENCE' };
  }
  return { verdict: evidence.physical ? 'PASS_PHYSICAL_REPORTED' : 'PASS_HOSTED_OR_SYNTHETIC_REPORTED',
    reason: 'UNVERIFIED_EXTERNAL_EVIDENCE' };
}
