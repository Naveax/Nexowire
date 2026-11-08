import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {executeCapability} from '../src/agent/executors.js';
import {PathDeniedError,PathPolicy} from '../src/agent/path-policy.js';

/**
 * W26 #780: one new RED, existing-API acceptance regression.
 * This tests the REAL workspace.snapshot code, not a fictional P1 task
 * sandbox. Git paths/linked worktree/hook disablement are all disposable
 * test-created TEMP; no installed Agent, ACL, VM, user repository or hook runs.
 */
test('workspace.snapshot must not read Git worktree root outside its approved task root', {
  timeout: 45_000,
}, async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-w26-wt-boundary-'));
  t.after(async()=>fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100}));

  const seed=path.join(temp,'seed-repository');
  const linked=path.join(temp,'linked-worktree');
  const allowed=path.join(linked,'task-scoped-directory');
  const disabledHooks=path.join(temp,'empty-hooks');
  await fs.mkdir(disabledHooks);
  const gitEnv={
    ...process.env,
    GIT_CONFIG_NOSYSTEM:'1',
    GIT_CONFIG_GLOBAL:path.join(temp,'no-global-git-config'),
    GIT_TERMINAL_PROMPT:'0',
  };
  const git=(args:string[])=>{
    const run=spawnSync('git',[
      '-c','core.hooksPath='+disabledHooks,...args,
    ],{encoding:'utf8',windowsHide:true,timeout:15_000,
      maxBuffer:64*1024,env:gitEnv});
    assert.equal(run.error,undefined,'local disposable Git must launch');
    assert.equal(run.status,0,
      'disposable Git worktree setup failed: '+(run.stderr??'').slice(0,1000));
    return (run.stdout??'').trim();
  };
  git(['init','--quiet',seed]);
  git(['-C',seed,'-c','user.name=W26 TEMP QA',
    '-c','user.email=w26-temp@example.invalid',
    'commit','--allow-empty','--quiet','-m','disposable seed']);
  git(['-C',seed,'worktree','add','--detach','--quiet',linked]);

  await fs.mkdir(allowed);
  await fs.writeFile(path.join(linked,'package.json'),
    '{"name":"outside-allowed-root-synthetic-marker"}\n','utf8');
  const dotGit=await fs.readFile(path.join(linked,'.git'),'utf8');
  assert.match(dotGit,/^gitdir:\s*/i,
    'exercise real linked worktree metadata, not a synthetic Git root');
  const gitRoot=git(['-C',allowed,'rev-parse','--show-toplevel']);
  assert.equal(path.resolve(gitRoot).toLowerCase(),path.resolve(linked).toLowerCase());
  assert.notEqual(path.resolve(gitRoot).toLowerCase(),path.resolve(allowed).toLowerCase());

  const policy=new PathPolicy([allowed]);
  assert.equal(await policy.resolveExisting(allowed),await fs.realpath(allowed),
    'the REQUESTED directory itself is legitimately within the allowed root');

  // CURRENT MAIN BUG: workspace.snapshot checks the requested cwd, but then
  // trusts git rev-parse --show-toplevel and fs.readdir(gitRoot) without
  // authorizing that discovered root. The call currently SUCCEEDS and leaks
  // a project marker outside this PathPolicy. Keep this assertion RED until
  // the workspace owner re-authorizes Git-discovered root AND actual worktree
  // Git metadata path against task-scoped roots before any read/tool run.
  await assert.rejects(
    ()=>executeCapability('workspace.snapshot',{path:allowed},policy),
    (error:unknown)=>error instanceof PathDeniedError ||
      (error instanceof Error &&
        /WORKSPACE_ROOT_(?:OUTSIDE|NOT_AUTHORIZED)|WORKTREE_(?:OUTSIDE|NOT_AUTHORIZED)/.test(
          error.message)),
    'Git-discovered root outside the approved task scope must fail closed',
  );
});
