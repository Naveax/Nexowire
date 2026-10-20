import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,unlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {executeCapability} from '../src/agent/executors.js';
import {PathPolicy} from '../src/agent/path-policy.js';
import {TaskGraphStore} from '../src/agent/task-graph-store.js';

test('negative: an artifact changed without changing its byte count must not verify',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'qa16-artifact-tamper-'));
 t.after(()=>rm(dir,{force:true,recursive:true}));
 const artifact=path.join(dir,'output.txt');
 const store=new TaskGraphStore({stateFile:path.join(dir,'state.json')});
 const policy=new PathPolicy([dir]);
 await store.initialize();
 const cmd=process.platform==='win32'
  ? "Set-Content -LiteralPath 'output.txt' -Value 'GOOD' -NoNewline"
  : "printf 'GOOD' > output.txt";
 const result=await executeCapability('task.graph.run',{
  graph_id:'qa16-artifact',
  jobs:[{id:'produce',shell:process.platform==='win32'?'pwsh':'bash',
   cwd:dir,command:cmd,artifacts:['output.txt']}],
 },policy,{taskGraphs:store}) as {data:{ok:boolean}};
 assert.equal(result.data.ok,true,'fixture producer must succeed first');
 await writeFile(artifact,'EVIL','utf8');
 const modified=await executeCapability('task.artifact.verify',
  {graph_id:'qa16-artifact'},policy,{taskGraphs:store}) as {
   data:{ok:boolean;summary:{changed:number};artifacts:Array<{status:string}>}
  };
 assert.equal(modified.data.ok,false,'a stale digest never constitutes proof');
 assert.equal(modified.data.summary.changed,1);
 assert.equal(modified.data.artifacts[0]?.status,'changed');
 await unlink(artifact);
 const missing=await executeCapability('task.artifact.verify',
  {graph_id:'qa16-artifact'},policy,{taskGraphs:store}) as {
   data:{ok:boolean;summary:{missing:number};artifacts:Array<{status:string}>}
  };
 assert.equal(missing.data.ok,false);
 assert.equal(missing.data.summary.missing,1);
 assert.equal(missing.data.artifacts[0]?.status,'missing');
});
