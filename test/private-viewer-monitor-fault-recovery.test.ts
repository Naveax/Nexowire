import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readLocalMonitorSelection} from '../src/agent/windows-private-viewer.js';

test('invalid local selection never starves capture; previous valid screen stays selected',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-viewer-selector-fault-'));
  const old=process.env.NEXOWIRE_PRIVATE_VIEWER_DIR;
  process.env.NEXOWIRE_PRIVATE_VIEWER_DIR=root;
  const file=path.join(root,'monitor-selection.request.json');
  let state:Parameters<typeof readLocalMonitorSelection>[0]={
    version:1,pid:999,startedAt:new Date().toISOString(),
    refreshMs:500,maxWidth:1280,maxHeight:720,maxBytes:4194304,
    topmost:false,selectedMonitorId:'\\\\.\\DISPLAY2',
    lastSelectionError:null,lastFrameAt:null,frameBytes:null,
    frameWidth:null,frameHeight:null,lastError:null,
  };
  try{
    assert.equal((await readLocalMonitorSelection(state)).selectedMonitorId,'\\\\.\\DISPLAY2');
    await fs.writeFile(file,'{ broken json','utf8');
    state=await readLocalMonitorSelection(state);
    assert.equal(state.selectedMonitorId,'\\\\.\\DISPLAY2');
    assert.match(state.lastSelectionError??'',/Invalid monitor selection/);
    await assert.rejects(fs.stat(file),{code:'ENOENT'});
    const afterNoRequest=await readLocalMonitorSelection(state);
    assert.equal(afterNoRequest.selectedMonitorId,'\\\\.\\DISPLAY2');

    await fs.writeFile(file,JSON.stringify({source:'monitor',monitor_id:'\\\\.\\DISPLAY1'}));
    state=await readLocalMonitorSelection(state);
    assert.equal(state.selectedMonitorId,'\\\\.\\DISPLAY1');
    assert.equal(state.lastSelectionError,null);

    await fs.writeFile(file,JSON.stringify({source:'monitor',monitor_id:'',extra:true}));
    state=await readLocalMonitorSelection(state);
    assert.equal(state.selectedMonitorId,'\\\\.\\DISPLAY1');
    assert.match(state.lastSelectionError??'',/Invalid monitor selection/);

    await fs.writeFile(file,JSON.stringify({source:'desktop'}));
    state=await readLocalMonitorSelection(state);
    assert.equal(state.selectedMonitorId,null);
    assert.equal(state.lastSelectionError,null);
  }finally{
    if(old===undefined)delete process.env.NEXOWIRE_PRIVATE_VIEWER_DIR;
    else process.env.NEXOWIRE_PRIVATE_VIEWER_DIR=old;
    await fs.rm(root,{recursive:true,force:true});
  }
});

test('unreadable local monitor request reports an error and retains the last valid target',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nx-viewer-selector-unreadable-'));
  const old=process.env.NEXOWIRE_PRIVATE_VIEWER_DIR;
  process.env.NEXOWIRE_PRIVATE_VIEWER_DIR=root;
  const file=path.join(root,'monitor-selection.request.json');
  try{
    await fs.mkdir(file);
    const state:Parameters<typeof readLocalMonitorSelection>[0]={
      version:1,pid:99,startedAt:'now',refreshMs:500,
      maxWidth:1280,maxHeight:720,maxBytes:4194304,topmost:false,
      selectedMonitorId:'DISPLAY1',lastSelectionError:null,
      lastFrameAt:null,frameBytes:null,frameWidth:null,frameHeight:null,lastError:null,
    };
    const next=await readLocalMonitorSelection(state);
    assert.equal(next.selectedMonitorId,'DISPLAY1');
    assert.match(next.lastSelectionError??'',/Cannot read/);
  }finally{
    if(old===undefined)delete process.env.NEXOWIRE_PRIVATE_VIEWER_DIR;
    else process.env.NEXOWIRE_PRIVATE_VIEWER_DIR=old;
    await fs.rm(root,{recursive:true,force:true});
  }
});

test('WPF shows selection error separately from capture errors',async()=>{
  const script=await fs.readFile(new URL('../src/agent/windows-private-viewer.ts',import.meta.url),'utf8');
  assert.match(script,/MONITOR SELECTION ERROR:/);
  assert.match(script,/lastSelectionError/);
});
