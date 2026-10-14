import type {ControlPlaneMcpClientOptions,RemoteMcpAuthorization} from './control-plane-mcp-auth.js';

export type FusedMcpClientDecision =
  | {kind:'authorized'; authorization:RemoteMcpAuthorization; chargedCredits:number; remainingCredits:number|null}
  | {kind:'rejected'; httpStatus:400|401|403|409|429; code:string; remainingCredits:number|null}
  | {kind:'unavailable'; code:'MCP_AUTH_CHARGE_UNAVAILABLE'};

function validText(value:unknown):value is string {
  return typeof value==='string' && value.trim().length>0 &&
    value.length<=128 && !/[\u0000-\u001f\u007f]/.test(value);
}
function parseAuthorization(value:unknown):RemoteMcpAuthorization|null {
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const body=value as Record<string,unknown>;
  if(!validText(body.accountId) ||
      !['user','operator','admin'].includes(String(body.role)) ||
      !Array.isArray(body.allowedDeviceIds) ||
      body.allowedDeviceIds.length>1000 ||
      body.allowedDeviceIds.some(id=>!validText(id)) ||
      typeof body.autoSelectDevices!=='boolean' ||
      !Array.isArray(body.ownerDevices)||body.ownerDevices.length>1000||
      !Array.isArray(body.ownerFolders)||body.ownerFolders.length>1000) {
    return null;
  }
  const devices=[...new Set(body.allowedDeviceIds as string[])];
  const allowed=new Set(devices);
  const modes=body.deviceAccessModes;
  if(!modes||typeof modes!=='object'||Array.isArray(modes)) return null;
  const normalizedModes:Record<string,'safe'|'full'>={};
  for(const id of devices) {
    const reported=(modes as Record<string,unknown>)[id];
    if(reported!=='safe'&&reported!=='full')return null;
    normalizedModes[id]=reported;
  }
  const ownerDevices:RemoteMcpAuthorization['ownerDevices']=[];
  const seenDevice=new Set<string>();
  for(const entry of body.ownerDevices) {
    if(!entry||typeof entry!=='object'||Array.isArray(entry))return null;
    const d=entry as Record<string,unknown>;
    if(!validText(d.id)||!allowed.has(d.id)||seenDevice.has(d.id)||
        !validText(d.name)||!(d.folderId===null||validText(d.folderId)))return null;
    seenDevice.add(d.id);
    ownerDevices.push({id:d.id,name:d.name,folderId:d.folderId as string|null});
  }
  const ownerFolders:RemoteMcpAuthorization['ownerFolders']=[];
  const seenFolder=new Set<string>();
  for(const entry of body.ownerFolders) {
    if(!entry||typeof entry!=='object'||Array.isArray(entry))return null;
    const folder=entry as Record<string,unknown>;
    if(!validText(folder.id)||!validText(folder.name)||seenFolder.has(folder.id))return null;
    seenFolder.add(folder.id);
    ownerFolders.push({id:folder.id,name:folder.name});
  }
  return {
    accountId:body.accountId,
    role:body.role as RemoteMcpAuthorization['role'],
    allowedDeviceIds:devices,
    deviceAccessModes:normalizedModes,
    autoSelectDevices:body.autoSelectDevices,
    ownerDevices,ownerFolders,
  };
}

export class FusedMcpAuthorizeChargeClient {
  private readonly url:string;
  private readonly serviceToken:string;
  private readonly fetchImpl:typeof fetch;
  private readonly timeoutMs:number;

