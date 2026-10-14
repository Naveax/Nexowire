import test from 'node:test';
import assert from 'node:assert/strict';
import {isReadOnlyCapability} from '../src/protocol/capabilities.js';
import {MCP_TOOL_CAPABILITY_REQUIREMENTS} from '../src/mcp/tool-capabilities.js';
import {selectObservedPrivateUiaTarget} from '../src/agent/windows-private-uia-target.js';

const chosen={
  hwnd:'0xAB23',automation_id:'nxPrimaryAction',
  control_type:'ControlType.Button',expected_class:'Button',
};
const button={
  processId:500,depth:1,controlType:'ControlType.Button',
  automationId:'nxPrimaryAction',className:'Button',actionLabel:'Continue',
  enabled:true,offscreen:false,
  rect:{left:20,top:18,width:140,height:40},
};
const base={
  hwnd:'0xAB23',processId:500,inputDesktop:'Default',
  nodes:[button],skipped:0,foreignProcessNodesSkipped:0,
  truncated:false,exposesTextValues:false,physicalDesktopInspected:false,
  accessibilityCoverageComplete:false,
};

test('read-only exact UIA selection maps into MCP capabilities',()=>{
  assert.equal(isReadOnlyCapability('windows.private_desktop.accessibility.resolve'),true);
  assert.equal(
    MCP_TOOL_CAPABILITY_REQUIREMENTS.windows_private_desktop_accessibility_resolve,
    'windows.private_desktop.accessibility.resolve',
  );
});

test('unique same-PID onscreen action control resolves to geometry without authorizing input',()=>{
  const{data}=selectObservedPrivateUiaTarget(chosen,base);
  assert.equal(data.hwnd,chosen.hwnd);
  assert.equal(data.processId,500);
  assert.equal(data.target.automationId,chosen.automation_id);
  assert.deepEqual(data.target.rect,button.rect);
  assert.equal(data.uniqueInObservedSnapshot,true);
  assert.equal(data.authorizesInput,false);
  assert.equal(data.fullAccessibilityTreeVerified,false);
  assert.equal(data.physicalDesktopInspected,false);
});

test('duplicate, foreign, incomplete, unavailable and mismatched private UIA targets fail closed',()=>{
  for(const [snapshot,code] of [
    [{...base,nodes:[button,{...button}]},'PRIVATE_UIA_TARGET_AMBIGUOUS'],
    [{...base,nodes:[{...button,processId:501}]},'PRIVATE_UIA_TARGET_NOT_FOUND'],
    [{...base,truncated:true},'PRIVATE_UIA_TARGET_INVENTORY_INCOMPLETE'],
    [{...base,skipped:1},'PRIVATE_UIA_TARGET_INVENTORY_INCOMPLETE'],
    [{...base,foreignProcessNodesSkipped:1},'PRIVATE_UIA_TARGET_INVENTORY_INCOMPLETE'],
    [{...base,nodes:[{...button,enabled:false}]},'PRIVATE_UIA_TARGET_UNAVAILABLE'],
    [{...base,nodes:[{...button,offscreen:true}]},'PRIVATE_UIA_TARGET_UNAVAILABLE'],
    [{...base,nodes:[{...button,rect:null}]},'PRIVATE_UIA_TARGET_UNAVAILABLE'],
    [{...base,hwnd:'0x22'},'PRIVATE_UIA_TARGET_WINDOW_MISMATCH'],
  ] as const){
    assert.throws(()=>selectObservedPrivateUiaTarget(chosen,snapshot),
      (e:unknown)=>e instanceof Error&&'code'in e&&e.code===code,code);
  }
  assert.throws(
    ()=>selectObservedPrivateUiaTarget({...chosen,automation_id:'unknown'},base),
    (e:unknown)=>e instanceof Error&&'code'in e&&e.code==='PRIVATE_UIA_TARGET_NOT_FOUND',
  );
  assert.throws(
    ()=>selectObservedPrivateUiaTarget({...chosen,expected_class:'Edit'},base),
    (e:unknown)=>e instanceof Error&&'code'in e&&e.code==='PRIVATE_UIA_TARGET_NOT_FOUND',
  );
});
