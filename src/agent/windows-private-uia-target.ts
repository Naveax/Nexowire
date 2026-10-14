import * as z from 'zod';
import {executeWindowsPrivateDesktopCapability} from './windows-private-desktop.js';

const Selection=z.object({
  hwnd:z.string().min(1).max(32).regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/),
  automation_id:z.string().min(1).max(128),
  control_type:z.string().min(1).max(128),
  expected_class:z.string().min(1).max(128).optional(),
}).strict();

const Rect=z.object({
  left:z.number().int(),top:z.number().int(),
  width:z.number().int().nonnegative(),
  height:z.number().int().nonnegative(),
}).nullable();

const Snapshot=z.object({
  hwnd:z.string().min(1),
  processId:z.number().int().positive(),
  inputDesktop:z.string(),
  nodes:z.array(z.object({
    processId:z.number().int().nonnegative(),
    depth:z.number().int().min(1).max(5),
    controlType:z.string(),
    automationId:z.string(),
    className:z.string(),
    actionLabel:z.string(),
    enabled:z.boolean(),offscreen:z.boolean(),rect:Rect,
  })).max(128),
  skipped:z.number().int().nonnegative(),
  foreignProcessNodesSkipped:z.number().int().nonnegative(),
  truncated:z.boolean(),
  exposesTextValues:z.literal(false),
  physicalDesktopInspected:z.literal(false),
  accessibilityCoverageComplete:z.literal(false),
});

type Input=z.infer<typeof Selection>;
type Scan=z.infer<typeof Snapshot>;

export function selectObservedPrivateUiaTarget(
  input:Input,
  rawSnapshot:unknown,
){
  const request=Selection.parse(input);
  const scan=Snapshot.parse(rawSnapshot);
  if(scan.hwnd.toLowerCase()!==request.hwnd.toLowerCase()){
    throw Object.assign(new Error('UI Automation scan HWND mismatch.'),{
      code:'PRIVATE_UIA_TARGET_WINDOW_MISMATCH',
    });
  }
  // Never treat a partial or cross-process tree as evidence of uniqueness.
  if(scan.truncated||scan.skipped>0||scan.foreignProcessNodesSkipped>0){
    throw Object.assign(new Error('Private UI Automation inventory incomplete; target cannot be validated.'),{
      code:'PRIVATE_UIA_TARGET_INVENTORY_INCOMPLETE',
    });
  }
  const matches=scan.nodes.filter(node=>node.processId===scan.processId&&
    node.automationId===request.automation_id&&
    node.controlType===request.control_type&&
    (request.expected_class===undefined||
      node.className===request.expected_class));
  if(matches.length!==1){
    throw Object.assign(new Error(matches.length===0?
      'Requested private UI Automation target was not found.':
      'Requested private UI Automation target is not unique.'),{
      code:matches.length===0?
        'PRIVATE_UIA_TARGET_NOT_FOUND':'PRIVATE_UIA_TARGET_AMBIGUOUS',
    });
  }
  const target=matches[0];
  if(!target||!target.enabled||target.offscreen||target.rect===null||
     target.rect.width<1||target.rect.height<1){
    throw Object.assign(new Error('Private UI Automation target is not actionable.'),{
      code:'PRIVATE_UIA_TARGET_UNAVAILABLE',
    });
  }
  return{data:{
    hwnd:scan.hwnd,
    processId:scan.processId,
    target:{
      automationId:target.automationId,
      controlType:target.controlType,
      className:target.className,
      depth:target.depth,
      rect:target.rect,
    },
    observationScope:'PRIVATE_WINDOW_UIA_CONTROL_VIEW',
    uniqueInObservedSnapshot:true,
    fullAccessibilityTreeVerified:false,
    authorizesInput:false,
    physicalDesktopInspected:false,
    visibleDesktopChanged:false,
    inputDesktop:scan.inputDesktop,
  }};
}

export async function resolveObservedPrivateUiaTarget(input:unknown){
  const request=Selection.parse(input);
  const scan=await executeWindowsPrivateDesktopCapability(
    'windows.private_desktop.accessibility',{hwnd:request.hwnd},
  ) as{data:unknown};
  return selectObservedPrivateUiaTarget(request,scan.data);
}
