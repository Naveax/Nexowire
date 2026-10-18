/** S5 offline tenant fairness analyzer. No identities or per-tenant labels retained. */
export interface S5TenantCounts{
  attempted:number;
  reserved:number;
  transportDenied:number;
  quotaDenied:number;
}
export interface S5FairnessSummary{
  kind:'OFFLINE_TENANT_FAIRNESS_ANALYSIS';
  tenants:number;
  attempted:number;
  reserved:number;
  transportDenied:number;
  quotaDenied:number;
  starvedTenants:number;
  rawSuccessCountJain:number;
  demandNormalizedJain:number;
  minAdmissionRatio:number;
  maxAdmissionRatio:number;
  definition:'admitted / attempted per tenant; NOT weighted fairness or proof of isolation';
}
export function analyzeS5Fairness(rows:readonly S5TenantCounts[]):S5FairnessSummary{
  if(rows.length<1||rows.length>10000)throw new Error('Invalid number of S5 tenants');
  const valid=(n:number)=>Number.isSafeInteger(n)&&n>=0;
  let attempted=0,reserved=0,transportDenied=0,quotaDenied=0,starvedTenants=0;
  const ratios:number[]=[];
  const successes:number[]=[];
  for(const x of rows){
    if(!valid(x.attempted)||!valid(x.reserved)||!valid(x.transportDenied)||
      !valid(x.quotaDenied)||x.attempted<1||
      x.attempted!==x.reserved+x.transportDenied+x.quotaDenied){
      throw new Error('Invalid or unbalanced fairness counters');
    }
    attempted+=x.attempted;reserved+=x.reserved;
    transportDenied+=x.transportDenied;quotaDenied+=x.quotaDenied;
    if(![attempted,reserved,transportDenied,quotaDenied].every(Number.isSafeInteger)){
      throw new Error('Fairness counter overflow');
    }
    const r=x.reserved/x.attempted;
    if(x.reserved===0)starvedTenants++;
    ratios.push(r);successes.push(x.reserved);
  }
  const jain=(a:number[])=>{
    const total=a.reduce((s,x)=>s+x,0);
    const denom=a.length*a.reduce((s,x)=>s+x*x,0);
    return Number((denom>0?total*total/denom:0).toFixed(5));
  };
  return {kind:'OFFLINE_TENANT_FAIRNESS_ANALYSIS',tenants:rows.length,
    attempted,reserved,transportDenied,quotaDenied,starvedTenants,
    rawSuccessCountJain:jain(successes),demandNormalizedJain:jain(ratios),
    minAdmissionRatio:Math.min(...ratios),maxAdmissionRatio:Math.max(...ratios),
    definition:'admitted / attempted per tenant; NOT weighted fairness or proof of isolation'};
}
