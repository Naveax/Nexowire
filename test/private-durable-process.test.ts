import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {ProcessManager} from '../src/agent/process-manager.js';
import {PathPolicy} from '../src/agent/path-policy.js';
import {executeWindowsPrivateDesktopCapability} from '../src/agent/windows-private-desktop.js';

test('private process target fails closed on unsupported OS', {
  skip:process.platform==='win32',
},async()=>{
  const manager=new ProcessManager({
    workerRoot:'/tmp/nexowire-private-process-deny',
    workerEntrypoint:'src/cli.ts',
  });
  await assert.rejects(
    manager.start({command:'echo hello',ui_target:'private_desktop'},new PathPolicy(['*'])),
    /PRIVATE_PROCESS_WINDOWS_ONLY/,
  );
});

test('durable process uses independent Win32 desktop with persistent stdin and no foreground switch',{
  skip:process.platform!=='win32'||process.env.NEXOWIRE_RUN_PRIVATE_PROCESS_LIVE!=='1',
  timeout:120_000,
},async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-private-durable-'));
  const oldRoot=process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
  const oldShortcut=process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
  process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=path.join(root,'private-gui');
  process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT='1';
  const options={
    stateFile:path.join(root,'sessions.json'),
    workerRoot:path.join(root,'workers'),
    workerEntrypoint:path.resolve('src/cli.ts'),
    workerExecArgv:process.execArgv,
  };
  const manager=new ProcessManager(options);
  let restored:ProcessManager|undefined;
  let sessionId:string|undefined;
  try{
    await manager.initialize();
    const started=await manager.start({
      command:"while (($line=[Console]::ReadLine()) -ne $null) { Write-Output ('private:'+ $line); if ($line -eq 'quit') { break } }",
      shell:'powershell',ui_target:'private_desktop',
      name:'nexowire-private-interactive',
      durable:false,
    },new PathPolicy(['*']));
    sessionId=started.sessionId;
    assert.equal(started.durable,true);
    assert.equal(started.uiTarget,'private_desktop');
    assert.equal(started.desktopName,'NexowirePrivate');
    assert.equal(started.reattachable,true);
    assert.equal(started.interactive,true);
    await assert.rejects(fs.stat(path.join(options.workerRoot,sessionId,'init.json')),
      (error:unknown)=>typeof error==='object'&&error!==null&&'code' in error&&error.code==='ENOENT');
    const view=await executeWindowsPrivateDesktopCapability('windows.private_desktop.status',{});
    assert.equal((view as {data:{inputDesktop:string}}).data.inputDesktop,'Default');

    await manager.write({session_id:sessionId,input:'ping',append_newline:true});
    const deadline=Date.now()+15_000;
    let output='';
    let cursor=0;
    while(Date.now()<deadline && !output.includes('private:ping')){
      const read=await manager.read({session_id:sessionId,after_seq:cursor,wait_ms:250});
      cursor=read.nextSeq;
      output+=read.events.map(event=>event.text).join('');
    }
    assert.match(output,/private:ping/);
    await manager.shutdown();
    restored=new ProcessManager(options);
    await restored.initialize();
    assert.equal(restored.list().find(s=>s.sessionId===sessionId)?.reattachable,true);
    assert.equal(restored.list().find(s=>s.sessionId===sessionId)?.uiTarget,'private_desktop');
    const snapshot=await fs.readFile(options.stateFile,'utf8');
    assert.doesNotMatch(snapshot,/executionEnv|token|private:ping/);
    await restored.write({session_id:sessionId,input:'quit',append_newline:true});
    let done=false;
    for(let attempt=0;attempt<75;attempt++){
      const status=await restored.read({session_id:sessionId,after_seq:cursor,wait_ms:100});
      cursor=status.nextSeq;
      if(status.session.status==='exited'){done=true;break;}
    }
    assert.equal(done,true);
  }finally{
    await restored?.stopAll().catch(()=>undefined);
    await manager.stopAll().catch(()=>undefined);
    await restored?.shutdown().catch(()=>undefined);
    await manager.shutdown().catch(()=>undefined);
    await executeWindowsPrivateDesktopCapability('windows.private_desktop.stop',{}).catch(()=>undefined);
    if(oldRoot===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_DIR=oldRoot;
    if(oldShortcut===undefined)delete process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT;
    else process.env.NEXOWIRE_PRIVATE_DESKTOP_SKIP_SHORTCUT=oldShortcut;
    await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}).catch(()=>undefined);
  }
});
