/**
 * Scale v2 HyperScale OFFLINE planning model (2026-10-15 provider price snapshot).
 * Never used by the live Worker, authorization, quota engine or billing.
 * Units are integer counts; all math is bigint to avoid unsafe integer overflow.
 *
 * Provider monthly baseline model ONLY:
 *   Workers Paid: $5 base, 10M included requests, $0.30/M beyond.
 *   D1 Paid: 25B rows read included, +$0.001/M;
 *            50M rows written included, +$1.00/M.
 * Excludes CPU, DO requests/duration/storage, D1 storage, queues, additional
 * service costs, taxes, egress/tunnels, etc.
 */
export interface ElasticScaleScenario {
  activeUsers: number;
  logicalCallsPerUserPerDay: number;
  workerRequestsPerLogicalCall: number;
  d1RowsReadPerLogicalCall: number;
  d1RowsWrittenPerLogicalCall: number;
  daysInMonth: number;
  retryBasisPoints: number; // retries of Worker ingress, 0..10000
  peakMultiplier: number;   // peak relative to a 24h average
  planDailyCallLimit: number; // ONLY entitlement; does not cap physical model
}

export interface ElasticScaleResult {
  dailyLogicalCalls: bigint;
  dailyWorkerRequests: bigint;
  monthlyWorkerRequests: bigint;
  monthlyD1RowsRead: bigint;
  monthlyD1RowsWritten: bigint;
  avgWorkerRequestsPerSecondCeiling: bigint;
  peakWorkerRequestsPerSecondCeiling: bigint;
  peakLogicalCallsPerUserSecondCeiling: bigint;
  exceedsUserPlan: boolean;
  modeledWorkerCostUSD: string;   // includes one $5 account base
  modeledD1RowCostUSD: string;
  modeledPartialCostUSD: string;   // NOT total provider invoice
}

function nat(x:number,name:string):bigint{
  if (!Number.isSafeInteger(x) || x<0) {
    throw new Error(name+' must be a nonnegative safe integer');
  }
  return BigInt(x);
}
function ceiling(n:bigint,d:bigint):bigint {
  return (n+d-1n)/d;
}
function above(actual:bigint,included:bigint):bigint {
  return actual>included?actual-included:0n;
}
// Exact pricing is calculated in USD nanodollars and rounded only on display.
function usd(nano:bigint):string {
  const cents=(nano+5_000_000n)/10_000_000n;
  return '$'+(cents/100n).toString()+'.'+(cents%100n).toString().padStart(2,'0');
}

export function estimateElasticScale(input:ElasticScaleScenario):ElasticScaleResult {
  const users=nat(input.activeUsers,'activeUsers');
  const perUser=nat(input.logicalCallsPerUserPerDay,'logicalCallsPerUserPerDay');
  const ingress=nat(input.workerRequestsPerLogicalCall,'workerRequestsPerLogicalCall');
  const reads=nat(input.d1RowsReadPerLogicalCall,'d1RowsReadPerLogicalCall');
  const writes=nat(input.d1RowsWrittenPerLogicalCall,'d1RowsWrittenPerLogicalCall');
  const days=nat(input.daysInMonth,'daysInMonth');
  const retry=nat(input.retryBasisPoints,'retryBasisPoints');
  const peak=nat(input.peakMultiplier,'peakMultiplier');
  const limit=nat(input.planDailyCallLimit,'planDailyCallLimit');
  if (days<1n || days>31n) throw new Error('daysInMonth must be 1..31');
  if (retry>10000n) throw new Error('retryBasisPoints must be <=10000');
  if (peak<1n || peak>1000n) throw new Error('peakMultiplier must be 1..1000');
  // There must be at least one hosted ingress; it cannot be made to vanish.
  if (ingress<1n) throw new Error('hosted tool call needs a Worker ingress');

  const dailyLogicalCalls=users*perUser;
  const dailyBaseWorkerRequests=dailyLogicalCalls*ingress;
  const dailyWorkerRequests=dailyBaseWorkerRequests+
    ceiling(dailyBaseWorkerRequests*retry,10000n);
  const monthlyWorkerRequests=dailyWorkerRequests*days;
  // D1 writes/read measured per *logical* accepted call. Retries may add
  // more reads/charges; this is an optimistic lower-bound assumption.
  const monthlyD1RowsRead=dailyLogicalCalls*reads*days;
  const monthlyD1RowsWritten=dailyLogicalCalls*writes*days;
  const workerNano=5_000_000_000n+
    above(monthlyWorkerRequests,10_000_000n)*300n;
  const d1Nano=
    above(monthlyD1RowsRead,25_000_000_000n)*1n+
    above(monthlyD1RowsWritten,50_000_000n)*1000n;
  return {
    dailyLogicalCalls,
    dailyWorkerRequests,
    monthlyWorkerRequests,
    monthlyD1RowsRead,
    monthlyD1RowsWritten,
    avgWorkerRequestsPerSecondCeiling:ceiling(dailyWorkerRequests,86400n),
    peakWorkerRequestsPerSecondCeiling:ceiling(dailyWorkerRequests*peak,86400n),
    peakLogicalCallsPerUserSecondCeiling:ceiling(perUser*peak,86400n),
    exceedsUserPlan:perUser>limit,
    modeledWorkerCostUSD:usd(workerNano),
    modeledD1RowCostUSD:usd(d1Nano),
    modeledPartialCostUSD:usd(workerNano+d1Nano),
  };
}
