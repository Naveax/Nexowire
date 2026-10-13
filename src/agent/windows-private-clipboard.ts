import * as z from 'zod';
import {executeWindowsPrivateDesktopCapability} from './windows-private-desktop.js';

const MAX_PRIVATE_TEXT_CHARS=20_000;
const PrivateTextSchema=z.object({
  text:z.string().min(1).max(MAX_PRIVATE_TEXT_CHARS),
}).strict();
const PrivatePasteSchema=z.object({
  hwnd:z.string().min(1).max(32)
    .regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/),
  interval_ms:z.number().int().min(0).max(100).default(0),
}).strict();
const PrivateReadSchema=z.object({
  max_chars:z.number().int().min(1).max(MAX_PRIVATE_TEXT_CHARS)
    .default(MAX_PRIVATE_TEXT_CHARS),
}).strict();

export class PrivateClipboardError extends Error{
  constructor(public readonly code:string,message:string){
    super(message);this.name='PrivateClipboardError';
  }
}
interface ClipboardState{
  privateDesktopStartedAt:string;
  text:string;
  updatedAt:string;
}
// This is NOT the shared Windows window-station clipboard. Kept in Agent
// memory only: never fs, system clipboard, user profile, OS clipboard API.
let memory:ClipboardState|null=null;

async function activePrivateDesktop():Promise<string>{
  const response=await executeWindowsPrivateDesktopCapability(
    'windows.private_desktop.status',{},
  ) as {data:{running:boolean;startedAt?:string}};
  if(!response.data.running||!response.data.startedAt){
    memory=null;
    throw new PrivateClipboardError('PRIVATE_DESKTOP_NOT_RUNNING',
      'Start NexowirePrivate before using the private memory clipboard.');
  }
  const key=response.data.startedAt;
  if(memory&&memory.privateDesktopStartedAt!==key)memory=null;
  return key;
}

export async function executeWindowsPrivateClipboardCapability(
  capability:string,input:unknown,
):Promise<unknown>{
  if(capability==='windows.private_clipboard.clear'){
    z.object({}).strict().parse(input);
    const removed=memory!==null;
    memory=null;
    // Always permit explicit wipe, including after private desktop stopped.
    return {data:{cleared:true,hadText:removed,physicalClipboardTouched:false}};
  }
  const startedAt=await activePrivateDesktop();
  if(capability==='windows.private_clipboard.status'){
    z.object({}).strict().parse(input);
    return {data:{
      hasText:memory!==null,
      length:memory?.text.length??0,
      updatedAt:memory?.updatedAt??null,
      physicalClipboardTouched:false,
      privateDesktopStartedAt:startedAt,
    }};
  }
  if(capability==='windows.private_clipboard.write'){
    const requested=PrivateTextSchema.parse(input);
    memory={privateDesktopStartedAt:startedAt,text:requested.text,
      updatedAt:new Date().toISOString()};
    return {data:{
      stored:true,length:requested.text.length,
      physicalClipboardTouched:false,persistedToDisk:false,
    }};
  }
  if(capability==='windows.private_clipboard.read'){
    const requested=PrivateReadSchema.parse(input);
    const text=memory?.text??'';
    if(text.length>requested.max_chars){
      throw new PrivateClipboardError('PRIVATE_CLIPBOARD_LIMIT_EXCEEDED',
        'Stored private text exceeds max_chars; no truncated text returned.');
    }
    return {data:{
      hasText:memory!==null,text,length:text.length,
      physicalClipboardTouched:false,
    }};
  }
  if(capability==='windows.private_clipboard.paste'){
    const requested=PrivatePasteSchema.parse(input);
    if(!memory?.text){
      throw new PrivateClipboardError('PRIVATE_CLIPBOARD_EMPTY',
        'The private clipboard contains no text.');
    }
    const source=memory.text;
    // The same native helper as windows.private_keyboard.type verifies the
    // destination HWND is currently owned by NexowirePrivate, not Default.
    const result=await executeWindowsPrivateDesktopCapability(
      'windows.private_keyboard.type',{
        hwnd:requested.hwnd,text:source,
        interval_ms:requested.interval_ms,
      },
    ) as {data:{charsSent:number;inputDesktop:string}};
    const after=await activePrivateDesktop();
    if(after!==startedAt){
      throw new PrivateClipboardError('PRIVATE_DESKTOP_RESTARTED',
        'Private desktop restarted during a paste request.');
    }
    return {data:{
      sent:true,charsSent:result.data.charsSent,
      physicalClipboardTouched:false,
      inputDesktop:result.data.inputDesktop,
    }};
  }
  throw new PrivateClipboardError('PRIVATE_CLIPBOARD_UNSUPPORTED',
    'Unsupported private memory clipboard capability.');
}
