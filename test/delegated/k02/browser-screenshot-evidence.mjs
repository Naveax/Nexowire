import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// #539 R21/R22: local evidence hygiene only. A PNG and an unsigned JSON record
// cannot establish an authentic hosted-browser run, so this gate NEVER returns
// PASS. Its strongest outcome is REVIEW_REQUIRED with exact source metadata.
const SHA = /^[a-f\d]{40}$/i;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const result = (status, reason) => ({ status, reason });

export function auditBrowserScreenshot({ evidence, expectedSha, evidenceDir, targetCssWidth }) {
  if (!SHA.test(expectedSha ?? '') || !evidence || typeof evidence !== 'object') {
    return result('UNKNOWN', 'missing exact SHA or evidence record');
  }
  if (!SHA.test(evidence.sourceSha ?? '') || evidence.sourceSha !== expectedSha) {
    return result('UNKNOWN', 'source commit mismatch; cannot reuse another HEAD');
  }
  if (evidence.captureState === 'queued' || evidence.captureState === 'in_progress') {
    return result('PENDING', 'browser capture was not completed');
  }
  if (evidence.captureState === 'not_run' || evidence.captureState === undefined) {
    return result('NOT_RUN', 'browser capture was not executed');
  }
  if (evidence.captureState !== 'completed') return result('UNKNOWN', 'unrecognized capture state');

  if (!evidence.screenshotFile) {
    return result(evidence.attempted ? 'FAIL' : 'NOT_RUN', 'no screenshot artifact');
  }
  if (typeof evidence.screenshotFile !== 'string' ||
      !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.png$/.test(evidence.screenshotFile) ||
      evidence.screenshotFile.includes('..')) {
    return result('FAIL', 'unsafe screenshot filename');
  }
  if (typeof evidenceDir !== 'string') return result('UNKNOWN', 'no trusted evidence directory');
  let png;
  try {
    const path = join(evidenceDir, evidence.screenshotFile);
    if (!lstatSync(path).isFile()) return result('FAIL', 'artifact is not a regular file');
    png = readFileSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return result(evidence.attempted ? 'FAIL' : 'NOT_RUN', 'screenshot absent');
    return result('FAIL', 'screenshot could not be read');
  }

  if (png.length < 33 || !png.subarray(0, 8).equals(PNG) ||
      png.toString('ascii', 12, 16) !== 'IHDR') {
    return result('FAIL', 'artifact lacks PNG signature or IHDR');
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (!width || !height || width > 20_000 || height > 20_000) {
    return result('FAIL', 'invalid PNG dimensions');
  }
  if (!/^[a-f\d]{64}$/i.test(evidence.screenshotSha256 ?? '') ||
      createHash('sha256').update(png).digest('hex') !== evidence.screenshotSha256) {
    return result('FAIL', 'artifact checksum missing or mismatched');
  }

  const { observedInnerWidth, documentScrollWidth, unknownVisible,
    overflowIds, browserVersion, screenshotScale } = evidence;
  if (!Number.isInteger(targetCssWidth) || targetCssWidth <= 0 ||
      observedInnerWidth !== targetCssWidth ||
      !Number.isFinite(documentScrollWidth) ||
      !['css', 'device'].includes(screenshotScale) ||
      typeof browserVersion !== 'string' || browserVersion.trim().length < 3) {
    return result('UNKNOWN', 'missing browser viewport, scale, or version provenance');
  }
  const factor = screenshotScale === 'css' ? 1 : evidence.deviceScaleFactor;
  if (!Number.isFinite(factor) || factor <= 0 || Math.abs(width - Math.round(targetCssWidth * factor)) > 2) {
    return result('FAIL', 'PNG width does not match captured CSS viewport and scale');
  }
  if (unknownVisible !== true || documentScrollWidth > observedInnerWidth ||
      !Array.isArray(overflowIds) || overflowIds.length > 0) {
    return result('FAIL', 'browser geometry or UNKNOWN text visibility failed');
  }

  return result('REVIEW_REQUIRED',
    `PNG ${width}x${height}, SHA256 and ${targetCssWidth}px geometry internally consistent; external runner authenticity unverified`);
}
