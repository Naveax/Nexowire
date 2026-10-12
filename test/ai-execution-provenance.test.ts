import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {executeCapability} from '../src/agent/executors.js';
import {PathPolicy} from '../src/agent/path-policy.js';

test('shell.exec reports explicit headless execution provenance',async()=>{
  const shell=process.platform==='win32'?'powershell':'bash';
  const command=process.platform==='win32'
    ?"[Console]::Write('headless-provenance')"
    :"printf headless-provenance";
  const result=await executeCapability('shell.exec',{
    shell,command,ui_target:'headless',timeout_ms:15_000,
  },new PathPolicy(['*'])) as {
    stdout:string;exitCode:number|null;
    data:{timedOut:boolean;uiTarget:string;desktopName?:string};
  };
  assert.equal(result.exitCode,0);
  assert.equal(result.stdout,'headless-provenance');
  assert.equal(result.data.uiTarget,'headless');
  assert.equal(result.data.desktopName,undefined);
});

test('workspace.checks reports headless destination without inventing a private desktop',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexowire-target-provenance-'));
  try{
    await fs.writeFile(path.join(root,'package.json'),JSON.stringify({
      name:'target-provenance',scripts:{
        test:'node -e "console.log(\'provenance-ok\')"',
      },
    }));
    const result=await executeCapability('workspace.checks',{
      path:root,ui_target:'headless',
      checks:['node:test'],parallel:false,timeout_ms:20_000,
    },new PathPolicy([root])) as {
      data:{
        ok:boolean;uiTarget:string;desktopName?:string;passed:number;
        results:Array<{stdout:string}>;
      };
    };
    assert.equal(result.data.ok,true,JSON.stringify(result.data.results));
    assert.equal(result.data.passed,1);
    assert.equal(result.data.uiTarget,'headless');
    assert.equal(result.data.desktopName,undefined);
    assert.match(result.data.results[0]?.stdout??'',/provenance-ok/);
  }finally{
    await fs.rm(root,{recursive:true,force:true});
  }
});
