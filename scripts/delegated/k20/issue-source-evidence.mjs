/** Evidence layers: GitHub PR lifecycle, identical source blob, and actual installed-device acceptance. */
const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);

export function auditIssueSourceEvidence({ issue, pr, source = null, device = null }) {
  if (!Number.isSafeInteger(issue?.number) || issue.number < 1 ||
      !['open', 'closed'].includes(issue.state) ||
      !Number.isSafeInteger(pr?.number) || pr.number < 1 ||
      !['open', 'closed'].includes(pr.state) || !sha(pr.head?.sha) ||
      (pr.merged_at !== null && pr.merged_at !== undefined &&
        !(pr.state === 'closed' && Number.isFinite(Date.parse(pr.merged_at))))) {
    throw new TypeError('Invalid issue/PR API snapshot');
  }
  const prLifecycle = pr.merged_at ? 'MERGED' : pr.state === 'closed' ? 'CLOSED_UNMERGED' : 'OPEN';
  let sourceState = 'NOT_VERIFIED';
  if (source !== null) {
    if (!sha(source.mainHeadSha) || !sha(source.prHeadSha) ||
        source.prHeadSha !== pr.head.sha || !Array.isArray(source.files) ||
        !source.files.length || source.files.some(x => !x ||
          typeof x.path !== 'string' || !x.path.trim() ||
          !sha(x.sourceBlobSha) || !sha(x.mainBlobSha)) ||
        new Set(source.files.map(x => x.path)).size !== source.files.length) {
      throw new TypeError('Source comparison needs exact PR/main SHAs and unique file blob evidence');
    }
    sourceState = source.files.every(x => x.sourceBlobSha === x.mainBlobSha)
      ? 'IDENTICAL_BLOBS_ON_MAIN' : 'DIFFERENT_BLOBS';
  }
  let installedState = 'NOT_VERIFIED';
  if (device !== null) {
    installedState = device.environment === 'physical-windows' &&
      device.status === 'PASS' &&
      source !== null && sha(device.installedBuildSha) &&
      device.installedBuildSha === source.mainHeadSha &&
      typeof device.evidenceId === 'string' && device.evidenceId.trim() &&
      Number.isFinite(Date.parse(device.observedAt))
      ? 'PHYSICAL_PASS_REPORTED_UNVERIFIED' : 'NO_ACCEPTED_PHYSICAL_EVIDENCE';
  }
  return { issueNumber: issue.number, issueState: issue.state.toUpperCase(),
    prNumber: pr.number, prLifecycle, sourceState, installedState,
    // Identical blobs cannot prove incident acceptance, especially while issue is open.
    resolvedClaimSupported: false };
}
