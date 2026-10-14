import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MCP_TOOL_CAPABILITY_REQUIREMENTS} from '../src/mcp/tool-capabilities.js';
import {isReadOnlyCapability} from '../src/protocol/capabilities.js';
import {executeWindowsPrivateDesktopCapability as desktop} from '../src/agent/windows-private-desktop.js';
import {
  assessWindowsPrivateProcessAncestry,
  inspectWindowsPrivateProcessAncestry,
} from '../src/agent/windows-private-process-ancestry-audit.js';

const state={
  running:true,hostPid:9,shellPid:10,launchedPids:[20],
  startedAt:'2026-10-14T06:00:00.000Z',inputDesktop:'Default',
};
const iso='2026-10-14T06:00:01.000Z';
const records=[
  {pid:10,parentPid:9,sessionId:1,createdAt:iso},
  {pid:20,parentPid:9,sessionId:1,createdAt:iso},
  {pid:30,parentPid:20,sessionId:1,createdAt:iso},
  {pid:31,parentPid:30,sessionId:1,createdAt:iso},
  {pid:32,parentPid:20,sessionId:2,createdAt:iso},
  {pid:42,parentPid:1,sessionId:1,createdAt:iso},
];

test('private process ancestry audit is read-only on MCP',()=>{
  assert.equal(isReadOnlyCapability('windows.private_desktop.process_audit'),true);
  assert.equal(MCP_TOOL_CAPABILITY_REQUIREMENTS.windows_private_desktop_process_audit,
    'windows.private_desktop.process_audit');
});

test('ancestry is bounded, follows observed children and never claims OS isolation',()=>{
  const{data}=assessWindowsPrivateProcessAncestry(state,{
    processes:records,inventoryTruncated:false,
  });
  assert.deepEqual(data.trackedRootPids,[10,20]);
  assert.deepEqual(data.observedDescendantPids,[30,31,32]);
  assert.deepEqual(data.crossSessionDescendantPids,[32]);
  assert.equal(data.observedDescendantCount,3);
  assert.equal(data.reportedDescendantsTruncated,false);
  assert.equal(data.ancestryComplete,false);
  assert.equal(data.independentSessionVerified,false);
  assert.equal(data.physicalDesktopLeakageExcluded,false);
  assert.equal(data.noUntrackedChildrenProven,false);
  assert.equal(JSON.stringify(data).includes('42'),false);
});

test('missing/reused roots and invalid snapshots do not create false certainty',()=>{
  const reused={pid:20,parentPid:9,sessionId:1,
    createdAt:'2026-10-12T06:00:00.000Z'};
  const result=assessWindowsPrivateProcessAncestry(state,{
    processes:[records[0],reused,...records.slice(2)],
    inventoryTruncated:true,
  }).data;
  assert.ok(result.suspiciousPidReusePids.includes(20));
  assert.equal(result.observedDescendantCount,0);
  assert.equal(result.processInventoryTruncated,true);
  const missing=assessWindowsPrivateProcessAncestry(state,{
    processes:records.filter(r=>r.pid!==20),inventoryTruncated:false,
  }).data;
  assert.deepEqual(missing.rootsMissingFromSnapshot,[20]);
  assert.equal(missing.ancestryComplete,false);
  assert.throws(()=>assessWindowsPrivateProcessAncestry({
    ...state,running:false,
  },{processes:records,inventoryTruncated:false}),
  (e:unknown)=>e instanceof Error&&'code'in e&&
    e.code==='PRIVATE_PROCESS_AUDIT_NOT_RUNNING');
});

test('DEV Win32_Process live snapshot sees child of managed native private process',{
  skip:process.platform!=='win32',timeout:125_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-process-ancestry-'));
  const oldRoot=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const oldShortcut=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=root;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await desktop('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(oldRoot===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=oldRoot;
    if(oldShortcut===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=oldShortcut;
    await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:150});
  });
  const fixture=path.join(root,'spawn-child.cjs');
  const marker=path.join(root,'spawned-child-pid.txt');
  await fs.writeFile(fixture,[
    "const {spawn}=require('node:child_process');",
    "const {writeFileSync}=require('node:fs');",
    "writeFileSync(process.argv[2],String(process.pid)+':boot');",
    "const child=spawn(process.execPath,['-e','setTimeout(()=>{},24000)'],{windowsHide:true,stdio:'ignore'});",
    "child.on('error',e=>writeFileSync(process.argv[2],String(process.pid)+':error:'+e.message));",
    "if(child.pid)writeFileSync(process.argv[2],String(child.pid));",
    "setTimeout(()=>{},22000);",
  ].join('\n'),'utf8');
  const started=await desktop('windows.private_desktop.start',{
    create_shortcut:false,
  }) as{data:{running:boolean;inputDesktop:string}};
  assert.equal(started.data.running,true);
  assert.equal(started.data.inputDesktop,'Default');
  const launched=await desktop('windows.private_desktop.launch',{
    executable:process.execPath,
    args:[fixture,marker],cwd:root,
  }) as{data:{pid:number}};
  let childPid=0;
  for(let i=0;i<35;i++){
    const raw=await fs.readFile(marker,'utf8').catch(()=>'');
    childPid=Number(raw.trim())||0;
    if(childPid>0)break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(childPid>0,'Managed native process should spawn a live child; marker='+await fs.readFile(marker,'utf8').catch(()=>'<missing>'));
  const report=(await inspectWindowsPrivateProcessAncestry()).data;
  assert.ok(report.trackedRootPids.includes(launched.data.pid));
  assert.ok(report.observedDescendantPids.includes(childPid));
  assert.equal(report.inputDesktop,'Default');
  assert.equal(report.ancestryComplete,false);
  assert.equal(report.physicalDesktopLeakageExcluded,false);
  assert.equal(report.independentSessionVerified,false);
  const after=await desktop('windows.private_desktop.status',{}) as{
    data:{inputDesktop:string;running:boolean};
  };
  assert.equal(after.data.inputDesktop,'Default');
  assert.equal(after.data.running,true);
});
