import * as z from 'zod';
import {
  captureWindowsPrivateScreen,
  inspectWindowsPrivateDisplayTopology,
  type WindowsPrivateScreenCapture,
  type WindowsPrivateDisplayTopology,
} from './windows-private-screen.js';

export const PrivateScreenSetRequestSchema=z.object({
  max_width:z.number().int().min(160).max(7680).default(2560),
  max_height:z.number().int().min(120).max(4320).default(1440),
  max_bytes:z.number().int().min(65_536).max(8_388_608).default(4_194_304),
  max_total_bytes:z.number().int().min(65_536).max(33_554_432).default(16_777_216),
}).strict().superRefine((input,ctx)=>{
  if(input.max_bytes>input.max_total_bytes){
    ctx.addIssue({code:'custom',path:['max_total_bytes'],
      message:'The total image budget must cover at least one complete frame.'});
  }
});

export class PrivateScreenSetError extends Error{
  constructor(public readonly code:string,message:string){
    super(message);this.name='PrivateScreenSetError';
  }
}

function checkInvariant(ok:boolean,code:string,message:string):void{
  if(!ok)throw new PrivateScreenSetError(code,message);
}

type Monitor=WindowsPrivateDisplayTopology['monitors'][number];

function matchesMonitor(a:Monitor,b:Monitor):boolean{
  return a.index===b.index && a.id.toUpperCase()===b.id.toUpperCase() &&
    a.x===b.x && a.y===b.y &&
    a.width===b.width && a.height===b.height &&
    a.primary===b.primary &&
    a.effectiveDpiX===b.effectiveDpiX && a.effectiveDpiY===b.effectiveDpiY;
}

/** Fail atomically if any requested screen disappears or any PNG is missing.
 * All screenshots come from the per-monitor private PrintWindow path.
 */
export function validatePrivateScreenSet(
  topology:WindowsPrivateDisplayTopology,
  captures:WindowsPrivateScreenCapture[],
  maxTotalBytes:number,
):number{
  checkInvariant(topology.monitorCount>=1&&topology.monitorCount<=8,
    'PRIVATE_SCREEN_SET_COUNT_UNSUPPORTED',
    'A per-monitor batch supports one to eight connected host monitors.');
  checkInvariant(topology.monitors.length===topology.monitorCount,
    'PRIVATE_SCREEN_SET_TOPOLOGY_INVALID',
    'The connected monitor inventory is inconsistent.');
  checkInvariant(captures.length===topology.monitorCount,
    'PRIVATE_SCREEN_SET_INCOMPLETE',
    'A screen frame is missing; no partial collection will be returned.');

  let totalBytes=0;
  const names=new Set<string>();
  for(let i=0;i<captures.length;i++){
    const monitor=topology.monitors[i]!;
    const capture=captures[i]!;
    checkInvariant(!names.has(monitor.id.toUpperCase()),
      'PRIVATE_SCREEN_SET_TOPOLOGY_INVALID','Duplicate monitor ID.');
    names.add(monitor.id.toUpperCase());
    checkInvariant(capture.source==='monitor' &&
      capture.topologyKind==='host_shared_native' &&
      capture.selectedMonitorIndex===monitor.index &&
      capture.monitorCount===topology.monitorCount &&
      capture.monitors.length===topology.monitors.length &&
      capture.monitors.every((m,j)=>matchesMonitor(m,topology.monitors[j]!)),
      'PRIVATE_SCREEN_SET_TOPOLOGY_CHANGED',
      'Monitor topology changed while capturing; no partial result returned.');
    const bounds=capture.captureBounds;
    checkInvariant(!!bounds && bounds.x===monitor.x&&bounds.y===monitor.y&&
      bounds.width===monitor.width&&bounds.height===monitor.height&&
      capture.sourceWidth===monitor.width&&capture.sourceHeight===monitor.height,
      'PRIVATE_SCREEN_SET_TOPOLOGY_CHANGED',
      'Screen capture geometry differs from selected monitor.');
    checkInvariant(!capture.visibleDesktopChanged &&
      capture.inputDesktopBefore===topology.inputDesktopBefore &&
      capture.inputDesktopAfter===topology.inputDesktopBefore &&
      topology.inputDesktopAfter===topology.inputDesktopBefore,
      'PRIVATE_SCREEN_SET_INPUT_DESKTOP_CHANGED',
      'Windows input desktop changed during per-monitor capture.');
    checkInvariant(capture.mimeType==='image/png' &&
      capture.bytes>0 && capture.base64.length>0,
      'PRIVATE_SCREEN_SET_INVALID_FRAME','A monitor has no complete PNG.');
    totalBytes+=capture.bytes;
    checkInvariant(totalBytes<=maxTotalBytes,
      'PRIVATE_SCREEN_SET_TOTAL_BYTES_EXCEEDED',
      'Combined monitor screenshots exceed max_total_bytes; lower image limits.');
  }
  return totalBytes;
}

