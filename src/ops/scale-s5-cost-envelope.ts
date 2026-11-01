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
  const estimatedCpuMs=Math.ceil(Number(monthlyWorker)*x.workerCpuMsPerRequest);
  if(!Number.isSafeInteger(estimatedCpuMs)){
    throw new Error('Projected Worker CPU exceeds precise arithmetic bounds');
  }
  const monthCpu=BigInt(estimatedCpuMs);
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

/** Separately priced OFFLINE scenarios; never a provider invoice or a complete bill. */
export const S5_COST_METERS = [
  'workerRequests','workerCpuMs','d1RowsRead','d1RowsWritten','monthlyBase',
] as const;
export type S5CostMeter = typeof S5_COST_METERS[number];
export type S5RateQuote = {
  amount:number; per:number; unit:'request'|'cpu-ms'|'row'|'month';
  currency:string; source:string;
};
export type S5RateQuotes = Partial<Record<S5CostMeter,S5RateQuote|null>>;
export type S5Unknown = 'UNKNOWN';
export type S5QuotedCostReport = {
  classification:'OFFLINE_SIMULATION_NOT_PROVIDER_BILL';
  currency:string|S5Unknown;
  monthlyUsage:CostEnvelope['monthly']|S5Unknown;
  freeThresholdSafeguard:{numericThresholdsFit:boolean|S5Unknown;
    zeroExtraInvoiceProven:false};
  componentCosts:Record<S5CostMeter,number|S5Unknown>;
  knownSubtotal:number|S5Unknown;
  modeledTotal:number|S5Unknown;
  modeledCostPerUser:number|S5Unknown;
  actualProviderBill:S5Unknown;
  missing:string[];
};
const S5_UNITS:Record<S5CostMeter,S5RateQuote['unit']>={
  workerRequests:'request',workerCpuMs:'cpu-ms',
  d1RowsRead:'row',d1RowsWritten:'row',monthlyBase:'month',
};
const S5_INPUT_KEYS=Object.keys(S5_ASSUMPTION_DEFAULTS) as (keyof S5CostInput)[];
const S5_CURRENCIES=new Set(Intl.supportedValuesOf('currency'));

