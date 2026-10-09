import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  windowsInputPowerShellEnvironment,
  executeWindowsInputCapability,
} from '../src/agent/windows-input.js';

test('Windows input subprocess rejects external interpreter/module search paths',()=>{
  const env=windowsInputPowerShellEnvironment();
  assert.equal(env.SystemRoot,'C:\\Windows');
  assert.equal(env.ComSpec,'C:\\Windows\\System32\\cmd.exe');
  assert.equal(env.PATH,'C:\\Windows\\System32;C:\\Windows');
  assert.equal(env.PSModulePath,'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
  assert.ok(Object.keys(env).every(key=>[
    'SystemRoot','windir','ComSpec','PATH','PSModulePath',
    'USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP',
  ].includes(key)),JSON.stringify(Object.keys(env)));
  for(const k of ['NODE_OPTIONS','NODE_PATH','GH_HOST','PSExecutionPolicyPreference']){
    assert.equal(env[k],undefined);
  }
});
test('Windows input shell refuses UNC/traversal/command delimiters in profile hints',()=>{
  const keys=['USERPROFILE','APPDATA','TEMP'] as const;
  const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  try{
    process.env.USERPROFILE='\\\\evil\\share';
    process.env.APPDATA='C:\\Users\\tester\\..\\AppData';
    process.env.TEMP='C:\\safe;malicious';
    const env=windowsInputPowerShellEnvironment();
    assert.equal(env.USERPROFILE,undefined);
    assert.equal(env.APPDATA,undefined);
    assert.equal(env.TEMP,undefined);
    process.env.TEMP='C:\\Users\\tester\\AppData\\Local\\Temp';
    assert.equal(windowsInputPowerShellEnvironment().TEMP,process.env.TEMP);
  }finally{
    for(const k of keys){
      const v=previous[k];
      if(v===undefined)delete process.env[k];else process.env[k]=v;
    }
  }
});
test('input subprocess pinned executable and bounded stdio',()=>{
  const src=readFileSync(new URL('../src/agent/windows-input.ts',import.meta.url),'utf8');
  assert.ok(src.includes("INPUT_POWERSHELL=INPUT_SYSTEM32+'\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe'"));
  assert.ok(src.includes('spawn(INPUT_POWERSHELL, args,'));
  assert.ok(src.includes('env:windowsInputPowerShellEnvironment()'));
  assert.ok(src.includes('cwd:INPUT_SYSTEM32'));
  assert.ok(src.includes('shell:false'));
  assert.ok(src.includes('totalBytes>2*1024*1024'));
  assert.ok(!src.includes("spawn('powershell.exe'"));
});
test('real Windows input rejects nonexistent window with fake PowerShell in PATH',{
  skip:process.platform!=='win32',
},async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'nx-input-shell-spoof-'));
  const fake=path.join(dir,'powershell.exe');
  writeFileSync(fake,'INVALID-EXECUTABLE-NOT-RUN');
  const oldPath=process.env.PATH;
  const oldMod=process.env.PSModulePath;
  try{
    process.env.PATH=dir+';'+(oldPath||'');
    process.env.PSModulePath=dir;
    await assert.rejects(
      ()=>executeWindowsInputCapability('windows.keyboard.type',{
        hwnd:'0x0',text:'synthetic-no-target',
      }),
      (error:unknown)=>typeof error==='object'&&error!==null&&
        'code' in error&&error.code==='WINDOW_NOT_FOUND',
    );
    assert.equal(readFileSync(fake,'utf8'),'INVALID-EXECUTABLE-NOT-RUN');
  }finally{
    if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;
    if(oldMod===undefined)delete process.env.PSModulePath;else process.env.PSModulePath=oldMod;
    rmSync(dir,{recursive:true,force:true});
  }
});
