import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync=promisify(execFile);

export interface SafeFunnelPlan {
  state: 'not-connected'|'no-tunnel'|'needs-migration'|'origin-ready'|'blocked';
  tailscaleOnline: boolean;
  stableDnsReady: boolean;
  currentPublicRouteCount: number;
  currentPublicHubDirectRoutes: number;
  currentPublicProtectedIngressRoutes: number;
  unknownPublicRoutes: number;
  recommendedOrigin: 'http://127.0.0.1:43111';
  requiresStagedMigration: boolean;
  readyToExpose: false; // Never authorize a new public route based on diagnostics.
  nextAction: string;
}

/**
 * Interprets only the redacted structure of Tailscale's local status/config.
 * This intentionally NEVER emits MagicDNS domain, user names, IPs,
 * local credentials or any provider operation that changes public routes.
 * The owner must separately review stable DNS, real OAuth and quota.
 */
export function analyzeLocalFirstFunnel(
  tailscaleStatusJson:string,
  funnelStatusJson:string,
):SafeFunnelPlan {
  let status:unknown,funnel:unknown;
  try {
    status=JSON.parse(tailscaleStatusJson);
    funnel=JSON.parse(funnelStatusJson);
  } catch {
    throw new Error('Cannot parse read-only Tailscale status safely');
  }
  if(!status || typeof status!=='object' ||
      !funnel || typeof funnel!=='object') {
    throw new Error('Tailscale status contains invalid structures');
  }
  const t=status as Record<string,unknown>;
  const f=funnel as Record<string,unknown>;
  const self=t.Self as Record<string,unknown>|undefined;
  const tailnet=t.CurrentTailnet as Record<string,unknown>|undefined;
  const tailscaleOnline=t.BackendState==='Running' && self?.Online===true;
  const stableDnsReady=tailscaleOnline &&
    typeof self?.DNSName==='string' && self.DNSName.length>0 &&
    typeof tailnet?.MagicDNSSuffix==='string' &&
    tailnet.MagicDNSSuffix.length>0;

  if(!f.Web || typeof f.Web!=='object' || Array.isArray(f.Web) ||
      Object.keys(f).some(x=>!['Web','TCP','AllowFunnel'].includes(x))) {
    throw new Error('Unknown Tailscale Funnel schema; refuse public migration');
  }
  let publicRoutes=0,hubDirect=0,protectedIngress=0,unknown=0;
  const allowed=f.AllowFunnel;
  const publiclyEnabled=allowed && typeof allowed==='object' &&
    !Array.isArray(allowed) ? allowed as Record<string,unknown> : null;
  const web=f.Web as Record<string,unknown>;
  const tcp=f.TCP;
  if(!tcp || typeof tcp!=='object' || Array.isArray(tcp)) {
    throw new Error('Unknown Tailscale TCP schema; refuse public migration');
  }
  for(const entry of Object.values(tcp as Record<string,unknown>)) {
    if(!entry || typeof entry!=='object' || Array.isArray(entry)){
      unknown++;continue;
    }
    const values=entry as Record<string,unknown>;
    if(values.HTTPS!==true || Object.keys(values).some(key=>key!=='HTTPS')){
      // Raw TCP forwards and custom TLS termination can expose the Hub
      // without going through the MCP-only path filter.
      unknown++;
    }
  }
  if(allowed && (typeof allowed!=='object' || Array.isArray(allowed))) {
    unknown++;
  }
  for(const [address,entry] of Object.entries(web)){
    if(!entry || typeof entry!=='object' || Array.isArray(entry)){
      unknown++;continue;
    }
    const handlers=(entry as Record<string,unknown>).Handlers;
    if(!handlers || typeof handlers!=='object' || Array.isArray(handlers)){
      unknown++;continue;
    }
    // Only routes explicitly published with AllowFunnel count as public.
    // Any unknown public config fails closed rather than being guessed away.
    const active=publiclyEnabled?.[address]===true;
    for(const [route,handler] of Object.entries(handlers)){
      if(!active)continue;
      publicRoutes++;
      const proxy=handler && typeof handler==='object'
        ? (handler as Record<string,unknown>).Proxy : undefined;
      if(route!=='/' || typeof proxy!=='string'){
        unknown++;continue;
      }
      let endpoint:URL;
      try {endpoint=new URL(proxy)}catch {unknown++;continue}
      if(endpoint.protocol!=='http:' ||
          !['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname) ||
          endpoint.username || endpoint.password ||
          endpoint.pathname!=='/' || endpoint.search || endpoint.hash) {
        unknown++;continue;
      }
      if(endpoint.port==='43110')hubDirect++;
      else if(endpoint.port==='43111')protectedIngress++;
      else unknown++;
    }
  }

  const base={tailscaleOnline,stableDnsReady,
    currentPublicRouteCount:publicRoutes,
    currentPublicHubDirectRoutes:hubDirect,
    currentPublicProtectedIngressRoutes:protectedIngress,
    unknownPublicRoutes:unknown,
    recommendedOrigin:'http://127.0.0.1:43111' as const,
    readyToExpose:false as const};
  if(!tailscaleOnline || !stableDnsReady)return {
    ...base,state:'not-connected',requiresStagedMigration:false,
    nextAction:'Connect Tailscale/MagicDNS; do not modify existing routes.',
  };
  if(unknown>0)return {
    ...base,state:'blocked',requiresStagedMigration:hubDirect>0,
    nextAction:'Unrecognized public route: operator review required before any migration.',
  };
  if(hubDirect>0)return{
    ...base,state:'needs-migration',requiresStagedMigration:true,
    nextAction:'An existing public route points to 43110 (/agent included). Review a staged switch to 43111; do NOT overwrite the active Funnel.',
  };
  if(protectedIngress>0)return{
    ...base,state:'origin-ready',requiresStagedMigration:false,
    nextAction:'Protected ingress is configured. Real OAuth, quota, public path and off-network tests still required.',
  };
  return{
    ...base,state:'no-tunnel',requiresStagedMigration:false,
    nextAction:'No known public MCP route; prepare verified OAuth and stable HTTPS before opt-in Funnel.',
  };
}

/** READ ONLY: no tailscale serve/funnel set/reset, no token/domain output. */
export async function readOnlyLocalFirstFunnelPlan(
  run: (args:readonly string[])=>Promise<string>=async args=>{
    const response=await execFileAsync('tailscale',[...args],{
      windowsHide:true,timeout:7500,maxBuffer:1024*1024,
    });
    return response.stdout;
  },
):Promise<SafeFunnelPlan> {
  const status=await run(['status','--json']);
  const funnel=await run(['funnel','status','--json']);
  return analyzeLocalFirstFunnel(status,funnel);
}
