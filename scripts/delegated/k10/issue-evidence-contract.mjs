/**
 * Read-only validation of external #485 screenshots. Valid PNGs alone cannot
 * prove they came from an authenticated browser, Windows device or live Agent.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { inspectPng } from './browser-visual-smoke.mjs';

export const CONNECT_STATES = Object.freeze(['loading', 'error', 'success']);

function safeArtifact(dir, name) {
  if (typeof name !== 'string' || name !== basename(name) || !/^[a-z\d][a-z\d_.-]*\.png$/i.test(name)) return null;
  const path = join(dir, name);
  if (!existsSync(path)) return null;
  try {
    const actual = relative(realpathSync(dir), realpathSync(path));
    if (isAbsolute(actual) || actual === '..' || actual.startsWith(`..${sep}`)) return null;
    return path;
  } catch { return null; }
}

export function evaluateConnectEvidence(manifest, artifactDir) {
  const candidateSha = manifest?.sourceSha;
  const sourceProvenance = typeof candidateSha === 'string' && /^[a-f0-9]{40}$/.test(candidateSha) ? 'RECORDED' : 'MISSING';
  const seen = new Set();
  const seenContents = new Set();
  const cases = [];
  const rows = Array.isArray(manifest?.screenshots) ? manifest.screenshots : [];
  for (const state of CONNECT_STATES) {
    const matches = rows.filter((row) => row?.state === state);
    if (matches.length !== 1) {
      cases.push({ state, status: matches.length === 0 ? 'NOT_RUN' : 'FAIL', reason: 'exactly one state artifact required' });
      continue;
    }
    const row = matches[0];
    if (row.file == null) {
      cases.push({ state, status: 'NOT_RUN', reason: 'screenshot not captured' });
      continue;
    }
    if (seen.has(row.file)) {
      cases.push({ state, status: 'FAIL', reason: 'duplicate screenshot artifact' });
      continue;
    }
    seen.add(row.file);
    const path = safeArtifact(resolve(artifactDir), row.file);
    if (!path) {
      cases.push({ state, status: 'NOT_RUN', reason: 'missing or unsafe screenshot file' });
      continue;
    }
    // Validate exactly the bytes that are hashed; a replaced artifact between
    // two separate reads must never validate against a different file version.
    let bytes;
    try { bytes = readFileSync(path); }
    catch {
      cases.push({ state, status: 'NOT_RUN', reason: 'screenshot unreadable at inspection time' });
      continue;
    }
    const png = inspectPng(bytes, row.width, row.height);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const hashMatches = typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/.test(row.sha256) && digest === row.sha256;
    if (png.status === 'PASS' && hashMatches && seenContents.has(digest)) {
      cases.push({ state, status: 'FAIL', reason: 'duplicate screenshot content' });
      continue;
    }
    if (png.status === 'PASS' && hashMatches) seenContents.add(digest);
    cases.push({ state, status: png.status === 'PASS' && hashMatches ? 'ARTIFACT_VALID' : 'FAIL',
      reason: png.status !== 'PASS' ? 'PNG pixels/dimensions invalid' : hashMatches ? 'PNG and digest match' : 'digest missing or mismatched' });
  }
  const unexpected = rows.filter((row) => !CONNECT_STATES.includes(row?.state));
  const artifactStatus = unexpected.length || cases.some((item) => item.status === 'FAIL') ? 'FAIL'
    : cases.some((item) => item.status === 'NOT_RUN') || sourceProvenance === 'MISSING' ? 'NOT_RUN'
    : 'ARTIFACTS_VERIFIED_ORIGIN_UNPROVEN';
  return {
    schemaVersion: 1,
    issue: 485,
    sourceProvenance,
    artifactStatus,
    cases,
    realBrowserProvenance: 'NOT_VERIFIED',
    realUserPairing: 'NOT_RUN',
    windowsAcceptance: 'NOT_RUN',
    note: 'Validated PNG bytes and hashes cannot independently prove screenshot origin or successful pairing.',
  };
}

/** Read-only QA for #812; never infers physical authorization from local grant alone. */
export function auditConsoleIndicator({ localGrantActive, effectiveControlVerified, displayClaimsDisabled }) {
  if (typeof localGrantActive !== 'boolean' || !['yes', 'no', 'unknown'].includes(effectiveControlVerified)) {
    return { status: 'INSUFFICIENT_EVIDENCE', effectiveAuthorization: 'UNKNOWN' };
  }
  if (effectiveControlVerified === 'yes' && displayClaimsDisabled === true) {
    return { status: 'CONTRADICTION', effectiveAuthorization: 'WITNESSED_SEPARATELY_FROM_LOCAL_GRANT' };
  }
  return { status: 'SOURCE_CONTRACT_ONLY', effectiveAuthorization: effectiveControlVerified === 'unknown' ? 'UNKNOWN' : 'REQUIRES_NATIVE_WITNESS' };
}
