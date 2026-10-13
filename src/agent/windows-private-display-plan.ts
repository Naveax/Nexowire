import * as z from 'zod';

// This deliberately plans only. A WinSta0 desktop object does not supply
// independent OS monitors, and host display reconfiguration is forbidden.
const Pixels = z.number().int().min(320).max(7680);
const Rows = z.number().int().min(240).max(4320);
const Dpi = z.number().int().min(72).max(480);
const Hz = z.number().int().min(24).max(240);

export const PrivateDisplayPlanSchema = z.object({
  screen_count: z.number().int().min(1).max(8),
  width: Pixels.default(1920),
  height: Rows.default(1080),
  dpi: Dpi.default(96),
  refresh_hz: Hz.default(60),
  layout: z.enum(['horizontal','vertical']).default('horizontal'),
  primary_index: z.number().int().min(0).max(7).default(0),
  per_monitor: z.array(z.object({
    index: z.number().int().min(0).max(7),
    width: Pixels.optional(),
    height: Rows.optional(),
    dpi: Dpi.optional(),
    refresh_hz: Hz.optional(),
  }).strict()).max(8).default([]),
}).strict().superRefine((value,ctx)=>{
  if(value.primary_index>=value.screen_count){
    ctx.addIssue({code:'custom',path:['primary_index'],
      message:'primary_index must refer to one of the requested screens.'});
  }
  const used = new Set<number>();
  for(let i=0;i<value.per_monitor.length;i++){
    const entry=value.per_monitor[i]!;
    if(entry.index>=value.screen_count){
      ctx.addIssue({code:'custom',path:['per_monitor',i,'index'],
        message:'Override references a screen outside screen_count.'});
    }
    if(used.has(entry.index)){
      ctx.addIssue({code:'custom',path:['per_monitor',i,'index'],
        message:'Each screen may only be overridden once.'});
    }
    used.add(entry.index);
  }
});

export interface ProposedPrivateMonitor {
  id: string;
  index: number;
  primary: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  dpi: number;
  scalePercent: number;
  refreshHz: number;
}

export interface PrivateDisplayPlan {
  kind: 'isolated_virtual_display_plan';
  requestedScreenCount: number;
  primaryIndex: number;
  layout: 'horizontal' | 'vertical';
  monitors: ProposedPrivateMonitor[];
  unionBounds: {x:number;y:number;width:number;height:number};
  totalPixels: number;
  estimatedRgbaBytes: number;
  screenshotPolicy: {
    defaultSource: 'all_monitors';
    specificSource: 'monitor_index_or_id';
    includesEveryScreenUnlessSelected: true;
  };
  applied: false;
  osMonitorsProvisioned: false;
  touchesHostDisplaySettings: false;
  blocker: {
    code: 'ISOLATED_VIRTUAL_DISPLAY_BACKEND_REQUIRED';
    message: string;
  };
}

/**
 * Validates exact requested count, resolution, refresh and DPI per screen.
 * Returns geometry and deterministic IDs. Does not write settings, attach
 * virtual hardware, change DPI, or claim an OS-visible monitor is active.
 */
export function planWindowsPrivateDisplays(input:unknown):{data:PrivateDisplayPlan}{
  const config=PrivateDisplayPlanSchema.parse(input);
  const overrideMap = new Map(config.per_monitor.map(v=>[v.index,v]));
  const monitors:ProposedPrivateMonitor[]=[];
  let x=0, y=0;
  let pixels=0;
  for(let index=0;index<config.screen_count;index++){
    const override=overrideMap.get(index);
    const width=override?.width??config.width;
    const height=override?.height??config.height;
    const dpi=override?.dpi??config.dpi;
    const refreshHz=override?.refresh_hz??config.refresh_hz;
    monitors.push({
      id:`AI-${index+1}`,index,primary:index===config.primary_index,
      x,y,width,height,dpi,scalePercent:Math.round(dpi/96*100),
      refreshHz,
    });
    pixels+=width*height;
    if(config.layout==='horizontal')x+=width;else y+=height;
  }
  const unionWidth=Math.max(...monitors.map(m=>m.x+m.width));
  const unionHeight=Math.max(...monitors.map(m=>m.y+m.height));
  // Preserve predictable memory and screen-coordinate bounds for future
  // providers: reject huge composites before spawning any display backend.
  if(pixels>120_000_000 || unionWidth*unionHeight>120_000_000 ||
      unionWidth>32767 || unionHeight>32767){
    throw Object.assign(
      new Error('Requested isolated AI display layout exceeds 120 MP or 32767px bounds.'),
      {code:'PRIVATE_DISPLAY_PLAN_TOO_LARGE'},
    );
  }
  return {data:{
    kind:'isolated_virtual_display_plan',
    requestedScreenCount:config.screen_count,
    primaryIndex:config.primary_index,
    layout:config.layout,
    monitors,
    unionBounds:{x:0,y:0,width:unionWidth,height:unionHeight},
    totalPixels:pixels,
    estimatedRgbaBytes:unionWidth*unionHeight*4,
    screenshotPolicy:{
      defaultSource:'all_monitors',
      specificSource:'monitor_index_or_id',
      includesEveryScreenUnlessSelected:true,
    },
    applied:false,
    osMonitorsProvisioned:false,
    touchesHostDisplaySettings:false,
    blocker:{
      code:'ISOLATED_VIRTUAL_DISPLAY_BACKEND_REQUIRED',
      message:'Win32 desktop objects share the host monitor layout. Provisioning these independent AI screens requires a separately isolated virtual display backend; host display settings must not be modified.',
    },
  }};
}
