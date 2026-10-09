import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  privateDesktopPowerShellEnvironment,
} from '../src/agent/windows-private-desktop.js';

test('Private Desktop internal PowerShell child excludes caller executable/module hooks',()=>{
  const previous=Object.fromEntries(['PATH','PSModulePath','NODE_OPTIONS','TEMP','APPDATA'].map(k=>[k,process.env[k]]));
  try{
    process.env.PATH='C:\\Users\\attacker\\bin';
    process.env.PSModulePath='C:\\Users\\attacker\\modules';
    process.env.NODE_OPTIONS='--require C:\\Users\\attacker\\inject.js';
    process.env.TEMP='\\\\attacker\\share';
    process.env.APPDATA='C:\\Users\\attacker\\..\\AppData';
    const env=privateDesktopPowerShellEnvironment();
    assert.equal(env.PATH,'C:\\Windows\\System32;C:\\Windows');
    assert.equal(env.PSModulePath,'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
    assert.equal(env.TEMP,undefined);
    assert.equal(env.APPDATA,undefined);
    assert.equal(env.NODE_OPTIONS,undefined);
    assert.ok(Object.keys(env).every(k=>[
      'SystemRoot','windir','ComSpec','PATH','PSModulePath',
      'USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP',
    ].includes(k)));
  }finally{
    for(const [k,v] of Object.entries(previous)){
      if(v===undefined)delete process.env[k];else process.env[k]=v;
    }
  }
});

test('Private Desktop fixed interpreter used for host, helper, GUI shell, private input and shortcut',()=>{
  const src=readFileSync(new URL('../src/agent/windows-private-desktop.ts',import.meta.url),'utf8');
  assert.ok(src.includes("PRIVATE_DESKTOP_POWERSHELL=PRIVATE_DESKTOP_SYSTEM32+'\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe'"));
  assert.ok(src.includes("spawn(PRIVATE_DESKTOP_POWERSHELL, ['-NoLogo'"));
  assert.ok(src.includes("launch(\n      PRIVATE_DESKTOP_POWERSHELL,"));
  assert.ok(src.includes("shellPid=await launch(PRIVATE_DESKTOP_POWERSHELL,"));
  assert.ok(src.includes("const host=spawn(PRIVATE_DESKTOP_POWERSHELL,"));
  assert.ok(src.includes('env:privateDesktopPowerShellEnvironment()'));
  assert.ok(src.includes("TargetPath='C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe'"));
  assert.ok(!src.includes("spawn('powershell.exe'"));
  assert.ok(!src.includes("launch('powershell.exe'"));
});