/** Missing input/quotes stay UNKNOWN. Present but invalid numbers fail closed. */
export function quoteS5Cost(
  assumptions:Partial<S5CostInput>|null|undefined,
  rates:S5RateQuotes|null|undefined={},
):S5QuotedCostReport{
  if(rates===null||rates===undefined)rates={};
  if(typeof rates!=='object'||Array.isArray(rates))throw new Error('Invalid cost rates');
  for(const key of Object.keys(rates)){
    if(!(S5_COST_METERS as readonly string[]).includes(key))throw new Error('Unknown cost meter '+key);
  }
  const currencySet=new Set<string>();
  for(const meter of S5_COST_METERS){
    const rate=rates[meter];
    if(rate===undefined||rate===null)continue;
    if(typeof rate!=='object'||Array.isArray(rate)||
      !Number.isFinite(rate.amount)||rate.amount<0||
      !Number.isFinite(rate.per)||rate.per<=0||
      rate.unit!==S5_UNITS[meter]||
      typeof rate.source!=='string'||!rate.source.trim()||
      rate.source.trim().toUpperCase()==='UNKNOWN'||
      typeof rate.currency!=='string'||!S5_CURRENCIES.has(rate.currency)){
      throw new Error('Invalid cost rate '+meter);
    }
    for(const key of Object.keys(rate)){
      if(!['amount','per','unit','currency','source'].includes(key)){
        throw new Error('Unknown cost rate field '+meter+'.'+key);
      }
    }
    currencySet.add(rate.currency);
  }
  if(currencySet.size>1)throw new Error('Mixed cost currencies');
  const currency=currencySet.values().next().value??'UNKNOWN';
  if(assumptions!==null&&assumptions!==undefined&&
    (typeof assumptions!=='object'||Array.isArray(assumptions))){
    throw new Error('Invalid cost assumptions');
  }
  for(const key of Object.keys(assumptions??{})){
    if(!(S5_INPUT_KEYS as string[]).includes(key))throw new Error('Unknown cost assumption '+key);
  }
  for(const key of S5_INPUT_KEYS){
    const value=assumptions?.[key];
    if(value===undefined||value===null)continue;
    if(typeof value!=='number'||!Number.isFinite(value)||value<0||
      (key!=='workerCpuMsPerRequest'&&!Number.isSafeInteger(value))){
      throw new Error('Unsafe cost assumption '+key);
    }
  }
  const missing=S5_INPUT_KEYS.filter(key=>assumptions?.[key]===undefined||
    assumptions?.[key]===null).map(key=>'assumptions.'+key);
  const empty=Object.fromEntries(S5_COST_METERS.map(m=>[m,'UNKNOWN'])) as
    Record<S5CostMeter,number|S5Unknown>;
  for(const meter of S5_COST_METERS){
    if(rates[meter]===undefined||rates[meter]===null)missing.push('rates.'+meter);
  }
  const report:S5QuotedCostReport={
    classification:'OFFLINE_SIMULATION_NOT_PROVIDER_BILL',currency,
    monthlyUsage:'UNKNOWN',freeThresholdSafeguard:{
      numericThresholdsFit:'UNKNOWN',zeroExtraInvoiceProven:false},
    componentCosts:empty,knownSubtotal:'UNKNOWN',
    modeledTotal:'UNKNOWN',modeledCostPerUser:'UNKNOWN',
    actualProviderBill:'UNKNOWN',missing,
  };
  if(missing.some(item=>item.startsWith('assumptions.')))return report;
  const full=assumptions as S5CostInput;
  const estimate=estimateS5Cost(full);
  report.monthlyUsage=estimate.monthly;
  report.freeThresholdSafeguard.numericThresholdsFit=estimate.freeEnvelope.numericThresholdsFit;
  const quantities:Record<S5CostMeter,number>={
    workerRequests:Number(estimate.monthly.workerRequests),
    workerCpuMs:Number(estimate.monthly.workerCpuMs),
    d1RowsRead:Number(estimate.monthly.d1RowsRead),
    d1RowsWritten:Number(estimate.monthly.d1RowsWritten),monthlyBase:1,
  };
  let subtotal=0,known=0;
  for(const meter of S5_COST_METERS){
    const rate=rates[meter];
    if(!rate)continue;
    const raw=quantities[meter]*rate.amount/rate.per;
    if(!Number.isFinite(raw)||(quantities[meter]>0&&rate.amount>0&&raw===0)){
      throw new Error('Unsafe projected cost '+meter);
    }
    subtotal+=raw;
    if(!Number.isFinite(subtotal))throw new Error('Unsafe projected cost total');
    report.componentCosts[meter]=round(raw);
    known++;
  }
  if(known>0)report.knownSubtotal=round(subtotal);
  if(known===S5_COST_METERS.length){
    report.modeledTotal=round(subtotal);
    // A fixed monthly fee with zero users is not a zero per-user charge.
    if(full.activeUsers>0)report.modeledCostPerUser=round(subtotal/full.activeUsers);
  }
  return report;
}

const S5_CSV_HEADER=[
  'label','classification','currency','activeUsers','monthlyWorkerRequests',
  'monthlyWorkerCpuMs','monthlyD1RowsRead','monthlyD1RowsWritten',
  ...S5_COST_METERS.map(m=>'cost_'+m),
  'knownSubtotal','modeledTotal','modeledCostPerUser','actualProviderBill','missing',
];
function csvCell(value:string|number):string{
  const text=String(value);
  // Spreadsheet formula prefixes, including after leading whitespace, are data.
  const safe=/^[\s]*[=+\-@]/u.test(text)?"'"+text:text;
  return '"'+safe.replaceAll('"','""')+'"';
}
/** Stable, quoted CSV for the explicitly simulated report fields. */
export function formatS5CostCsv(rows:readonly {
  label:string;activeUsers:number|S5Unknown;report:S5QuotedCostReport;
}[]):string{
  const body=rows.map(({label,activeUsers,report})=>[
    label,report.classification,report.currency,activeUsers,
    report.monthlyUsage==='UNKNOWN'?'UNKNOWN':report.monthlyUsage.workerRequests,
    report.monthlyUsage==='UNKNOWN'?'UNKNOWN':report.monthlyUsage.workerCpuMs,
    report.monthlyUsage==='UNKNOWN'?'UNKNOWN':report.monthlyUsage.d1RowsRead,
    report.monthlyUsage==='UNKNOWN'?'UNKNOWN':report.monthlyUsage.d1RowsWritten,
    ...S5_COST_METERS.map(m=>report.componentCosts[m]),
    report.knownSubtotal,report.modeledTotal,report.modeledCostPerUser,
    report.actualProviderBill,report.missing.join(';'),
  ].map(csvCell).join(','));
  return [S5_CSV_HEADER.map(csvCell).join(','),...body].join('\n')+'\n';
}
