/**
 * S1: deterministic, OFFLINE Worker-ingress capacity estimate.
 * Values are assumptions; never use this model to grant hosted quotas.
 */
export interface ScaleWorkerDemand {
  activeUsers: number;
  hostedToolCallsPerUserPerDay: number;
  authWorkerRequestsPerTool: number;
  chargeWorkerRequestsPerTool: number;
  otherWorkerRequestsPerUserPerDay: number;
  fixedWorkerRequestsPerDay: number;
  retryPermille: number;
  workerRequestBudgetPerDay: number;
}

export interface ScaleWorkerCapacityResult {
  hostedToolInvocations: number;
  authRequests: number;
  chargeRequests: number;
  otherRequests: number;
  fixedRequests: number;
  retryRequests: number;
  estimatedWorkerRequests: number;
  remainingWorkerRequests: number;
  withinBudget: boolean;
}

function natural(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(name + ' must be a non-negative safe integer');
  }
  return value;
}
function sum(a:number,b:number):number {
  return natural(a + b, 'capacity result');
}
function mul(a:number,b:number):number {
  return natural(a*b, 'capacity result');
}
function retryCount(base:number,permille:number):number {
  // Avoid floating point overflow, while rounding up individual extra requests.
  const quotient=Math.floor(base/1000);
  const remainder=base%1000;
  return sum(mul(quotient,permille), Math.ceil(remainder*permille/1000));
}
export function estimateScaleWorkerDemand(input:ScaleWorkerDemand):ScaleWorkerCapacityResult {
  const users=natural(input.activeUsers,'activeUsers');
  const callsPerUser=natural(input.hostedToolCallsPerUserPerDay,'hostedToolCallsPerUserPerDay');
  const auth=natural(input.authWorkerRequestsPerTool,'authWorkerRequestsPerTool');
  const charge=natural(input.chargeWorkerRequestsPerTool,'chargeWorkerRequestsPerTool');
  const other=natural(input.otherWorkerRequestsPerUserPerDay,'otherWorkerRequestsPerUserPerDay');
  const fixed=natural(input.fixedWorkerRequestsPerDay,'fixedWorkerRequestsPerDay');
  const budget=natural(input.workerRequestBudgetPerDay,'workerRequestBudgetPerDay');
  const retry=natural(input.retryPermille,'retryPermille');
  if (retry>1000) throw new Error('retryPermille must be <= 1000');
  const tools=mul(users,callsPerUser);
  const authRequests=mul(tools,auth);
  const chargeRequests=mul(tools,charge);
  const otherRequests=mul(users,other);
  const subtotal=sum(sum(sum(authRequests,chargeRequests),otherRequests),fixed);
  const retryRequests=retryCount(subtotal,retry);
  const demand=sum(subtotal,retryRequests);
  return {
    hostedToolInvocations:tools,
    authRequests,
    chargeRequests,
    otherRequests,
    fixedRequests:fixed,
    retryRequests,
    estimatedWorkerRequests:demand,
    remainingWorkerRequests:budget-demand,
    withinBudget:demand<=budget,
  };
}

/** No allocation/load; binary-search maximum active users under fixed assumptions. */
export function maxActiveUsersUnderBudget(
  input:Omit<ScaleWorkerDemand,'activeUsers'>,
):number {
  const empty=estimateScaleWorkerDemand({...input,activeUsers:0});
  if (!empty.withinBudget) return 0;
  const one=estimateScaleWorkerDemand({...input,activeUsers:1});
  if (one.estimatedWorkerRequests===empty.estimatedWorkerRequests) {
    // Zero per-user requests; this model has no finite capacity-bound user ceiling.
    return Number.MAX_SAFE_INTEGER;
  }
  let lo=0;
  let hi=Math.min(input.workerRequestBudgetPerDay+1,Number.MAX_SAFE_INTEGER);
  while(lo<hi) {
    const mid=lo+Math.ceil((hi-lo)/2);
    const within=estimateScaleWorkerDemand({...input,activeUsers:mid}).withinBudget;
    if (within) lo=mid;
    else hi=mid-1;
  }
  return lo;
}
