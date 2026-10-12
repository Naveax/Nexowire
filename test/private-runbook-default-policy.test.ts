import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {RunbookStore} from '../src/agent/runbook-store.js';
import {executeDurableRunbook} from '../src/agent/runbooks.js';

function validCallbacks(calls:Array<Record<string,unknown>>) {
  return {
    runTaskGraph:async(input:unknown)=>{
      calls.push(input as Record<string,unknown>);
      return {data:{ok:true,graphId:'private',summary:{
        total:1,succeeded:1,failed:0,blocked:0,
      }}};
    },
    runAssertions:async()=>{throw new Error('assertions not expected');},
  };
}

test('configured private AI target reaches nested runbook tasks without explicit ui_target',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-runbook-default-'));
  const old=process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT;
  try{
    process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT='private_desktop';
    const store=new RunbookStore({stateFile:path.join(root,'runbooks.json')});
    await store.initialize();
    const calls:Array<Record<string,unknown>>=[];
    const steps=[{id:'task',kind:'task_graph',task_graph:{
      ui_target:'headless',
      jobs:[{id:'echo',command:'echo private'}],
    }}];
    const result=await executeDurableRunbook({
      runbook_id:'default-private',
      steps,
    },store,validCallbacks(calls)) as {
      data:{ok:boolean;uiTarget:string;desktopName:string;specHash:string};
    };
    assert.equal(result.data.ok,true);
    assert.equal(result.data.uiTarget,'private_desktop');
    assert.equal(result.data.desktopName,'NexowirePrivate');
    assert.equal(calls.length,1);
    assert.equal(calls[0]?.ui_target,'private_desktop');
    assert.ok(result.data.specHash.length>30);

    // Changing env mode before resume must not silently route a prior runbook
    // onto a different desktop; checkpoint plan hash must reject it.
    process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT='headless';
    await assert.rejects(executeDurableRunbook({
      runbook_id:'default-private',resume:true,steps,
    },store,validCallbacks(calls)),(error:unknown)=>
      typeof error==='object'&&error!==null&&'code' in error&&
      error.code==='RUNBOOK_SPEC_MISMATCH');
    assert.equal(calls.length,1);
  }finally{
    if(old===undefined)delete process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT;
    else process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT=old;
    await fs.rm(root,{recursive:true,force:true});
  }
});

test('explicit headless override still wins over configured private default',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-runbook-explicit-'));
  const old=process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT;
  try{
    process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT='private_desktop';
    const store=new RunbookStore({stateFile:path.join(root,'state.json')});
    await store.initialize();
    const calls:Array<Record<string,unknown>>=[];
    const result=await executeDurableRunbook({
      runbook_id:'explicit-headless',
      ui_target:'headless',
      steps:[{id:'task',kind:'task_graph',task_graph:{
        jobs:[{id:'echo',command:'echo hello'}],
      }}],
    },store,validCallbacks(calls)) as {data:{uiTarget:string;desktopName?:string}};
    assert.equal(result.data.uiTarget,'headless');
    assert.equal(result.data.desktopName,undefined);
    assert.equal(calls.length,1);
    assert.equal(calls[0]?.ui_target,undefined);
  }finally{
    if(old===undefined)delete process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT;
    else process.env.NEXOWIRE_AI_UI_TARGET_DEFAULT=old;
    await fs.rm(root,{recursive:true,force:true});
  }
});
