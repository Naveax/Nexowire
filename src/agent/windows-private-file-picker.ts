/**
 * Private-desktop-only file picker adapter. Never calls the legacy
 * windows.accessibility.invoke/set_value (physical console surface).
 * The private UIA helpers perform a second HWND/desktop/PID/session check
 * immediately before InvokePattern or ValuePattern.
 *
 * Operation grants bind two explicit controls to one tracked window. They
 * are NOT owner approval; Nexowire's authenticated tool authorization must
 * still be enforced at the MCP/Agent boundary.
 */
import {createHash, randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import * as z from 'zod';
import type {PathPolicy} from './path-policy.js';
import {executeWindowsPrivateDesktopCapability} from './windows-private-desktop.js';

const Hwnd=z.string().min(1).max(32).regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/);
const Control=z.object({
  automation_id:z.string().min(1).max(128),
  expected_class:z.string().min(1).max(128),
}).strict();
const Prepare=z.object({
  hwnd:Hwnd,
  expected_process_id:z.number().int().positive(),
  expected_session_id:z.number().int().nonnegative(),
  expected_desktop_started_at:z.string().datetime(),
  filename_edit:Control,
  confirm_button:Control,
}).strict();
const Select=z.object({
  grant_id:z.string().uuid(),
  path:z.string().min(1).max(1024),
}).strict();
const Cancel=z.object({grant_id:z.string().uuid()}).strict();
type PrepareInput=z.infer<typeof Prepare>;
type ControlInput=z.infer<typeof Control>;
type Dispatch=(capability:string,input:unknown)=>Promise<unknown>;

class FilePickerError extends Error {
  constructor(public readonly code:string,message:string){
    super(message);this.name='PrivateFilePickerError';
  }
}
function reject(code:string,message:string):never{throw new FilePickerError(code,message)}
function hwndIdentity(v:string):string{
  try{return BigInt(v).toString(16).toUpperCase()}catch{
    return reject('PICKER_HWND_INVALID','Invalid HWND identity.');
  }
}
interface Status {
  running:boolean; desktopName:string; inputDesktop:string;
  startedAt?:string; launchedPids?:number[];
}
interface Window {hwnd:string;processId:number;title:string}
interface Scan {
  hwnd:string; processId:number;sessionId:number; inputDesktop:string;
  truncated:boolean; skipped:number; foreignProcessNodesSkipped:number;
  nodes:Array<{
    processId:number;controlType:string;automationId:string;className:string;
    enabled:boolean;offscreen:boolean;rect: {
      left:number;top:number;width:number;height:number;
    }|null;
  }>;
}
interface Permit {
  input:PrepareInput; expiresAt:number; used:boolean; cancelled:boolean;
}
function data<T>(raw:unknown):T {
  if(typeof raw!=='object'||raw===null||!('data'in raw))
    return reject('PICKER_RESPONSE_INVALID','Private desktop returned no structured data.');
  return (raw as{data:T}).data;
}
function requirePath(value:string):void{
  // Root-relative, UNC, device namespace, ADS and shortcut files can
  // bypass the intended local file selection scope. Refuse before UIA.
  if(!/^[A-Za-z]:\\/.test(value) ||
    value.startsWith('\\\\?\\') || value.startsWith('\\\\.\\') ||
    /[\u0000-\u001F]/.test(value) || value.substring(2).includes(':') ||
    /(?:^|\\)[^\\]*[. ](?:\\|$)/.test(value) ||
    /\.(?:lnk|url|website|search-ms)$/i.test(value)){
    reject('PICKER_PATH_UNSAFE','Use an absolute local Windows file path; UNC/device paths are not supported.');
  }
}
function matchControl(scan:Scan,wanted:ControlInput,type:string):void{
  const matches=scan.nodes.filter(n=>n.processId===scan.processId &&
    n.automationId===wanted.automation_id && n.className===wanted.expected_class &&
    n.controlType===type);
  if(matches.length!==1)
    reject('PICKER_CONTROL_NOT_UNIQUE','Required file-picker control is missing or ambiguous.');
  const node=matches[0]!;
  if(!node.enabled||node.offscreen||!node.rect||
    node.rect.width<1||node.rect.height<1)
    reject('PICKER_CONTROL_UNAVAILABLE','Required file-picker control is hidden, disabled or inaccessible.');
}