  constructor(options:ControlPlaneMcpClientOptions) {
    const base=new URL(options.controlPlaneUrl);
    const local=['localhost','127.0.0.1','[::1]','::1'].includes(base.hostname);
    if(base.username||base.password||base.search||base.hash||
       (base.protocol!=='https:'&&!(local&&base.protocol==='http:'))) {
      throw new Error('Fused MCP requires trusted HTTPS control plane');
    }
    if(!/^[^\r\n\0]{16,4096}$/.test(options.serviceToken)) {
      throw new Error('Invalid service token');
    }
    const timeout=options.timeoutMs??3000;
    if(!Number.isInteger(timeout)||timeout<250||timeout>10000){
      throw new Error('Invalid MCP timeout');
    }
    this.url=new URL('/api/v1/internal/mcp/authorize-charge',base).toString();
    this.serviceToken=options.serviceToken;
    this.fetchImpl=options.fetchImpl??fetch;
    this.timeoutMs=timeout;
  }

  /** Deliberately NO fallback/retry. An ambiguous reservation must fail closed. */
  async authorizeAndCharge(input:{
    accessToken:string;
    invocationId:string;
    toolName:string;
    specialSkill?:boolean;
  }):Promise<FusedMcpClientDecision> {
    if(typeof input.accessToken!=='string'||!input.accessToken.startsWith('nwx_mcp_')||
       input.accessToken.length<16||input.accessToken.length>512||
       !/^[A-Za-z0-9._:-]{8,128}$/.test(input.invocationId)||
       !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.toolName)||
       (input.specialSkill!==undefined&&typeof input.specialSkill!=='boolean')) {
      return {kind:'rejected',httpStatus:400,code:'MCP_INVALID_REQUEST',remainingCredits:null};
    }
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),this.timeoutMs);
    timer.unref?.();
    try {
      const result=await this.fetchImpl(this.url,{
        method:'POST',
        headers:{
          accept:'application/json',
          'content-type':'application/json',
          authorization:'Bearer '+this.serviceToken,
        },
        body:JSON.stringify(input),
        signal:controller.signal,
      });
      if(![200,400,401,403,409,429].includes(result.status)){
        return {kind:'unavailable',code:'MCP_AUTH_CHARGE_UNAVAILABLE'};
      }
      const decoded:unknown=await result.json();
      if(!decoded||typeof decoded!=='object'||Array.isArray(decoded)){
        return {kind:'unavailable',code:'MCP_AUTH_CHARGE_UNAVAILABLE'};
      }
      const body=decoded as Record<string,unknown>;
      if(result.status!==200) {
        const code=typeof body.error==='string'&&
          /^[A-Z_]{3,80}$/.test(body.error)
          ?body.error:'MCP_AUTH_CHARGE_REJECTED';
        const remainingCredits=body.remainingCredits;
        if(remainingCredits!==undefined&&remainingCredits!==null&&
           (!Number.isSafeInteger(remainingCredits)||Number(remainingCredits)<0)) {
          return {kind:'unavailable',code:'MCP_AUTH_CHARGE_UNAVAILABLE'};
        }
        return {
          kind:'rejected',httpStatus:result.status as 400|401|403|409|429,
          code,remainingCredits:remainingCredits===undefined?null:remainingCredits as number|null,
        };
      }
      const authorization=parseAuthorization(body.authorization);
      const charge=body.charge;
      if(body.authenticated!==true||!authorization||
         !charge||typeof charge!=='object'||Array.isArray(charge)) {
        return {kind:'unavailable',code:'MCP_AUTH_CHARGE_UNAVAILABLE'};
      }
      const c=charge as Record<string,unknown>;
      if(c.status!=='charged'||!Number.isSafeInteger(c.chargedCredits)||
         Number(c.chargedCredits)<0||
         !(c.remainingCredits===null||(Number.isSafeInteger(c.remainingCredits)&&Number(c.remainingCredits)>=0))) {
        return {kind:'unavailable',code:'MCP_AUTH_CHARGE_UNAVAILABLE'};
      }
      return {
        kind:'authorized',authorization,
        chargedCredits:c.chargedCredits as number,
        remainingCredits:c.remainingCredits as number|null,
      };
    } catch {
      return {kind:'unavailable',code:'MCP_AUTH_CHARGE_UNAVAILABLE'};
    } finally {
      clearTimeout(timer);
    }
  }
}
