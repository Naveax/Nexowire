import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {resolveAiWorkspaceTarget} from '../src/agent/ai-workspace-default.js';
import {executeCapability} from '../src/agent/executors.js';
import {executeWindowsPrivateDesktopCapability} from '../src/agent/windows-private-desktop.js';
import {PathPolicy} from '../src/agent/path-policy.js';

test('AI workspace policy preserves headless legacy behavior until owner opts in',()=>{
  assert.equal(resolveAiWorkspaceTarget(undefined,{
    platform:'win32',env:{},
  }),'headless');
  assert.equal(resolveAiWorkspaceTarget(undefined,{
    platform:'win32',env:{NEXOWIRE_AI_UI_TARGET_DEFAULT:'private_desktop'},
  }),'private_desktop');
  assert.equal(resolveAiWorkspaceTarget('headless',{
    platform:'win32',env:{NEXOWIRE_AI_UI_TARGET_DEFAULT:'private_desktop'},
  }),'headless');
  assert.equal(resolveAiWorkspaceTarget('private_desktop',{
    platform:'linux',env:{},
  }),'private_desktop');
  assert.throws(()=>resolveAiWorkspaceTarget(undefined,{
    platform:'linux',env:{NEXOWIRE_AI_UI_TARGET_DEFAULT:'private_desktop'},
  }),/AI_PRIVATE_DESKTOP_REQUIRES_WINDOWS/);
  assert.throws(()=>resolveAiWorkspaceTarget(undefined,{
    platform:'win32',env:{NEXOWIRE_AI_UI_TARGET_DEFAULT:'unsafe_default'},
  }),/AI_WORKSPACE_DEFAULT_POLICY_INVALID/);
});

test('configured Windows default shell executes in AI private desktop without switching owner input',{
  skip:process.platform!=='win32'||process.env.NEXOWIRE_RUN_AI_DEFAULT_LIVE!=='1',
  timeout:65_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-ai-default-live-'));
  const oldEnv={
    NEXOWIRE_PRIVATE_DESKTOP_DIR:process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR,
    NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT:process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT,
    NEXOWIRE_AI_UI_TARGET_DEFAULT:process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT,
  };
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=path.join(root,'desktop');
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT='private_desktop';
  t.after(async()=>{
    await executeWindowsPrivateDesktopCapability('windows.private_desktop.stop',{}).catch(()=>undefined);
    for(const [key,value] of Object.entries(oldEnv)){
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
    await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100}).catch(()=>undefined);
  });
  const result=await executeCapability('shell.exec',{
    shell:'powershell',command:"[Console]::Write('policy-private-ok')",
    timeout_ms:15_000,
    // Deliberately no ui_target: configured owner default must apply.
  },new PathPolicy(['*'])) as {stdout:string;exitCode:number|null};
  assert.equal(result.exitCode,0);
  assert.equal(result.stdout,'policy-private-ok');
  const status=await executeWindowsPrivateDesktopCapability(
    'windows.private_desktop.status',{},
  ) as {data:{running:boolean;inputDesktop:string}};
  assert.equal(status.data.running,true);
  assert.equal(status.data.inputDesktop,'Default');
});
