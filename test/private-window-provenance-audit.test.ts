import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MCP_TOOL_CAPABILITY_REQUIREMENTS} from '../src/mcp/tool-capabilities.js';
import {isReadOnlyCapability} from '../src/protocol/capabilities.js';
import {
  assessWindowsPrivateWindowProvenance,
  inspectWindowsPrivateWindowProvenance,
} from '../src/agent/windows-private-window-provenance-audit.js';
import {executeWindowsPrivateDesktopCapability as desktop} from '../src/agent/windows-private-desktop.js';

test('provenance inspection is exposed as a read-only MCP capability',()=>{
  assert.equal(isReadOnlyCapability('windows.private_desktop.window_audit'),true);
  assert.equal(
    MCP_TOOL_CAPABILITY_REQUIREMENTS.windows_private_desktop_window_audit,
    'windows.private_desktop.window_audit',
  );
});

test('untracked Windows private-desktop PIDs are surfaced, not accepted as managed',()=>{
  const {data}=assessWindowsPrivateWindowProvenance({
    running:true,shellPid:20,launchedPids:[50,60],
    windowCount:5,inputDesktop:'Default',
  },{
    inputDesktop:'Default',windows:[
      {hwnd:'0x1',processId:50},
      {hwnd:'0x2',processId:60},
      {hwnd:'0x3',processId:20},
      {hwnd:'0x4',processId:99},
      {hwnd:'0x5',processId:98},
    ],
  });
  assert.equal(data.observedPrivateWindowCount,5);
  assert.equal(data.managedAppWindowCount,2);
  assert.equal(data.privateShellWindowCount,1);
  assert.equal(data.untrackedWindowCount,2);
  assert.deepEqual(data.untrackedProcessIds,[98,99]);
  assert.equal(data.windowInventoryConsistent,true);
  assert.equal(data.observedWindowOwnersAllKnown,false);
  assert.equal(data.physicalDesktopLeakageExcluded,false);
  assert.equal(data.fullDescendantIsolationVerified,false);
  assert.equal(data.hostClipboardIsolated,false);
  assert.equal(data.requiresGuestSessionAcceptance,true);
});

test('even all observed windows tracked never means physical desktop leakage excluded',()=>{
  const {data}=assessWindowsPrivateWindowProvenance({
    running:true,shellPid:9,launchedPids:[11],
    windowCount:2,inputDesktop:'Default',
  },{inputDesktop:'Default',windows:[
    {hwnd:'0x1',processId:9},{hwnd:'0x2',processId:11},
  ]});
  assert.equal(data.observedWindowOwnersAllKnown,true);
  assert.equal(data.fullDescendantIsolationVerified,false);
  assert.equal(data.physicalDesktopLeakageExcluded,false);
  assert.equal(data.observationScope,'NEXOWIREPRIVATE_TOP_LEVEL_WINDOWS_ONLY');
});

test('raced snapshots and missing private desktop fail closed',()=>{
  const state={running:true,shellPid:9,launchedPids:[11],
    inputDesktop:'Default',windowCount:2};
  const items={inputDesktop:'Default',windows:[{hwnd:'0x1',processId:11}]};
  assert.equal(
    assessWindowsPrivateWindowProvenance(state,items)
      .data.observedWindowOwnersAllKnown,false,
  );
  assert.equal(
    assessWindowsPrivateWindowProvenance({...state,inputDesktop:'NexowirePrivate'},
      {...items,windows:[{hwnd:'0x1',processId:9},{hwnd:'0x2',processId:11}]})
      .data.windowInventoryConsistent,false,
  );
  assert.throws(()=>assessWindowsPrivateWindowProvenance(
    {running:false,inputDesktop:'Default'},{inputDesktop:'Default',windows:[]}),
    (e:unknown)=>e instanceof Error&&'code' in e&&
      e.code==='PRIVATE_WINDOW_AUDIT_NOT_RUNNING');
});

test('actual DEV private WPF window is attributed to its managed PID without switching Default',{
  skip:process.platform!=='win32',timeout:85_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-window-audit-'));
  const beforeRoot=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const beforeShortcut=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=root;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await desktop('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(beforeRoot===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=beforeRoot;
    if(beforeShortcut===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=beforeShortcut;
    await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:150});
  });
  const script=path.join(root,'audit-form.ps1');
  await fs.writeFile(script,[
    'Add-Type -AssemblyName PresentationFramework',
    '$w=New-Object Windows.Window',
    "$w.Title='Nx Provenance Private WPF Fixture'",
    '$w.Width=600',
    '$w.Height=300',
    '$w.ShowInTaskbar=$false',
    '[void]$w.ShowDialog()',
  ].join('\n'),'utf8');
  const started=await desktop('windows.private_desktop.start',{
    create_shortcut:false,
  }) as {data:{running:boolean;inputDesktop:string}};
  assert.equal(started.data.inputDesktop,'Default');
  const launched=await desktop('windows.private_desktop.launch',{
    executable:'powershell.exe',
    args:['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-STA','-File',script],
  }) as {data:{pid:number}};
  let seen=false;
  for(let i=0;i<45;i++){
    const inventory=await desktop('windows.private_desktop.windows',{}) as {
      data:{windows:Array<{processId:number;title:string}>;inputDesktop:string};
    };
    assert.equal(inventory.data.inputDesktop,'Default');
    if(inventory.data.windows.some(w=>w.processId===launched.data.pid &&
      w.title==='Nx Provenance Private WPF Fixture')){
      seen=true;break;
    }
    await new Promise(resolve=>setTimeout(resolve,120));
  }
  assert.equal(seen,true,'Managed fixture must be visible in private window inventory');
  const audit=(await inspectWindowsPrivateWindowProvenance()).data;
  assert.equal(audit.running,true);
  assert.equal(audit.inputDesktop,'Default');
  assert.ok(audit.managedAppWindowCount>=1);
  assert.equal(audit.physicalDesktopLeakageExcluded,false);
  assert.equal(audit.fullDescendantIsolationVerified,false);
  const after=await desktop('windows.private_desktop.status',{}) as {
    data:{inputDesktop:string;launchedPids:number[]};
  };
  assert.equal(after.data.inputDesktop,'Default');
  assert.ok(after.data.launchedPids.includes(launched.data.pid));
});