export async function captureWindowsPrivateScreenSet(input:unknown):Promise<{
  data:{
    source:'all_monitors_separate';
    topologyKind:'host_shared_native';
    independentAiDisplays:false;
    monitorCount:number;
    capturedMonitorCount:number;
    complete:true;
    maxTotalBytes:number;
    totalBytes:number;
    monitors:WindowsPrivateDisplayTopology['monitors'];
    inputDesktopBefore:string;
    inputDesktopAfter:string;
    visibleDesktopChanged:false;
    captures:WindowsPrivateScreenCapture[];
  };
}>{
  const request=PrivateScreenSetRequestSchema.parse(input);
  const topology=(await inspectWindowsPrivateDisplayTopology()).data;
  checkInvariant(topology.monitorCount>=1&&topology.monitorCount<=8,
    'PRIVATE_SCREEN_SET_COUNT_UNSUPPORTED',
    'A per-monitor capture supports 1..8 connected host screens.');
  const captures:WindowsPrivateScreenCapture[]=[];
  for(const monitor of topology.monitors){
    // Capture by device ID, not mutable enumeration order. No partial
    // frames are delivered if a hotplug, render error or byte cap occurs.
    const frame=(await captureWindowsPrivateScreen({
      source:'monitor',monitor_id:monitor.id,
      max_width:request.max_width,max_height:request.max_height,
      max_bytes:request.max_bytes,
    })).data;
    captures.push(frame);
    checkInvariant(captures.reduce((sum,item)=>sum+item.bytes,0)
      <=request.max_total_bytes,
      'PRIVATE_SCREEN_SET_TOTAL_BYTES_EXCEEDED',
      'Combined monitor screenshots exceed max_total_bytes; lower image limits.');
  }
  const totalBytes=validatePrivateScreenSet(
    topology,captures,request.max_total_bytes,
  );
  const ending=(await inspectWindowsPrivateDisplayTopology()).data;
  checkInvariant(ending.monitorCount===topology.monitorCount&&
    ending.monitors.every((m,i)=>matchesMonitor(m,topology.monitors[i]!))&&
    ending.inputDesktopBefore===topology.inputDesktopBefore &&
    ending.inputDesktopAfter===topology.inputDesktopBefore,
    'PRIVATE_SCREEN_SET_TOPOLOGY_CHANGED',
    'Monitor topology or input desktop changed before batch completion.');
  return {data:{
    source:'all_monitors_separate',topologyKind:'host_shared_native',
    independentAiDisplays:false,monitorCount:topology.monitorCount,
    capturedMonitorCount:captures.length,complete:true,
    maxTotalBytes:request.max_total_bytes,totalBytes,
    monitors:topology.monitors,
    inputDesktopBefore:topology.inputDesktopBefore,
    inputDesktopAfter:ending.inputDesktopAfter,
    visibleDesktopChanged:false,captures,
  }};
}
