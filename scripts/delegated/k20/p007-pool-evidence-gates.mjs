// K20-owned, read-only evidence classification. These functions never perform
// network, device, filesystem mutation, billing, or release operations.
const sha40 = /^[0-9a-f]{40}$/;
const sha256 = /^[0-9a-f]{64}$/;
const positiveInteger = n => Number.isSafeInteger(n) && n > 0;
const add = (missing, condition, name) => {
  if (!condition) missing.push(name);
};

// D-128 / D-137: inspect the *shape* of a proposed physical two-PC proof.
// Even an empty missing list never means the proof has been independently
// authenticated or that protected Agent/Hub code has been fixed.
export function auditTwoPcTransferEvidence(p = {}) {
  const missing = [];
  add(missing, typeof p.sourceCommit === 'string' && sha40.test(p.sourceCommit), 'sourceCommit');
  add(missing, typeof p.installedSenderSha === 'string' && sha40.test(p.installedSenderSha), 'installedSenderSha');
  add(missing, typeof p.installedReceiverSha === 'string' && sha40.test(p.installedReceiverSha), 'installedReceiverSha');
  add(missing, positiveInteger(p.bytes) && p.bytes > 268_435_456, 'physicalPayloadOver256MiB');
  add(missing, Array.isArray(p.fixtureSizes) &&
    [225_281, 1_048_576, 268_435_457, 1_073_741_824]
      .every(size => p.fixtureSizes.includes(size)), '221KiB_1MiB_256MiBPlus1_1GiBFixtures');
  add(missing, p.transferMode === 'bounded-stream' &&
    positiveInteger(p.chunkBytes) && p.chunkBytes <= 65_536 &&
    positiveInteger(p.maxChunksPerCall) && p.maxChunksPerCall <= 32,
  'boundedChunkAndBackpressure');
  add(missing, positiveInteger(p.memoryBudgetBytes) &&
    Number.isSafeInteger(p.peakRssDeltaBytes) && p.peakRssDeltaBytes >= 0 &&
    p.peakRssDeltaBytes <= p.memoryBudgetBytes, 'measuredMemoryBudget');
  add(missing, positiveInteger(p.deadlineMs) &&
    Number.isSafeInteger(p.transferElapsedMs) && p.transferElapsedMs >= 0 &&
    p.transferElapsedMs <= p.deadlineMs, 'measuredTransferDeadline');
  add(missing, Number.isSafeInteger(p.freeDiskBytes) &&
    p.freeDiskBytes > p.bytes + 67_108_864, 'diskBudgetAndSafetyMargin');
  add(missing, typeof p.senderDeviceId === 'string' && p.senderDeviceId.length > 0 &&
    typeof p.receiverDeviceId === 'string' && p.receiverDeviceId.length > 0 &&
    p.senderDeviceId !== p.receiverDeviceId, 'distinctPhysicalDevices');
  add(missing, typeof p.operationId === 'string' && p.operationId.length > 0, 'operationId');
  add(missing, typeof p.destinationPath === 'string' && p.destinationPath.length > 0, 'destinationPath');
  add(missing, sha256.test(p.senderSha256 ?? '') && p.senderSha256 === p.receiverSha256,
    'independentReceiverReadbackSha256');
  add(missing, p.receiverReadbackBytes === p.bytes, 'independentReceiverReadbackBytes');
  add(missing, p.ack?.operationId === p.operationId &&
    p.ack?.receiverDeviceId === p.receiverDeviceId &&
    p.ack?.destinationPath === p.destinationPath &&
    p.ack?.sha256 === p.receiverSha256 && p.ack?.bytes === p.bytes,
  'scopedReceiverAck');
  add(missing, p.ackLossReplayTest === 'PASS' && p.resumeAfterReconnectTest === 'PASS' &&
    p.shaMismatchNegativeTest === 'PASS', 'physicalNegativeCases');
  add(missing, p.sourceSupportsOver256MiB === true && sha40.test(p.sourceSupportCommit ?? ''),
    'reviewedSourceRemovalOf256MiBGate');
  add(missing, p.medium === 'two-real-devices' && p.acceptanceApprovedByOwner === true,
    'ownerAuthorizedPhysicalSession');
  return {
    classification: missing.length ? 'NOT_VERIFIED' : 'EXTERNAL_REVIEW_REQUIRED',
    missing,
    sourceStillBoundedAt256MiB: p.sourceSupportsOver256MiB !== true,
    warning: 'Shape validation is not evidence authentication or release approval.',
  };
}

