/**
 * OPTIONAL Durable Object WSS topology. OFFLINE illustrative pricing model.
 * Not evidence that this Nexowire deployment actually uses a DO.
 *
 * Cloudflare DO pricing reference (2026-09-30):
 * https://developers.cloudflare.com/durable-objects/platform/pricing/
 * Pricing data must be reconfirmed before production.
 */
export interface S5DurableObjectAssumptions{
  activeUsers:number;
  callsPerUserDaily:number;
  connectedSocketsPerUser:number;
  socketUpgradesPerDay:number;
  inboundWebSocketMessagesPerCall:number;
  extraDoRpcSessionsPerCall:number;
  activeDoInstances:number;
  awakeSecondsPerDoInstanceDaily:number;
  days:number;
}
export interface S5DurableObjectProjection{
  kind:'OFFLINE_DO_TOPOLOGY_ASSUMPTIONS_NOT_BILLING_METRICS';
  daily:{webSocketUpgrades:string;inboundMessages:string;
    modeledChargedDoRequests:string;durationGbSeconds:string};
  monthly:{chargedDoRequests:string;durationGbSeconds:string};
  freeNumericBudget:{chargedRequestHeadroom:string;durationGbSecondsHeadroom:string;
    numericThresholdsFit:boolean;zeroExtraInvoiceProven:false};
  paidPartialUsd:{requests:number;duration:number;totalExcludingStorageAndOther:number};
  limitations:string[];
  assumptions:S5DurableObjectAssumptions;
}
const natural=(n:number,name:string,max:number)=>{
  if(!Number.isSafeInteger(n)||n<0||n>max)throw new Error('Invalid or unsafe '+name);
  return BigInt(n);
};
const overflow=(n:bigint)=>{if(n>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('Model exceeds precise arithmetic bounds')};
const above=(n:bigint,limit:bigint)=>n>limit?n-limit:0n;
const ceil=(n:bigint,denom:bigint)=>(n+denom-1n)/denom;
const dollars=(x:number)=>Math.round(x*100)/100;
export function estimateS5DurableObject(x:S5DurableObjectAssumptions):S5DurableObjectProjection{
  const u=natural(x.activeUsers,'activeUsers',10000000);
  const calls=natural(x.callsPerUserDaily,'callsPerUserDaily',850000);
  const sockets=natural(x.connectedSocketsPerUser,'connectedSocketsPerUser',16);
  const upgrades=natural(x.socketUpgradesPerDay,'socketUpgradesPerDay',1000);
  const messages=natural(x.inboundWebSocketMessagesPerCall,'inboundWebSocketMessagesPerCall',100);
  const rpc=natural(x.extraDoRpcSessionsPerCall,'extraDoRpcSessionsPerCall',100);
  const instances=natural(x.activeDoInstances,'activeDoInstances',100000);
  const awake=natural(x.awakeSecondsPerDoInstanceDaily,'awakeSecondsPerDoInstanceDaily',86400);
  const days=natural(x.days,'days',31);
  if(days<1n||(u>0n&&sockets<1n))throw new Error('Invalid model duration or WSS topology');
  // Messages are rounded globally. Actual per-connection rounding/abuse mix can
  // be MORE costly. This is NOT a billing upper bound.
  const logical=u*calls;
  const socketUpgrades=u*sockets*upgrades;
  const inbound=logical*messages;
  const billedDaily=socketUpgrades+ceil(inbound,20n)+logical*rpc;
  // Cloudflare DO duration billing uses 128MiB allocated memory per instance.
  // This assumes 0.125GiB per DO and independent nonhibernating object time.
  // DOs sharing hosts do not eliminate per-object duration charges.
  const durationGbSeconds=ceil(instances*awake,8n);
  const monthRequests=billedDaily*days;
  const monthDuration=durationGbSeconds*days;
  [logical,socketUpgrades,inbound,billedDaily,durationGbSeconds,monthRequests,monthDuration].forEach(overflow);
  const paidRequests=dollars(Number(above(monthRequests,1000000n))/1000000*0.15);
  const paidDuration=dollars(Number(above(monthDuration,400000n))/1000000*12.50);
  return {
    kind:'OFFLINE_DO_TOPOLOGY_ASSUMPTIONS_NOT_BILLING_METRICS',
    daily:{webSocketUpgrades:String(socketUpgrades),inboundMessages:String(inbound),
      modeledChargedDoRequests:String(billedDaily),durationGbSeconds:String(durationGbSeconds)},
    monthly:{chargedDoRequests:String(monthRequests),durationGbSeconds:String(monthDuration)},
    freeNumericBudget:{chargedRequestHeadroom:String(100000n-billedDaily),
      durationGbSecondsHeadroom:String(13000n-durationGbSeconds),
      numericThresholdsFit:billedDaily<=100000n&&durationGbSeconds<=13000n,
      zeroExtraInvoiceProven:false},
    paidPartialUsd:{requests:paidRequests,duration:paidDuration,
      totalExcludingStorageAndOther:dollars(paidRequests+paidDuration)},
    limitations:[
      'This route is optional: whether DO hosts Nexowire WSS is NOT verified',
      'Global 20:1 message billing approximation may UNDERESTIMATE per-connection billing',
      'awakeSecondsPerDoInstanceDaily must be observed; idle socket hibernation is not assumed',
      'DO upgrades are ALSO Worker HTTP ingress when routed through a Worker; count separately',
      'No DO storage, Durable Object operations, D1, Workers, tunnels, ISP, outbound relay, tax, or account plan base included',
      'Free envelope is an illustrative numeric test, NOT a promise of no invoice or uptime',
    ],
    assumptions:x,
  };
}
export const S5_DO_EXAMPLES={
  hibernatingOneDo:{
    activeUsers:100,callsPerUserDaily:205,connectedSocketsPerUser:1,
    socketUpgradesPerDay:1,inboundWebSocketMessagesPerCall:1,
    extraDoRpcSessionsPerCall:0,activeDoInstances:1,
    awakeSecondsPerDoInstanceDaily:0,days:30,
  },
  oneDoAlwaysAwake:{
    activeUsers:100,callsPerUserDaily:205,connectedSocketsPerUser:1,
    socketUpgradesPerDay:1,inboundWebSocketMessagesPerCall:1,
    extraDoRpcSessionsPerCall:0,activeDoInstances:1,
    awakeSecondsPerDoInstanceDaily:86400,days:30,
  },
  twoDoAlwaysAwake:{
    activeUsers:100,callsPerUserDaily:205,connectedSocketsPerUser:1,
    socketUpgradesPerDay:1,inboundWebSocketMessagesPerCall:1,
    extraDoRpcSessionsPerCall:0,activeDoInstances:2,
    awakeSecondsPerDoInstanceDaily:86400,days:30,
  },
} as const satisfies Record<string,S5DurableObjectAssumptions>;
