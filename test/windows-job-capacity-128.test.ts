import test from 'node:test';
import assert from 'node:assert/strict';
import {ProcessManager} from '../src/agent/process-manager.js';
import {PathPolicy} from '../src/agent/path-policy.js';

test('Windows physical 128-session retention/reclaim budget with owned Job guardians', {
  skip:process.platform!=='win32',
  timeout:180_000,
}, async () => {
  const manager=new ProcessManager({maxSessions:128,exitedRetentionMs:120_000});
  const policy=new PathPolicy(['*']);
  const ids:string[]=[];
  try{
    for(let group=0;group<16;group++){
      // Bounded parallelism avoids 128 simultaneous shells while still
      // checking the 128-slot retention accounting and native Job ownership.
      const wave=await Promise.all(Array.from({length:8},()=>manager.start({
        command:'exit /b 0',shell:'cmd',
      },policy)));
      for(const started of wave){
        assert.equal(started.treeOwnership,'windows_job');
        ids.push(started.sessionId);
      }
    }
    assert.equal(ids.length,128);
    assert.equal(manager.list().length,128);
    for(let attempt=0;attempt<50;attempt++){
      if(manager.list().every(x=>x.status==='exited'))break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(manager.list().every(x=>x.status==='exited'),'all 128 synthetic shells must exit');
    const replacement=await manager.start({command:'exit /b 0',shell:'cmd'},policy);
    assert.equal(replacement.treeOwnership,'windows_job');
    assert.equal(manager.list().length,128,'129th start must safely reclaim one exited slot');
    assert.equal(manager.list().some(x=>x.sessionId===replacement.sessionId),true);
    assert.equal(ids.filter(id=>manager.list().some(x=>x.sessionId===id)).length,127,
      'exactly one safely exited session must be reclaimed');
    const pruned=await manager.prune({older_than_ms:0});
    assert.ok(pruned.removed>0);
  } finally {
    await manager.shutdown();
  }
});
