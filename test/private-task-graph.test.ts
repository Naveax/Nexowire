import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {executeCapability} from '../src/agent/executors.js';
import {executeWindowsPrivateDesktopCapability} from '../src/agent/windows-private-desktop.js';
import {PathPolicy} from '../src/agent/path-policy.js';

test('private task graph refuses unsupported OS without headless fallback',{
  skip:process.platform==='win32',
},async()=>{
  const result=await executeCapability('task.graph.run',{
    ui_target:'private_desktop',
    jobs:[{id:'private',command:'echo deny'}],
  },new PathPolicy(['*'])) as {data:{ok:boolean;results:Array<{status:string;error?:string}>}};
  assert.equal(result.data.ok,false);
  assert.equal(result.data.results[0]?.status,'failed');
  assert.match(result.data.results[0]?.error??'',/PRIVATE_SHELL_WINDOWS_ONLY/);
});

test('isolated Windows private task graph keeps active desktop unchanged',{
  skip:process.platform!=='win32'||process.env.NEXOWIRE_RUN_PRIVATE_GRAPH_LIVE!=='1',
  timeout:80_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-private-graph-'));
  const oldDir=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const oldSkip=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=root;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await executeWindowsPrivateDesktopCapability('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(oldDir===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=oldDir;
    if(oldSkip===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=oldSkip;
    await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:80}).catch(()=>undefined);
  });

  const result=await executeCapability('task.graph.run',{
    ui_target:'private_desktop',
    max_parallel:1,
    default_timeout_ms:15_000,
    total_timeout_ms:50_000,
    jobs:[
      {id:'first',shell:'powershell',command:"[Console]::Write('first-private')"},
      {id:'second',shell:'powershell',depends_on:['first'],command:"[Console]::Write('second-private')"},
    ],
  },new PathPolicy(['*'])) as {data:{
    ok:boolean;uiTarget:string;desktopName:string;
    results:Array<{id:string;stdout?:string;status:string}>,
  }};
  assert.equal(result.data.ok,true,JSON.stringify(result.data.results));
  assert.equal(result.data.uiTarget,'private_desktop');
  assert.equal(result.data.desktopName,'NexowirePrivate');
  assert.equal(result.data.results[0]?.stdout,'first-private');
  assert.equal(result.data.results[1]?.stdout,'second-private');
  const screen=await executeWindowsPrivateDesktopCapability('windows.private_desktop.status',{}) as {
    data:{running:boolean;inputDesktop:string},
  };
  assert.equal(screen.data.running,true);
  assert.equal(screen.data.inputDesktop,'Default');
});
