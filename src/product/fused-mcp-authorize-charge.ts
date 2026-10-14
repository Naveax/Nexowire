import type { ControlPlaneStore } from './control-plane-store.js';
import type { ControlPlaneService } from './control-plane-service.js';
import { isMcpToolAuthorized } from '../security/tool-authorization.js';
import { hostedMcpUsageEventId } from '../mcp/hosted-metering.js';

/**
 * Candidate S1 single-Worker-request auth+quota boundary.
 * Nothing registers this handler in production unless explicitly mounted.
 * Caller SERVICE authentication, OAuth access-token verification, current
 * owner/role/device permissions and atomic D1 quota reservation are mandatory.
 */
export interface FusedMcpChargeDependencies {
  authenticateService(request: Request): Promise<boolean>;
  authenticateAccessToken(accessToken: string): Promise<{
    accountId: string;
    scopes: string[];
  } | null>;
  store: Pick<ControlPlaneStore, 'getAccount' | 'listDevices' |
    'listDeviceFolders' | 'listDeviceFolderAssignments' |
    'getAutoDeviceSelection'>;
  chargeUsage: Pick<ControlPlaneService,'chargeUsage'>['chargeUsage'];
}

function response(status:number, body:unknown):Response {
  return Response.json(body,{status,headers:{'cache-control':'no-store'}});
}
function validId(input:unknown):input is string {
  return typeof input==='string' &&
    /^[A-Za-z0-9._:-]{8,128}$/.test(input);
}
function validTool(input:unknown):input is string {
  return typeof input==='string' &&
    /^[A-Za-z0-9_.:-]{1,128}$/.test(input);
}

export function createFusedMcpAuthorizeChargeHandler(
  dependencies:FusedMcpChargeDependencies,
): (request: Request)=>Promise<Response> {
  return async (request:Request):Promise<Response> => {
    if(request.method!=='POST') return response(405,{error:'METHOD_NOT_ALLOWED'});
    let trusted=false;
    try { trusted=await dependencies.authenticateService(request); }
    catch { /* Identity-provider failure must never become a free request. */ }
    if(!trusted) return response(403,{error:'SERVICE_REQUIRED'});

    const type=request.headers.get('content-type')?.toLowerCase()??'';
    if(!type.includes('application/json')) return response(400,{error:'JSON_REQUIRED'});
    let input:unknown;
    try { input=await request.json(); }
    catch { return response(400,{error:'INVALID_REQUEST'}); }
    if(typeof input!=='object'||input===null||Array.isArray(input)) {
      return response(400,{error:'INVALID_REQUEST'});
    }
    const body=input as Record<string,unknown>;
    if(typeof body.accessToken!=='string' ||
       !body.accessToken.startsWith('nwx_mcp_') ||
       body.accessToken.length>512 || body.accessToken.length<16 ||
       !validId(body.invocationId) || !validTool(body.toolName) ||
       (body.specialSkill!==undefined && typeof body.specialSkill!=='boolean')) {
      return response(400,{error:'INVALID_REQUEST'});
    }

    try {
      // Always verify the current OAuth resource/scope/revocation. Never
      // cache a role, device list or account supplied by the Hub/client.
      const token=await dependencies.authenticateAccessToken(body.accessToken);
      if(!token || !token.scopes.includes('mcp')) {
        return response(401,{authenticated:false});
      }
      const account=await dependencies.store.getAccount(token.accountId);
      if(!account) return response(401,{authenticated:false});
      const role=account.admin?'admin':'user';
      if(!isMcpToolAuthorized({
        kind:'control-plane',scope:'mcp',accountId:account.id,role,
      },body.toolName)) {
        return response(403,{error:'MCP_TOOL_NOT_AUTHORIZED'});
      }

      // All ownership metadata must be retrieved before a reservation. The
      // caller cannot inject a different quota subject, account or scope.
      const [devices,folders,assignments,autoSelectDevices]=await Promise.all([
        dependencies.store.listDevices(account.id),
        dependencies.store.listDeviceFolders(account.id),
        dependencies.store.listDeviceFolderAssignments(account.id),
        dependencies.store.getAutoDeviceSelection(account.id),
      ]);
      const folderByDevice=new Map(assignments.map(x=>[x.deviceId,x.folderId]));
      const decision=await dependencies.chargeUsage({
        accountId:account.id,
        eventId:hostedMcpUsageEventId({
          accountId:account.id,invocationId:body.invocationId,
        }),
        toolName:body.toolName,
        ...(body.specialSkill===true?{specialSkill:true}:{}),
      });
      if(decision.status==='duplicate') {
        return response(409,{error:'MCP_DUPLICATE_REQUEST',
          remainingCredits:decision.remainingCredits});
      }
      if(decision.status==='denied') {
        const feature=decision.reason==='feature-not-in-plan';
        return response(feature?403:429,{
          error:feature?'MCP_FEATURE_NOT_IN_PLAN':'MCP_QUOTA_EXHAUSTED',
          remainingCredits:decision.remainingCredits,
        });
      }

      return response(200,{
        authenticated:true,
        authorization:{
          accountId:account.id,role,
          allowedDeviceIds:devices.map(x=>x.id),
          deviceAccessModes:Object.fromEntries(devices.map(x=>[x.id,x.accessMode])),
          autoSelectDevices,
          ownerDevices:devices.map(x=>({
            id:x.id,name:x.name,folderId:folderByDevice.get(x.id)??null,
          })),
          ownerFolders:folders.map(x=>({id:x.id,name:x.name})),
        },
        charge:{
          status:'charged',chargedCredits:decision.chargedCredits,
          remainingCredits:decision.remainingCredits,reason:null,
        },
      });
    } catch {
      // Do not leak private SQL, token, user, owner or provider failure info.
      // An unknown reservation state is NOT safe to retry with a new ID.
      return response(503,{error:'MCP_AUTH_CHARGE_UNAVAILABLE'});
    }
  };
}
