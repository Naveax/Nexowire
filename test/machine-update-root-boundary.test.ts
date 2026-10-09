import test from 'node:test';
import assert from 'node:assert/strict';
import {
  trustedMachineUpdateRoot,
  renderMachineCutoverScript,
} from '../src/update/machine-update.js';

test('elevated machine updater accepts only the OS-owned ProgramData root',()=>{
  for(const candidate of ['C:\\ProgramData','C:\\ProgramData\\','c:\\programdata']){
    assert.equal(trustedMachineUpdateRoot(candidate),'C:\\ProgramData\\Nexowire');
  }
  for(const value of [
    '', '.', 'ProgramData',
    'C:\\Users\\Public', 'C:\\Users\\Admin\\ProgramData',
    'D:\\ProgramData','C:\\ProgramData\\Nexowire',
    'C:\\ProgramData\\..\\Users\\Public',
    'C:\\ProgramData\\..\\ProgramData',
    '\\\\attacker\\share','\\\\?\\C:\\ProgramData',
    '\\ProgramData','C:\\ProgramData-malicious',
  ]){
    assert.throws(()=>trustedMachineUpdateRoot(value),
      /MACHINE_UPDATE_UNTRUSTED_PROGRAMDATA_ROOT/,value);
  }
});

test('machine updater render refuses caller-selected ProgramData paths',()=>{
  const old=process.env.ProgramData;
  try{
    process.env.ProgramData='C:\\Users\\Public\\Writable';
    assert.throws(()=>renderMachineCutoverScript({
      version:'1.0.5',buildId:'1.0.5-012345abcdef',
      targetRoot:'C:\\ProgramData\\Nexowire\\versions\\1.0.5-012345abcdef',
    }),/MACHINE_UPDATE_UNTRUSTED_PROGRAMDATA_ROOT/);
    process.env.ProgramData='C:\\ProgramData';
    const script=renderMachineCutoverScript({
      version:'1.0.5',buildId:'1.0.5-012345abcdef',
      targetRoot:'C:\\ProgramData\\Nexowire\\versions\\1.0.5-012345abcdef',
    });
    assert.match(script,/C:\\ProgramData\\Nexowire\\update/);
    assert.doesNotMatch(script,/Users\\Public\\Writable/);
  }finally{
    if(old===undefined)delete process.env.ProgramData;
    else process.env.ProgramData=old;
  }
});
