#!/usr/bin/env node
/** Issue #487/#588: offline evidence-shape validator. It cannot authenticate external proof. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const SHA256 = /^[0-9a-f]{64}$/i;
const COMMIT = /^[0-9a-f]{40}$/i;
const TARGET_SIZES = [226304, 1048576, 268435457, 1073741824]; // 221KiB, 1MiB, 256MiB+1, 1GiB
const NO_PROOF = 'UNKNOWN_OR_NOT_RUN';

function finiteNonnegative(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0; }
function integerNonnegative(v) { return Number.isSafeInteger(v) && v >= 0; }
function nonempty(v) { return typeof v === 'string' && v.trim().length > 0 && !/^(UNKNOWN|NOT_RUN|PENDING)$/i.test(v.trim()); }
function validWindow(window) {
  const a=Date.parse(window?.start ?? ''), b=Date.parse(window?.end ?? '');
  return Number.isFinite(a) && Number.isFinite(b) && b > a;
}
function within24Hours(window) {
  return validWindow(window) && Date.parse(window.end) - Date.parse(window.start) >= 24*60*60*1000;
}

export function providerCostGate(s5) {
  const blockers=[];
  if (!COMMIT.test(s5?.sourceCommit ?? '')) blockers.push('MISSING_SOURCE_SHA');
  if (!nonempty(s5?.ownerApprovalRef)) blockers.push('NO_OWNER_APPROVAL');
  const live = s5?.runType === 'actual_hosted_provider' && s5?.environment === 'staging';
  if (!live || !within24Hours(s5?.measurementWindow)) blockers.push('NO_24H_HOSTED_MEASUREMENT');
  if (!nonempty(s5?.providerName) || !nonempty(s5?.providerAccountScope)) blockers.push('PROVIDER_IDENTITY_UNKNOWN');
  const m=s5?.metrics;
  const metricKeys=['usersPerDay','hostedIngressCalls','cpuMilliseconds','d1Reads','d1Writes','relayBytes','reconnects','failedCalls'];
  if (!m || metricKeys.some(k=>!integerNonnegative(m[k])) ||
    !finiteNonnegative(m.p50Milliseconds) || !finiteNonnegative(m.p95Milliseconds) ||
    m.p95Milliseconds < m.p50Milliseconds) blockers.push('REAL_METER_OR_LATENCY_MISSING');
  if (!Array.isArray(s5?.forecasts) || [100,1000,10000].some(t=>
    !s5.forecasts.some(f=>f.users===t && f.basedOnMeasuredWindow===true &&
      finiteNonnegative(f.projectedProviderCostUsd)))) blockers.push('MEASURED_BASED_CAPACITY_FORECAST_INCOMPLETE');
  const bill=s5?.providerInvoice;
  if (bill?.kind!=='provider_actual' || !nonempty(bill.documentRef) ||
    !nonempty(bill.currency) || !integerNonnegative(bill.amountMinorUnits) ||
    !validWindow(bill.period)) blockers.push('REAL_PROVIDER_INVOICE_UNVERIFIED');
  if (m?.billingPausedProbe?.executed !== true || m?.billingPausedProbe?.denialProven !== true ||
    m?.quotaExhaustionProbe?.executed !== true || m?.quotaExhaustionProbe?.denialProven !== true)
    blockers.push('QUOTA_BILLING_DENIAL_NOT_PROVEN');
  return {
    issue:487,blockingReasons:blockers,
    evidenceStage:blockers.length?'INSUFFICIENT_REAL_EVIDENCE':'EVIDENCE_FIELDS_PRESENT_PENDING_AUTHENTICITY_AND_OWNER_REVIEW',
    claimedInvoiceUnverified:bill?.kind==='provider_actual' && integerNonnegative(bill.amountMinorUnits)&&nonempty(bill.currency)
      ? {currency:bill.currency, minorUnits:bill.amountMinorUnits} : NO_PROOF,
    actualProviderCostUsd:NO_PROOF,
    productionAccepted:false,ownerReviewRequired:true,
  };
}

export function transferCaseGate(c) {
  const blockers=[];
  if(!integerNonnegative(c?.sizeBytes) || c.sizeBytes===0) blockers.push('INVALID_SIZE');
  if (!nonempty(c?.testDeviceAuthorizationRef) || !nonempty(c?.senderDeviceId) ||
    !nonempty(c?.receiverDeviceId) || c.senderDeviceId===c.receiverDeviceId)
    blockers.push('TWO_AUTHORIZED_DISTINCT_DEVICES_UNPROVEN');
  if (!nonempty(c?.sessionId) || !nonempty(c?.destinationPath)) blockers.push('SESSION_OR_DESTINATION_UNBOUND');
  if(!integerNonnegative(c?.transferredBytes) || c.transferredBytes!==c.sizeBytes ||
    !integerNonnegative(c?.receiverStoredBytes) || c.receiverStoredBytes!==c.sizeBytes)
    blockers.push('BYTE_COUNTS_UNVERIFIED');
  if(!SHA256.test(c?.senderDigest ?? '') || !SHA256.test(c?.independentReceiverReadbackDigest ?? '') ||
    c.senderDigest.toLowerCase()!==c.independentReceiverReadbackDigest.toLowerCase())
    blockers.push('INDEPENDENT_RECEIVER_DIGEST_MISSING_OR_DIFFERENT');
  const ack=c?.ack;
  if(!ack || ack.acknowledged!==true || ack.sessionId!==c.sessionId ||
    ack.deviceId!==c.receiverDeviceId || ack.destinationPath!==c.destinationPath ||
    !SHA256.test(ack.receiverDigest ?? '') ||
    ack.receiverDigest.toLowerCase()!==String(c.independentReceiverReadbackDigest ?? '').toLowerCase())
    blockers.push('RECEIVER_ACK_MISSING_OR_UNBOUND');
  if (!validWindow(c?.transferWindow) || !nonempty(c?.senderArtifactRef) ||
    !nonempty(c?.receiverArtifactRef)) blockers.push('DURABLE_TWO_SIDED_ARTIFACTS_ABSENT');
  if (!integerNonnegative(c?.peakProcessRssBytes) ||
    !integerNonnegative(c?.maxRequestChunkBytes) || c.maxRequestChunkBytes===0 ||
    !integerNonnegative(c?.approvedChunkLimitBytes) || c.approvedChunkLimitBytes===0 ||
    c.maxRequestChunkBytes>c.approvedChunkLimitBytes || !nonempty(c?.chunkPolicyRef))
    blockers.push('BOUNDED_STREAMING_MEMORY_UNPROVEN');
  return {sizeBytes:c?.sizeBytes??null,blockingReasons:blockers,
    evidenceStage:blockers.length?'INCOMPLETE_PHYSICAL_EVIDENCE':'FIELDS_PRESENT_PENDING_INDEPENDENT_DEVICE_REVIEW',
    physicalAccepted:false};
}

export function largeTransferGate(transfer) {
  const blockers=[];
  if (!COMMIT.test(transfer?.sourceCommit ?? '')) blockers.push('MISSING_SOURCE_SHA');
  if (transfer?.runType!=='authorized_physical_two_pc') blockers.push('PHYSICAL_TWO_PC_NOT_RUN');
  if(!Array.isArray(transfer?.cases)) blockers.push('NO_PHYSICAL_TRANSFER_CASES');
  const checked=(transfer?.cases ?? []).map(transferCaseGate);
  for(const n of TARGET_SIZES) if(!checked.some(c=>c.sizeBytes===n&&c.blockingReasons.length===0))
    blockers.push(`SIZE_${n}_ACCEPTANCE_MISSING`);
  if(!Array.isArray(transfer?.negativeCases) ||
    ['ACK_LOST','OFFSET_DRIFT','SOURCE_REPLACED','CORRUPT_CHUNK','DISK_FULL'].some(t=>
      !transfer.negativeCases.some(c=>c.scenario===t && c.deniedSafely===true && nonempty(c.artifactRef))))
    blockers.push('FAILURE_AND_RESUME_CASES_INCOMPLETE');
  return {issue:588,blockingReasons:blockers,cases:checked,
    evidenceStage:blockers.length?'INCOMPLETE_PHYSICAL_EVIDENCE':'FIELDS_PRESENT_PENDING_OWNER_REVIEW',
    physicalAccepted:false,ownerReviewRequired:true};
}

export function auditAcceptance(value) {
  if (!value || value.schemaVersion!==1) throw Error('Unknown evidence schema version');
  return {
    generatedAt:value.generatedAt,
    s5:providerCostGate(value.s5),transfer:largeTransferGate(value.transfer),
    sourceAcceptance:false,physicalAcceptance:'NOT_RUN_OR_NOT_INDEPENDENTLY_VERIFIED',
    mergingAuthorized:false,productionAccepted:false,
  };
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const i=process.argv.indexOf('--offline');
  if(i<0||!process.argv[i+1])throw Error('Usage: --offline <acceptance.json>');
  readFile(process.argv[i+1],'utf8').then(JSON.parse).then(auditAcceptance)
    .then(result=>process.stdout.write(JSON.stringify(result,null,2)+'\n'))
    .catch(e=>{console.error(e.message);process.exitCode=1;});
}
