// #539/R21-R22: source-only, per-OS test evidence gate. This never treats an
// overall green workflow as proof that an OS-specific assertion actually ran.
const OS = new Set(['win32', 'linux', 'darwin']);
const SHA = /^[0-9a-f]{40}$/i;
const REQUIRED_TAP_KEYS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];

export function parseTapSummary(tap) {
  if (typeof tap !== 'string') return null;
  const counts = {};
  for (const match of tap.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/gm)) {
    const key = match[1];
    if (Object.hasOwn(counts, key)) return null;
    counts[key] = Number(match[2]);
  }
  if (REQUIRED_TAP_KEYS.some((key) => !Number.isSafeInteger(counts[key]))) return null;
  if (counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo !== counts.tests) return null;
  return counts;
}

const result = (status, reason) => ({ status, reason });

// Required fields: exactSHA, observedSHA, requiredOs, runnerOs,
// workflowStatus, stepStatus, exitCode, tap. All fields are deliberately
// explicit; a CI conclusion alone cannot promote a step to PASS.
export function classifyPlatformEvidence(record) {
  if (!record || typeof record !== 'object') return result('UNKNOWN', 'missing evidence');
  const { exactSHA, observedSHA, requiredOs, runnerOs, workflowStatus,
    stepStatus, exitCode, tap } = record;

  if (!SHA.test(exactSHA ?? '') || !SHA.test(observedSHA ?? '') || exactSHA !== observedSHA) {
    return result('UNKNOWN', 'missing or mismatched exact commit SHA');
  }
  if (!OS.has(requiredOs) || !OS.has(runnerOs)) return result('UNKNOWN', 'unverified platform');
  if (runnerOs !== requiredOs) return result('NOT_RUN', `required ${requiredOs}, observed ${runnerOs}`);

  if (workflowStatus === 'queued' || workflowStatus === 'in_progress' || stepStatus === 'in_progress') {
    return result('PENDING', 'workflow or assertion step still running');
  }
  if (workflowStatus !== 'completed') return result('UNKNOWN', 'workflow completion unverified');
  if (stepStatus === 'skipped' || stepStatus === 'not_run') {
    return result('NOT_RUN', 'assertion step was not executed');
  }
  if (stepStatus !== 'completed') return result('UNKNOWN', 'assertion step completion unverified');
  if (!Number.isInteger(exitCode)) return result('UNKNOWN', 'missing process exit code');
  if (exitCode !== 0) return result('FAIL', `assertion process exited ${exitCode}`);

  const summary = parseTapSummary(tap);
  if (!summary) return result('UNKNOWN', 'missing, duplicate or inconsistent TAP summary');
  if (summary.tests === 0) return result('NOT_RUN', 'zero assertions executed');
  if (summary.fail > 0 || summary.cancelled > 0) return result('FAIL', 'TAP reported failures');
  if (summary.skipped > 0 || summary.todo > 0 || summary.pass !== summary.tests) {
    return result('PARTIAL', 'not all assertions executed successfully');
  }
  return result('PASS', `${summary.pass}/${summary.tests} assertions passed on ${runnerOs}`);
}
