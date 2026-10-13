import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveAiWorkspaceTarget,
  requireWslHeadlessRouting,
} from '../src/agent/ai-workspace-default.js';
import {executeCapability} from '../src/agent/executors.js';
import {PathPolicy} from '../src/agent/path-policy.js';

const enforce={NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE:'1'};

test('strict private policy keeps implicit or explicitly private targets private',()=>{
  assert.equal(resolveAiWorkspaceTarget(undefined,{
    platform:'win32',env:enforce,
  }),'private_desktop');
  assert.equal(resolveAiWorkspaceTarget('private_desktop',{
    platform:'win32',env:enforce,
  }),'private_desktop');
  assert.equal(resolveAiWorkspaceTarget(undefined,{
    platform:'win32',env:{
      ...enforce,NEXOWIRE_AI_UI_TARGET_DEFAULT:'private_desktop',
    },
  }),'private_desktop');
});

test('strict private policy rejects explicit or configured headless overrides',()=>{
  for(const [explicit,configured] of [
    ['headless',undefined],
    [undefined,'headless'],
    ['headless','private_desktop'],
  ] as const){
    assert.throws(()=>resolveAiWorkspaceTarget(explicit,{
      platform:'win32',env:{
        ...enforce,
        ...(configured?{NEXOWIRE_AI_UI_TARGET_DEFAULT:configured}:{}),
      },
    }), (error:unknown)=>error instanceof Error&&'code' in error&&
      error.code==='AI_PRIVATE_DESKTOP_POLICY_REQUIRED');
  }
});

test('invalid strict policy never silently downgrades to headless',()=>{
  for(const value of ['true','enabled','', '2']){
    assert.throws(()=>resolveAiWorkspaceTarget(undefined,{
      platform:'win32',env:{NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE:value},
    }),/AI_WORKSPACE_ENFORCEMENT_POLICY_INVALID/);
  }
  assert.equal(resolveAiWorkspaceTarget('headless',{
    platform:'win32',env:{NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE:'0'},
  }),'headless');
  assert.equal(resolveAiWorkspaceTarget(undefined,{
    platform:'win32',env:{},
  }),'headless');
});

test('strict mode never claims private desktop on Linux or unconfined WSLg',()=>{
  assert.throws(()=>resolveAiWorkspaceTarget(undefined,{
    platform:'linux',env:enforce,
  }),/AI_PRIVATE_DESKTOP_REQUIRES_WINDOWS/);
  assert.throws(()=>resolveAiWorkspaceTarget('private_desktop',{
    platform:'linux',env:enforce,
  }),/AI_PRIVATE_DESKTOP_REQUIRES_WINDOWS/);
  assert.throws(()=>requireWslHeadlessRouting('headless',{
    platform:'win32',env:enforce,
  }),(error:unknown)=>error instanceof Error&&'code' in error&&
    error.code==='AI_PRIVATE_DESKTOP_POLICY_REQUIRED');
  assert.throws(()=>requireWslHeadlessRouting(undefined,{
    platform:'win32',env:enforce,
  }),(error:unknown)=>error instanceof Error&&'code' in error&&
    error.code==='WSL_PRIVATE_GUI_NOT_ISOLATED');
});

test('strict Windows shell execution rejects an explicit headless request before spawning a command',{
  skip:process.platform!=='win32',
},async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-strict-policy-'));
  const marker=path.join(root,'would-have-run.txt');
  const old=process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE;
  const oldDefault=process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT;
  try{
    process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE='1';
    process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT='private_desktop';
    await assert.rejects(
      executeCapability('shell.exec',{
        shell:'powershell',ui_target:'headless',
        command:"[IO.File]::WriteAllText('"+marker.replace(/'/g,"''")+"','unsafe')",
      },new PathPolicy([root])),
      (error:unknown)=>error instanceof Error&&'code' in error&&
        error.code==='AI_PRIVATE_DESKTOP_POLICY_REQUIRED',
    );
    await assert.rejects(fs.stat(marker),
      (error:unknown)=>typeof error==='object'&&error!==null&&
        'code' in error&&error.code==='ENOENT');
  }finally{
    if(old===undefined)delete process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE;
    else process.env.NEXOWIRE_AI_UI_TARGET_ENFORCE_PRIVATE=old;
    if(oldDefault===undefined)delete process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT;
    else process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT=oldDefault;
    await fs.rm(root,{recursive:true,force:true});
  }
});
