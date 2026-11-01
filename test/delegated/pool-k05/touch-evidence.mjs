// T-253: validate how a touch-target observation is recorded, not accessibility.
// An OBSERVED entry is a report requiring independent artifact verification.
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const nonnegative = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const nonblank = (value) => typeof value === 'string' && value.trim().length > 0;

export function validateTouchEvidence(record) {
  const issues = [];
  const fail = (rule, target = null) => issues.push({ rule, ...(target ? { target } : {}) });
  if (!isObject(record) || record.schemaVersion !== 1) {
    return [{ rule: 'unsupported-schema' }];
  }
  if (!nonblank(record.page) || !/^web\/[\w.-]+\.html$/.test(record.page)) fail('invalid-page');
  if (!isObject(record.viewport) || !positive(record.viewport.widthPx) ||
      !positive(record.viewport.heightPx) || !positive(record.viewport.zoom)) {
    fail('invalid-viewport');
  }
  if (!Array.isArray(record.targets) || record.targets.length === 0) {
    fail('missing-targets');
    return issues;
  }
  const seen = new Set();
  for (const target of record.targets) {
    if (!isObject(target) || !nonblank(target.id) || !nonblank(target.selector)) {
      fail('invalid-target');
      continue;
    }
    if (seen.has(target.id)) fail('duplicate-target-id', target.id);
    seen.add(target.id);
    const kind = target.evidence?.kind;
    if (!['source-css', 'browser', 'manual'].includes(kind)) fail('invalid-evidence-kind', target.id);
    if (target.status === 'NOT_RUN') {
      if (!nonblank(target.reason)) fail('missing-not-run-reason', target.id);
      if (target.measurement !== null && target.measurement !== undefined) {
        fail('measurement-claimed-without-run', target.id);
      }
    } else if (target.status === 'OBSERVED') {
      if (kind === 'source-css') fail('source-only-observation', target.id);
      if (!nonblank(target.evidence?.artifact)) fail('missing-evidence-artifact', target.id);
      if (!isObject(target.measurement) || !positive(target.measurement.widthPx) ||
          !positive(target.measurement.heightPx) || !nonnegative(target.measurement.spacingPx)) {
        fail('invalid-measurement', target.id);
      }
    } else {
      // Do not accept claimed PASS/FAIL from this format: no normative 24/44px
      // threshold or spacing exception can be decided from an offline record.
      fail('unsupported-status', target.id);
    }
  }
  return issues;
}

export function summarizeTouchEvidence(record) {
  const issues = validateTouchEvidence(record);
  if (issues.length) return { valid: false, issues };
  return {
    valid: true,
    observedUnverified: record.targets.filter((target) => target.status === 'OBSERVED').length,
    notRun: record.targets.filter((target) => target.status === 'NOT_RUN').length,
    accessibilityAccepted: false,
  };
}