// D-129: offline cost forecasts and zero projected cents do not certify a
// provider bill, 24h soak or a guaranteed zero-invoice product policy.
export function auditS5CostEvidence(p = {}) {
  const missing = [];
  add(missing, sha40.test(p.commitSha ?? ''), 'exactCommitSha');
  add(missing, p.forecastClassification === 'OFFLINE_PROJECTION_NOT_PROVIDER_METER',
    'explicitForecastClassification');
  add(missing, p.zeroExtraInvoiceProven === false, 'noFalseZeroInvoiceClaim');
  add(missing, Number.isFinite(p.providerMeterWindowHours) &&
    p.providerMeterWindowHours >= 24 && positiveInteger(p.providerMeterRows),
    'measured24hProviderMeter');
  add(missing, p.providerInvoiceVerified === true, 'providerInvoice');
  add(missing, typeof p.currency === 'string' && /^[A-Z]{3}$/.test(p.currency),
    'rateCurrency');
  add(missing, Number.isFinite(p.measuredP50Ms) && Number.isFinite(p.measuredP95Ms) &&
    p.measuredP50Ms > 0 && p.measuredP95Ms >= p.measuredP50Ms,
    'measuredP50P95');
  add(missing, p.fairnessAndFailureBudgetTest === 'PASS', 'fairnessFailureBudget');
  add(missing, p.ownerBudgetApproval === true, 'ownerBudgetApproval');
  return {
    classification: missing.length ? 'COST_UNMEASURED' : 'EXTERNAL_REVIEW_REQUIRED',
    missing,
    zeroExtraInvoiceProven: false,
  };
}

// D-132: a passing *reproduction* test demonstrates a currently open defect;
// it must never be reported as a verified security fix.
export function auditSkillSymlinkEvidence(p = {}) {
  if (p.externalDirectoryReadObserved || p.externalManifestReadObserved) {
    return {classification: 'KNOWN_OPEN_GAP',
      missing: ['ownerSourceFix', 'rejectionInsteadOfReproduction', 'realPlatformValidation']};
  }
  const missing = [];
  add(missing, sha40.test(p.ownerFixCommit ?? ''), 'ownerFixCommit');
  add(missing, p.directLoadRejectsExternalDirectory === true, 'directorySymlinkRejection');
  add(missing, p.directLoadRejectsExternalManifest === true, 'manifestSymlinkRejection');
  add(missing, p.handleIdentityRaceTest === 'PASS', 'handleIdentityRaceTest');
  add(missing, p.platformTests?.windows === 'PASS' && p.platformTests?.linux === 'PASS' &&
    p.platformTests?.macos === 'PASS', 'crossPlatformFilesystemTests');
  return {classification: missing.length ? 'NOT_VERIFIED' : 'EXTERNAL_REVIEW_REQUIRED', missing};
}

// D-136: a 59-row historic snapshot is not a live proof for the newly pushed
// PR commit. A new exact-HEAD run must be compared independently.
export function auditPrInventoryFreshness(snapshot = {}, live = {}) {
  const rows = snapshot.prs;
  if (!Array.isArray(rows) || rows.length !== 59) {
    return {classification: 'INVALID_INVENTORY', reason: 'not exactly 59 entries'};
  }
  const ids = rows.map(p => p.number);
  if (new Set(ids).size !== 59 || rows.some(p => !positiveInteger(p.number) ||
      p.state !== 'open' || p.draft !== true || !sha40.test(p.head ?? ''))) {
    return {classification: 'INVALID_INVENTORY', reason: 'duplicate or invalid Draft row'};
  }
  const row = rows.find(p => p.number === live.prNumber);
  if (!row || !sha40.test(live.headSha ?? '') || row.head !== live.headSha) {
    return {classification: 'STALE_HEAD', total: rows.length,
      recordedHead: row?.head ?? null, currentHead: live.headSha ?? null};
  }
  if (!positiveInteger(live.runId) || row.run?.id !== live.runId ||
      row.run?.head_sha !== live.headSha || live.runConclusion !== 'success' ||
      row.run?.conclusion !== 'success') {
    return {classification: 'STALE_OR_UNVERIFIED_RUN', total: rows.length};
  }
  return {classification: 'SOURCE_INVENTORY_MATCH', total: rows.length,
    warning: 'Generic CI success does not prove delegated nested-test discovery.'};
}
