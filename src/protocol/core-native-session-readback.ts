import * as z from 'zod';

const nonce=z.string().regex(/^[0-9a-f]{64}$/);
const luid=z.string().regex(/^[0-9a-f]{16}$/);
const sid=z.string().min(7).max(184).regex(/^S-1-[0-9]+(?:-[0-9]+)+$/);
const dword=z.number().int().min(0).max(0xffffffff);
const common={version:z.literal(1),kind:z.literal('windows_core_session_readback_v1'),
  nonce,humanApproval:z.literal(false),coreAuthority:z.literal(false)};
const observed=z.strictObject({...common,state:z.literal('OBSERVED'),
  observedAtMs:z.number().int().positive().safe(),durationMs:z.number().int().min(0).max(2000),
  processId:dword.min(1),processCreationFileTime:luid,tokenId:luid,tokenModifiedId:luid,
  windowsUserSid:sid,windowsSessionId:dword,windowsLogonLuid:luid,integrityRid:dword,
  elevated:z.boolean(),activeConsoleSessionId:dword.max(0xfffffffe),
  localProtocol:z.boolean(),sessionActive:z.boolean(),windowStationInteractive:z.boolean(),
  threadDesktopDefault:z.boolean(),inputDesktopDefault:z.boolean()});
const unavailable=z.strictObject({...common,state:z.literal('UNAVAILABLE'),
  reason:z.enum(['PROCESS_TOKEN_UNAVAILABLE','TOKEN_INFORMATION_UNAVAILABLE',
    'CONSOLE_UNAVAILABLE','SESSION_INFORMATION_UNAVAILABLE','INPUT_DESKTOP_UNAVAILABLE',
    'SESSION_CHANGED_DURING_READBACK','READBACK_CLOCK_INVALID','READBACK_TOO_SLOW']),
  win32Error:dword});
const wire=z.discriminatedUnion('state',[observed,unavailable]);
const expected=z.strictObject({nonce,windowsUserSid:sid,windowsSessionId:dword,
  windowsLogonLuid:luid,processId:dword.min(1),processCreationFileTime:luid});
export type CoreNativeSessionObservation=z.infer<typeof observed>;
export type CoreNativeSessionExpectation=z.infer<typeof expected>;

/** Parse bounded output only. Neither valid JSON nor a matching nonce
 * authenticates the binary, its publisher, a protected service or its caller.
 * A future protected authority must independently hold and verify that process
 * and its installed trust chain before consuming this observation.
 */
export function parseCoreNativeSessionReadback(stdout:unknown,expectedNonce:string,nowMs:number){
  if(typeof stdout!=='string'||Buffer.byteLength(stdout,'utf8')>8192||
     !nonce.safeParse(expectedNonce).success||!Number.isSafeInteger(nowMs)||nowMs<=0)
    throw new Error('CORE_SESSION_READBACK_INVALID');
  let json:unknown;
  try{json=JSON.parse(stdout)}catch{throw new Error('CORE_SESSION_READBACK_INVALID');}
  const parsed=wire.safeParse(json);
  if(!parsed.success||parsed.data.nonce!==expectedNonce)
    throw new Error('CORE_SESSION_READBACK_INVALID');
  const value=parsed.data;
  if(value.state==='OBSERVED'&&
     (value.observedAtMs>nowMs||nowMs-value.observedAtMs>2000))
    throw new Error('CORE_SESSION_READBACK_STALE');
  return value;
}

/** A comparison of UNATTESTED fields, not native consent or CORE authority.
 * All results keep authorization and physical acceptance explicitly absent.
 * Expectations must come from a separate protected ledger/process handle,
 * never be learned from this same stdout or caller-controlled tool payload.
 */
export function compareCoreNativeSessionReadback(stdout:unknown,
  binding:CoreNativeSessionExpectation,nowMs:number){
  const result=(scopeMatches:boolean,reason:string)=>({scopeMatches,reason,
    originAuthenticated:false as const,humanApprovalVerified:false as const,
    canAuthorizeCore:false as const,physicalAcceptance:'NOT_PROVEN' as const});
  const wanted=expected.safeParse(binding);
  if(!wanted.success)return result(false,'EXPECTED_SCOPE_INVALID');
  let value:ReturnType<typeof parseCoreNativeSessionReadback>;
  try{value=parseCoreNativeSessionReadback(stdout,wanted.data.nonce,nowMs)}
  catch{return result(false,'READBACK_INVALID_OR_STALE');}
  if(value.state==='UNAVAILABLE')return result(false,value.reason);
  for(const key of ['processId','processCreationFileTime','windowsUserSid',
    'windowsSessionId','windowsLogonLuid'] as const)
    if(value[key]!==wanted.data[key])return result(false,'OWNER_PROCESS_SESSION_MISMATCH');
  if(value.activeConsoleSessionId!==value.windowsSessionId||!value.localProtocol||
     !value.sessionActive||!value.windowStationInteractive||
     !value.threadDesktopDefault||!value.inputDesktopDefault)
    return result(false,'LOCAL_DEFAULT_CONSOLE_NOT_OBSERVED');
  return result(true,'UNATTESTED_SCOPE_MATCH_ONLY');
}
