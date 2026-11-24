import path from 'node:path';
import * as z from 'zod';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import type {BearerAuthorization} from '../security/auth.js';
import {isMcpToolAuthorized} from '../security/tool-authorization.js';
import {DurableLargeTransfer,LargeTransferError,type LargeTransferAuthority,type LargeTransferRemote,type LargeTransferScope} from './durable-large-transfer.js';

/** Owner-scoped, server-provisioned durable state and protected Native client.
 * Neither the caller nor the public MCP transport may choose these providers. */
export interface LargeTransferRuntime {
  journalPath:string;
  projectId:string;
  authority:LargeTransferAuthority;
  native:Pick<LargeTransferRemote,'limits'|'writeFenced'|'publishFenced'>;
}
const id=z.string().min(1).max(128);
const common={source_device_id:id,target_device_id:id};
const existing={...common,transfer_id:z.string().uuid()};
const deps=['file_read','file_stat','file_hash','file_write','file_move'];
type Args={source_device_id:string;target_device_id:string};
function result(value:Record<string,unknown>,error=false){
  return {content:[{type:'text' as const,text:JSON.stringify(value)}],structuredContent:value,...(error?{isError:true}:{})};
}
function validRuntime(runtime:LargeTransferRuntime){
  return !!runtime&&path.isAbsolute(runtime.journalPath)&&/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/.test(runtime.projectId)&&
    !!runtime.authority&&['assertGrant','acquire','assertCurrent','proveWriteNoEffect','verifyFinal','commitPublished','recoverPublished','recoverNativeReceipt','commitRecoveredPublication'].every(k=>typeof (runtime.authority as unknown as Record<string,unknown>)[k]==='function')&&
    !!runtime.native&&['limits','writeFenced','publishFenced'].every(k=>typeof (runtime.native as unknown as Record<string,unknown>)[k]==='function');
}
export function registerLargeTransferTools(server:McpServer,auth:BearerAuthorization|undefined,runtime:LargeTransferRuntime|undefined,remote:LargeTransferRemote,authorize:(scope:LargeTransferScope,requireOnline:boolean)=>Promise<void>){
  // Only explicitly scoped control-plane identities may use this new route.
  // A static token, empty device list or provider absence is not permission.
  if(!runtime||!validRuntime(runtime)||auth?.kind!=='control-plane'||auth.scope!=='mcp'||!auth.accountId||!deps.every(d=>isMcpToolAuthorized(auth,d)))return;
  const account=auth.accountId,project=runtime.projectId;
  const scopeFor=(a:Args):LargeTransferScope=>{
    if(a.source_device_id===a.target_device_id||![a.source_device_id,a.target_device_id].every(d=>auth.allowedDeviceIds?.includes(d)&&auth.deviceAccessModes?.[d]==='full'))throw new LargeTransferError('TRANSFER_SCOPE_DENIED');
    return {ownerId:account,projectId:project,sourceDeviceId:a.source_device_id,targetDeviceId:a.target_device_id};
  };
  const call=async(name:string,a:Args,fn:(w:DurableLargeTransfer,s:LargeTransferScope)=>Promise<unknown>)=>{
    let worker:DurableLargeTransfer|undefined;
    try{
      if(!isMcpToolAuthorized(auth,name))throw new LargeTransferError('TRANSFER_SCOPE_DENIED');
      const scope=scopeFor(a);
      await authorize(scope,name!=='large_file_transfer_status'&&name!=='large_file_transfer_cancel');
      // Open/close per RPC; the durable journal, not an MCP session, owns jobs.
      worker=new DurableLargeTransfer(runtime.journalPath,remote,runtime.authority);
      return result({ok:true,data:await fn(worker,scope)});
    }catch(e){
      return result({ok:false,error:{code:e instanceof LargeTransferError?e.code:'LARGE_TRANSFER_UNAVAILABLE',message:'Transfer could not be verified. Inspect or explicitly reconcile the existing job before retrying.'}},true);
    }finally{worker?.close();}
  };
  server.registerTool('large_file_transfer_start',{title:'Start durable cross-device transfer',description:'Create a scoped job. No binary payload returned; advance explicitly. Requires enrolled protected Native transfer providers.',inputSchema:{...common,source_path:z.string().min(1).max(4096),target_path:z.string().min(1).max(4000)}},a=>call('large_file_transfer_start',a,(w,s)=>w.create(s,a.source_path,a.target_path)));
  server.registerTool('large_file_transfer_advance',{title:'Advance durable transfer',description:'Process a bounded batch; never replay an unresolved write or publication. Time budget checked between steps.',inputSchema:{...existing,max_chunks:z.number().int().min(1).max(256).default(128)}},a=>call('large_file_transfer_advance',a,async(w,s)=>{
    let v=await w.inspect(a.transfer_id,s);
    const deadline=performance.now()+15_000;
    for(let i=0;i<a.max_chunks&&performance.now()<deadline&&(v.state==='READY'||v.state==='VERIFIED');i++)v=await w.step(a.transfer_id,s);
    return v;
  }));
  server.registerTool('large_file_transfer_status',{title:'Inspect durable transfer',description:'Read scoped durable progress, not a caller-provided success flag.',inputSchema:existing},a=>call('large_file_transfer_status',a,(w,s)=>w.inspect(a.transfer_id,s)));
  server.registerTool('large_file_transfer_recover',{title:'Reconcile durable transfer',description:'Verify original staging or publication evidence. No blind replay or second publish.',inputSchema:existing},a=>call('large_file_transfer_recover',a,(w,s)=>w.recover(a.transfer_id,s)));
  server.registerTool('large_file_transfer_cancel',{title:'Cancel durable transfer',description:'Preserve uncertain mutation evidence; do not delete staging or existing destination.',inputSchema:existing},a=>call('large_file_transfer_cancel',a,(w,s)=>w.cancel(a.transfer_id,s)));
}
