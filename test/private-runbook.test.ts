import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {RunbookStore} from '../src/agent/runbook-store.js';
import {executeDurableRunbook} from '../src/agent/runbooks.js';

test('private runbook pins every nested task graph to NexowirePrivate and denies headless resume',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-private-runbook-'));
  try{
    const store=new RunbookStore({stateFile:path.join(root,'runbooks.json')});
    await store.initialize();
    const calls:Array<Record<string,unknown>>=[];
    const steps=[
      {id:'task',kind:'task_graph',task_graph:{
        ui_target:'headless', // Caller step must not override top-level isolation.
        jobs:[{id:'echo',command:'echo private'}],
      }},
    ];
    const run=async(ui_target:'headless'|'private_desktop',resume=false)=>
      await executeDurableRunbook({
        runbook_id:'private-run',
        steps,ui_target,resume,
      },store,{
        runTaskGraph:async(input)=>{
          calls.push(input as Record<string,unknown>);
          return {data:{ok:true,graphId:'rb-private',summary:{total:1,succeeded:1,failed:0,blocked:0}}};
        },
        runAssertions:async()=>{throw new Error('unexpected assertion');},
      }) as {data:{ok:boolean;specHash:string;uiTarget:string;desktopName?:string}};
    const result=await run('private_desktop');
    assert.equal(result.data.ok,true);
    assert.equal(result.data.uiTarget,'private_desktop');
    assert.equal(result.data.desktopName,'NexowirePrivate');
    assert.equal(calls.length,1);
    assert.equal(calls[0]?.ui_target,'private_desktop');
    assert.match(String(calls[0]?.graph_id),/^rb-[a-f0-9]{32}$/);
    await assert.rejects(run('headless',true),
      (error:unknown)=>typeof error==='object'&&error!==null&&
        'code' in error&&error.code==='RUNBOOK_SPEC_MISMATCH');
    assert.equal(calls.length,1,'mismatched mode must reject before dispatch');
  }finally{
    await fs.rm(root,{recursive:true,force:true});
  }
});

test('explicit headless mode does not change the preexisting runbook spec hash',async()=>{
  const hashes:string[]=[];
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-runbook-hash-'));
  try{
    for(const mode of ['implicit','headless'] as const){
      const store=new RunbookStore({
        stateFile:path.join(root,'runbook-'+mode+'.json'),
      });
      await store.initialize();
      const result=await executeDurableRunbook({
        runbook_id:'same-plan',
        ...(mode==='headless'?{ui_target:'headless'}:{}),
        steps:[{id:'check',kind:'assertions',assertions:{assertions:[]}}],
      },store,{
        runTaskGraph:async()=>{throw new Error('not called');},
        runAssertions:async()=>({data:{ok:true,passed:0,failed:0,skipped:0}}),
      }) as {data:{specHash:string}};
      hashes.push(result.data.specHash);
    }
    assert.equal(hashes.length,2);
    assert.equal(hashes[0],hashes[1]);
  }finally{
    await fs.rm(root,{recursive:true,force:true});
  }
});
