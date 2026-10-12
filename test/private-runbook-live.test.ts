import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {executeCapability} from '../src/agent/executors.js';
import {RunbookStore} from '../src/agent/runbook-store.js';
import {TaskGraphStore} from '../src/agent/task-graph-store.js';
import {PathPolicy} from '../src/agent/path-policy.js';
import {executeWindowsPrivateDesktopCapability} from '../src/agent/windows-private-desktop.js';

test('owner-configured AI private desktop default applies to full live runbooks and nested graphs',{
  skip:process.platform!=='win32'||process.env.NEXOWIRE_RUN_PRIVATE_RUNBOOK_LIVE!=='1',
  timeout:90_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-runbook-live-'));
  const beforeDir=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const beforeShortcut=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  const beforePolicy=process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT;
  process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT='private_desktop';
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=path.join(root,'desktop');
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await executeWindowsPrivateDesktopCapability('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(beforeDir===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=beforeDir;
    if(beforeShortcut===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=beforeShortcut;
    if(beforePolicy===undefined)delete process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT;
    else process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT=beforePolicy;
    await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100}).catch(()=>undefined);
  });
  const runbooks=new RunbookStore({stateFile:path.join(root,'rb-state.json')});
  const taskGraphs=new TaskGraphStore({stateFile:path.join(root,'graph-state.json')});
  await Promise.all([runbooks.initialize(),taskGraphs.initialize()]);
  const result=await executeCapability('runbook.run',{
    runbook_id:'private-e2e',
    // Deliberately omit ui_target: owner-configured private default must apply.
    steps:[
      {id:'build',kind:'task_graph',task_graph:{
        ui_target:'headless',
        jobs:[{id:'first',shell:'powershell',
          command:"[Console]::Write('runbook-private-one')"}],
      }},
      {id:'verify',depends_on:['build'],kind:'task_graph',task_graph:{
        jobs:[{id:'second',shell:'powershell',
          command:"[Console]::Write('runbook-private-two')"}],
      }},
    ],
  },new PathPolicy(['*']),{runbooks,taskGraphs}) as {
    data:{ok:boolean;uiTarget:string;desktopName?:string;summary:{succeeded:number}};
  };
  assert.equal(result.data.ok,true);
  assert.equal(result.data.summary.succeeded,2);
  assert.equal(result.data.uiTarget,'private_desktop');
  assert.equal(result.data.desktopName,'NexowirePrivate');
  const status=await executeWindowsPrivateDesktopCapability(
    'windows.private_desktop.status',{},
  ) as {data:{running:boolean;inputDesktop:string}};
  assert.equal(status.data.running,true);
  assert.equal(status.data.inputDesktop,'Default');
});
