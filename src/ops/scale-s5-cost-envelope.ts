/**
 * S5 OFFLINE bill envelope, sourced from Cloudflare 2026-10 docs.
 * Assumptions MUST be replaced by account meter observations before release.
 * Excludes DO, paid tunnel/provider, storage overage, relay and bandwidth contract.
 */
export interface S5CostInput{
  activeUsers:number; callsPerUserDaily:number;
  workerRequestsPerCall:number; controlRequestsPerUserDaily:number;
  d1ReadsPerCall:number; d1WritesPerCall:number;
  reconnectionsPerUserDaily:number; connectionsPerUser:number;
  retryBasisPoints:number; days:number; workerCpuMsPerRequest:number;
  relayBytesPerCall:number; relayFractionBasisPoints:number;
}
export type CostEnvelope={
  classification:'OFFLINE_PROJECTION_NOT_PROVIDER_METER';
  daily:{logicalCalls:string;workerRequests:string;d1RowsRead:string;d1RowsWritten:string;
    wsUpgrades:string;relayGiBApprox:number};
  monthly:{workerRequests:string;d1RowsRead:string;d1RowsWritten:string;workerCpuMs:string};
  freeEnvelope:{workerRequestHeadroom:string;d1ReadHeadroom:string;d1WriteHeadroom:string;
    numericThresholdsFit:boolean;zeroExtraInvoiceProven:false;excludedFactors:string[]};
  paidPartialUsd:{workersAndCpu:number;d1Rows:number;minimumPlanBaseIncluded:boolean;
    totalExcludingUnknown:number;excludedFactors:string[]};
  assumptions:S5CostInput;
};
function nat(n:number,name:string,max=1_000_000_000):bigint{
  if(!Number.isSafeInteger(n)||n<0||n>max)throw new Error('Unsafe cost input '+name);
  return BigInt(n);
}
function above(x:bigint,y:bigint){return x>y?x-y:0n}
function round(n:number){return Math.round(n*100)/100}
const EXCLUDED=[
  'Cloudflare Durable Objects: WebSocket messages, hibernation eligibility, duration',
  'Additional paid Cloudflare features, custom tunnels, Argo, domain, taxes',
  'D1/WSS/relay disk and operator network bandwidth where separately charged',
  'D1 database storage, logs, egress contracts and other provider/ISP bills',
  'OpenAI ingress / Secure MCP Tunnel / paid models and upstream fair-use rules',
  'Real worker CPU timing, traffic class mix, retry rates and per-call D1 metadata',
];
export function estimateS5Cost(x:S5CostInput):CostEnvelope{
  const users=nat(x.activeUsers,'activeUsers');
  const calls=nat(x.callsPerUserDaily,'callsPerUserDaily');
  const fanout=nat(x.workerRequestsPerCall,'workerRequestsPerCall',100);
  const control=nat(x.controlRequestsPerUserDaily,'controlRequestsPerUserDaily',10000);
  const reads=nat(x.d1ReadsPerCall,'d1ReadsPerCall',1000);
  const writes=nat(x.d1WritesPerCall,'d1WritesPerCall',1000);
  const reconnects=nat(x.reconnectionsPerUserDaily,'reconnectionsPerUserDaily',1000);
  const sockets=nat(x.connectionsPerUser,'connectionsPerUser',100);
  const bp=nat(x.retryBasisPoints,'retryBasisPoints',10000);
  const days=nat(x.days,'days',31);
  const relayBytes=nat(x.relayBytesPerCall,'relayBytesPerCall',1_000_000_000);
  const relayBP=nat(x.relayFractionBasisPoints,'relayFractionBasisPoints',10000);
  if(fanout<1n||days<1n||!Number.isFinite(x.workerCpuMsPerRequest)||
    x.workerCpuMsPerRequest<0||x.workerCpuMsPerRequest>300000){
    throw new Error('Invalid Worker fanout, days or assumed CPU');
  }
  const logical=users*calls;
  if(logical*days>BigInt(Number.MAX_SAFE_INTEGER)){
    throw new Error('Projected monthly logical calls exceed precise cost bounds');
  }
  const upgrades=users*sockets*reconnects;
  const workerBase=logical*fanout+users*control+upgrades;
  const worker=workerBase+(workerBase*bp+9999n)/10000n;
  const r=logical*reads,w=logical*writes;
  const monthlyWorker=worker*days,monthlyRead=r*days,monthlyWrite=w*days;
  if([monthlyWorker,monthlyRead,monthlyWrite].some(n=>n>BigInt(Number.MAX_SAFE_INTEGER))){
    throw new Error('Projected monthly provider usage exceeds precise cost bounds');
  }
  // CPU is a declared assumption, not runtime measured.
  const monthCpu=BigInt(Math.ceil(Number(monthlyWorker)*x.workerCpuMsPerRequest));
  const cpuAbove=above(monthCpu,30_000_000n);
  const paidWorkers=5+
    Number(above(monthlyWorker,10_000_000n))/1_000_000*0.30+
    Number(cpuAbove)/1_000_000*0.02;
  const paidD1=Number(above(monthlyRead,25_000_000_000n))/1_000_000*0.001+
    Number(above(monthlyWrite,50_000_000n))/1_000_000*1;
  const freeReq=100_000n,freeRead=5_000_000n,freeWrite=100_000n;
  const numericFit=worker<=freeReq&&r<=freeRead&&w<=freeWrite &&
    x.workerCpuMsPerRequest<=10;
  const relayGiBApprox=Number(logical*relayBytes*relayBP)/10000/1024**3;
  return {
    classification:'OFFLINE_PROJECTION_NOT_PROVIDER_METER',
    daily:{logicalCalls:String(logical),workerRequests:String(worker),
      d1RowsRead:String(r),d1RowsWritten:String(w),wsUpgrades:String(upgrades),
      relayGiBApprox:Number(relayGiBApprox.toFixed(4))},
    monthly:{workerRequests:String(monthlyWorker),d1RowsRead:String(monthlyRead),
      d1RowsWritten:String(monthlyWrite),workerCpuMs:String(monthCpu)},
    freeEnvelope:{workerRequestHeadroom:String(freeReq-worker),
      d1ReadHeadroom:String(freeRead-r),d1WriteHeadroom:String(freeWrite-w),
      numericThresholdsFit:numericFit,zeroExtraInvoiceProven:false,
      excludedFactors:EXCLUDED},
    paidPartialUsd:{workersAndCpu:round(paidWorkers),d1Rows:round(paidD1),
      minimumPlanBaseIncluded:true,totalExcludingUnknown:round(paidWorkers+paidD1),
      excludedFactors:EXCLUDED},
    assumptions:x,
  };
}
export const S5_ASSUMPTION_DEFAULTS:S5CostInput=Object.freeze({
  activeUsers:100,callsPerUserDaily:205,workerRequestsPerCall:2,
  controlRequestsPerUserDaily:4,d1ReadsPerCall:4,d1WritesPerCall:2,
  reconnectionsPerUserDaily:1,connectionsPerUser:1,
  retryBasisPoints:500,days:30,workerCpuMsPerRequest:1,
  relayBytesPerCall:10_240,relayFractionBasisPoints:3000,
});
export function projectS5Matrix(){
  const scenarios=[
    {label:'100 users / mixed utilization',activeUsers:100,callsPerUserDaily:205},
    {label:'1000 users / mixed utilization',activeUsers:1000,callsPerUserDaily:205},
    {label:'10000 users / mixed utilization',activeUsers:10000,callsPerUserDaily:205},
    {label:'100 users / future Free full usage',activeUsers:100,callsPerUserDaily:1000},
    {label:'1 Custom 850k per day',activeUsers:1,callsPerUserDaily:850000},
  ];
  return scenarios.map(s=>({label:s.label,...estimateS5Cost({...S5_ASSUMPTION_DEFAULTS,
    activeUsers:s.activeUsers,callsPerUserDaily:s.callsPerUserDaily})}));
}
