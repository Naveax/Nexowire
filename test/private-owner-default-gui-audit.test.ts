import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MCP_TOOL_CAPABILITY_REQUIREMENTS} from '../src/mcp/tool-capabilities.js';
import {isReadOnlyCapability} from '../src/protocol/capabilities.js';
import {executeWindowsPrivateDesktopCapability as desktop} from '../src/agent/windows-private-desktop.js';
import {
  assessPrivateDefaultGuiOwnership,inspectPrivateDefaultGuiOwnership,
} from '../src/agent/windows-private-owner-desktop-gui-audit.js';

const roots={
  running:true,
  inputDesktop:'Default',
  trackedRootPids:[100,200],
  observedDescendantPids:[300],
  reportedDescendantsTruncated:false,
  processInventoryTruncated:false,
  rootsMissingFromSnapshot:[],
  ancestryComplete:false,
  physicalDesktopLeakageExcluded:false,
};
const empty={
  desktop:'Default',
  candidateWindows:[],
  enumeratedTopLevelWindows:26,
  enumerationTruncated:false,
};

test('owner desktop GUI PID audit is mapped as read-only MCP capability',()=>{
  assert.equal(isReadOnlyCapability('windows.private_desktop.owner_gui_audit'),true);
  assert.equal(
    MCP_TOOL_CAPABILITY_REQUIREMENTS.windows_private_desktop_owner_gui_audit,
    'windows.private_desktop.owner_gui_audit',
  );
});

test('observed private descendants owning Default HWNDs generate a positive warning',()=>{
  const {data}=assessPrivateDefaultGuiOwnership(roots,{
    ...empty,
    candidateWindows:[{pid:300,count:2},{pid:100,count:1}],
  },[100,200,300]);
  assert.deepEqual(data.observedDefaultWindowOwnerPids,[100,300]);
  assert.equal(data.observedDefaultWindowCount,3);
  assert.equal(data.observedCandidateGuiOnDefault,true);
  assert.equal(data.queriedDesktop,'Default');
  assert.equal(data.ownerWindowStationVerified,false);
  assert.equal(data.physicalDesktopLeakageExcluded,false);
  assert.equal(data.noDefaultGuiProven,false);
  assert.equal(data.inspectedWindowTitles,false);
  assert.equal(data.mutatedPhysicalInput,false);
});

test('zero observed HWNDs cannot be reported as proof of complete GUI confinement',()=>{
  const {data}=assessPrivateDefaultGuiOwnership({
    ...roots,reportedDescendantsTruncated:true,
    rootsMissingFromSnapshot:[200],
  },{...empty,enumerationTruncated:true},[100,200,300]);
  assert.equal(data.observedCandidateGuiOnDefault,false);
  assert.equal(data.ancestryDescendantsTruncated,true);
  assert.equal(data.ancestryRootsMissing,1);
  assert.equal(data.enumerationTruncated,true);
  assert.equal(data.noDefaultGuiProven,false);
  assert.equal(data.allIntermediateEventsObserved,false);
  assert.equal(data.crossSessionCoverageVerified,false);
});

test('scan can never report any unrequested owner PID',()=>{
  assert.throws(()=>assessPrivateDefaultGuiOwnership(
    roots,{...empty,candidateWindows:[{pid:999,count:1}]},[100,200,300],
  ),/unrelated PID/);
  assert.throws(()=>assessPrivateDefaultGuiOwnership(
    roots,empty,[100,100],
  ),/Duplicate audited process IDs/);
});

test('real DEV scans only process-PID ownership, without changing active desktop',{
  skip:process.platform!=='win32',timeout:130_000,
},async(t)=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'nx-owner-gui-pid-audit-'));
  const oldRoot=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const oldShortcut=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=dir;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await desktop('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(oldRoot===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=oldRoot;
    if(oldShortcut===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=oldShortcut;
    await fs.rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:125});
  });
  const start=await desktop('windows.private_desktop.start',{
    create_shortcut:false,
  })as{data:{running:boolean;inputDesktop:string}};
  assert.equal(start.data.running,true);
  assert.equal(start.data.inputDesktop,'Default');
  const {data}=await inspectPrivateDefaultGuiOwnership();
  assert.equal(data.scope,'CALLER_WINDOW_STATION_DEFAULT_TOP_LEVEL_WINDOWS');
  assert.equal(data.queriedDesktop,'Default');
  assert.equal(data.inputDesktop,'Default');
  assert.equal(data.inspectedWindowTitles,false);
  assert.equal(data.inspectedWindowContents,false);
  assert.equal(data.mutatedPhysicalInput,false);
  assert.equal(data.physicalDesktopLeakageExcluded,false);
  assert.equal(data.noDefaultGuiProven,false);
  assert.ok(data.candidateProcessCount>0);
  const after=await desktop('windows.private_desktop.status',{})as{
    data:{running:boolean;inputDesktop:string}};
  assert.equal(after.data.running,true);
  assert.equal(after.data.inputDesktop,'Default');
});