export function createPrivateFilePickerAdapter(
  dispatch:Dispatch=executeWindowsPrivateDesktopCapability,
  now:()=>number=Date.now,
  newId:()=>string=randomUUID,
){
  const permits=new Map<string,Permit>();
  const prune=()=>{
    for(const [id,p] of permits){
      if(now()>=p.expiresAt && !p.used)permits.delete(id);
    }
  };
  const preflight=async(input:PrepareInput)=>{
    const status=data<Status>(await dispatch('windows.private_desktop.status',{}));
    if(!status.running||status.desktopName!=='NexowirePrivate'||
      status.inputDesktop!=='Default')
      reject('PICKER_DESKTOP_UNSAFE','Private desktop unavailable, switched, or Windows secure desktop active.');
    if(status.startedAt!==input.expected_desktop_started_at)
      reject('PICKER_DESKTOP_RESTARTED','Private desktop session has changed.');
    if(!status.launchedPids?.includes(input.expected_process_id))
      reject('PICKER_PROCESS_UNTRACKED','File picker process is not a tracked private-desktop launch.');
    const listing=data<{inputDesktop:string;windows:Window[]}>(await dispatch('windows.private_desktop.windows',{}));
    if(listing.inputDesktop!=='Default')
      reject('PICKER_INPUT_DESKTOP_CHANGED','Input desktop changed during file-picker inspection.');
    const windows=listing.windows.filter(w=>hwndIdentity(w.hwnd)===hwndIdentity(input.hwnd));
    if(windows.length!==1||windows[0]!.processId!==input.expected_process_id)
      reject('PICKER_WINDOW_CHANGED','File picker HWND was removed, reused, or changed owner.');
    const scan=data<Scan>(await dispatch('windows.private_desktop.accessibility',{hwnd:input.hwnd}));
    if(hwndIdentity(scan.hwnd)!==hwndIdentity(input.hwnd)||
      scan.processId!==input.expected_process_id||
      scan.sessionId!==input.expected_session_id||
      scan.inputDesktop!=='Default')
      reject('PICKER_IDENTITY_CHANGED','Picker process, Windows session, HWND, or input desktop changed.');
    if(scan.truncated||scan.skipped!==0||scan.foreignProcessNodesSkipped!==0)
      reject('PICKER_INVENTORY_INCOMPLETE','Picker UI Automation inventory is incomplete.');
    matchControl(scan,input.filename_edit,'ControlType.Edit');
    matchControl(scan,input.confirm_button,'ControlType.Button');
    return {processId:scan.processId,sessionId:scan.sessionId};
  };
  return {
    async prepare(raw:unknown){
      const input=Prepare.parse(raw);
      prune();
      if(permits.size>=128)
        reject('PICKER_GRANT_CAPACITY','Too many pending file-picker operations.');
      await preflight(input);
      // Only one live operation grant per HWND. No replay from an older dialog.
      for(const [id,p] of permits)
        if(hwndIdentity(p.input.hwnd)===hwndIdentity(input.hwnd)){
          p.cancelled=true;permits.delete(id);
        }
      const grantId=newId(),expiresAt=now()+60_000;
      permits.set(grantId,{input,expiresAt,used:false,cancelled:false});
      return {data:{
        grantId,expiresAt:new Date(expiresAt).toISOString(),
        hwnd:input.hwnd,processId:input.expected_process_id,
        sessionId:input.expected_session_id,
        desktopName:'NexowirePrivate',
        authorizesPhysicalConsole:false,ownerApprovalGranted:false,
      }};
    },
    async select(raw:unknown,verifyExistingPath?:(requested:string)=>Promise<string>){
      const request=Select.parse(raw);
      requirePath(request.path);
      // The native UIA Edit can otherwise open files outside files.read's
      // allowedRoots, silently bypassing the agent filesystem policy.
      const safePath=verifyExistingPath?await verifyExistingPath(request.path):request.path;
      requirePath(safePath);
      const permit=permits.get(request.grant_id);
      if(!permit||permit.used||permit.cancelled||now()>=permit.expiresAt)
        reject('PICKER_GRANT_INVALID','File-picker operation grant is invalid, expired, revoked or used.');
      permit.used=true;
      const input=permit.input;
      let editStarted=false,editApplied=false,invokeStarted=false;
      const check=()=>{
        if(permit.cancelled||now()>=permit.expiresAt)
          reject('PICKER_CANCELLED','File-picker operation cancelled or expired.');
      };
      try{
        check();await preflight(input);check();
        const common={
          hwnd:input.hwnd,
          expected_process_id:input.expected_process_id,
          expected_session_id:input.expected_session_id,
        };
        editStarted=true;
        const edit=data<{processId:number;sessionId?:number;inputDesktop:string;actionCompleted:boolean}>(
          await dispatch('windows.private_desktop.accessibility.set_edit_value',{
            ...common,...input.filename_edit,value:safePath,
          }));
        editApplied=true;
        if(!edit.actionCompleted||edit.processId!==input.expected_process_id||
          edit.sessionId!==input.expected_session_id||edit.inputDesktop!=='Default')
          reject('PICKER_EDIT_RESULT_UNVERIFIED','File-picker text update result failed identity verification.');
        check();await preflight(input);check();
        // The action helper independently revalidates HWND, owner PID, session,
        // unique on-screen button and input desktop immediately before Invoke.
        invokeStarted=true;
        const invoke=data<{processId:number;sessionId?:number;inputDesktop:string;actionCompleted:boolean}>(
          await dispatch('windows.private_desktop.accessibility.invoke_button',{
            ...common,...input.confirm_button,
          }));
        if(!invoke.actionCompleted||invoke.processId!==input.expected_process_id||
          invoke.sessionId!==input.expected_session_id||invoke.inputDesktop!=='Default')
          reject('PICKER_SUBMISSION_UNVERIFIED','File-picker submission could not be verified.');
        return {data:{
          submitted:true,selectionVerified:false,
          hwnd:input.hwnd,processId:input.expected_process_id,
          sessionId:input.expected_session_id,
          grantId:request.grant_id,
          pathSha256:createHash('sha256').update(safePath,'utf8').digest('hex'),
          desktopName:'NexowirePrivate',
          visibleDesktopChanged:false,touchesPhysicalInput:false,
          note:'InvokePattern returned; the owning application must independently confirm file acceptance.',
        }};
      }catch(error){
        if(invokeStarted){
          const failure=new FilePickerError('PICKER_MUTATION_STATE_UNKNOWN',
            'File-picker button submission began; final application state is unknown. Do not replay.');
          failure.cause=error;throw failure;
        }
        if(editApplied){
          const failure=new FilePickerError('PICKER_PARTIAL_EDIT',
            'File path entry may have changed; button was not submitted. Reinspect the dialog.');
          failure.cause=error;throw failure;
        }
        if(editStarted){
          const failure=new FilePickerError('PICKER_EDIT_STATE_UNKNOWN',
            'File picker edit action started but its completion is unknown. Do not blindly replay.');
          failure.cause=error;throw failure;
        }
        throw error;
      }finally{permits.delete(request.grant_id);}
    },
    async cancel(raw:unknown){
      const request=Cancel.parse(raw);
      const permit=permits.get(request.grant_id);
      if(permit){permit.cancelled=true;if(!permit.used)permits.delete(request.grant_id);}
      return {data:{revoked:!!permit,grantId:request.grant_id}};
    },
  };
}
const singleton=createPrivateFilePickerAdapter();
export async function executeWindowsPrivateFilePickerCapability(capability:string,input:unknown,policy:PathPolicy){
  switch(capability){
    case 'windows.private_desktop.file_picker.prepare':return singleton.prepare(input);
    case 'windows.private_desktop.file_picker.select':return singleton.select(input,async value=>{
      const resolved=await policy.resolveExisting(value);
      if(!(await fs.stat(resolved)).isFile())
        reject('PICKER_TARGET_NOT_FILE','Open picker accepts existing regular files only.');
      return resolved;
    });
    case 'windows.private_desktop.file_picker.cancel':return singleton.cancel(input);
    default:reject('PICKER_UNSUPPORTED','Unknown private file picker capability.');
  }
}
