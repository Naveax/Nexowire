import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {executeCapability} from '../src/agent/executors.js';
import {executeWindowsPrivateDesktopCapability,serializePrivateDesktopLifecycle} from '../src/agent/windows-private-desktop.js';
import {PathPolicy} from '../src/agent/path-policy.js';

test('parallel private desktop lifecycle requests are serialized even after failure',async()=>{
  const order:string[]=[];
  const first=serializePrivateDesktopLifecycle(async()=>{
    order.push('first-start');
    await new Promise(resolve=>setTimeout(resolve,25));
    order.push('first-end');
    throw new Error('expected-first-failure');
  });
  const second=serializePrivateDesktopLifecycle(async()=>{
    order.push('second-start');
    await new Promise(resolve=>setTimeout(resolve,15));
    order.push('second-end');
  });
  const third=serializePrivateDesktopLifecycle(async()=>{
    order.push('third-start');
  });
  await assert.rejects(first,/expected-first-failure/);
  await Promise.all([second,third]);
  assert.deepEqual(order,[
    'first-start','first-end','second-start','second-end','third-start',
  ]);
});

test('workspace checks run in private Win32 desktop without stealing active input',{
  skip:process.platform!=='win32'||process.env.NEXOWIRE_RUN_PRIVATE_CHECKS_LIVE!=='1',
  timeout:75_000,
},async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-private-checks-'));
  const desktop=path.join(root,'private-desktop');
  const oldRoot=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const oldSkip=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=desktop;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  t.after(async()=>{
    await executeWindowsPrivateDesktopCapability('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(oldRoot===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=oldRoot;
    if(oldSkip===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=oldSkip;
    await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:70}).catch(()=>undefined);
  });
  await fs.writeFile(path.join(root,'package.json'),JSON.stringify({
    name:'private-check-fixture',scripts:{
      test:'node -e "console.log(\'private-test-ok\')"',
      build:'node -e "console.log(\'private-build-ok\')"',
    },
  }));
  const result=await executeCapability('workspace.checks',{
    path:root,checks:['node:test','node:build'],
    ui_target:'private_desktop',parallel:true,timeout_ms:25_000,
  },new PathPolicy([root])) as {data:{ok:boolean;passed:number;results:Array<{id:string;stdout:string}>}};
  assert.equal(result.data.ok,true,JSON.stringify(result.data.results));
  assert.equal(result.data.passed,2);
  assert.match(result.data.results.find(x=>x.id==='node:test')?.stdout??'',/private-test-ok/);
  assert.match(result.data.results.find(x=>x.id==='node:build')?.stdout??'',/private-build-ok/);
  const status=await executeWindowsPrivateDesktopCapability(
    'windows.private_desktop.status',{},
  ) as {data:{inputDesktop:string;running:boolean}};
  assert.equal(status.data.running,true);
  assert.equal(status.data.inputDesktop,'Default');
});
