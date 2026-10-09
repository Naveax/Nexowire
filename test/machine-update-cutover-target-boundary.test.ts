import test from 'node:test';
import assert from 'node:assert/strict';
import {
  trustedMachineUpdateCutoverTarget,
  renderMachineCutoverScript,
} from '../src/update/machine-update.js';

const good={
  version:'1.0.5',
  buildId:'1.0.5-012345abcdef',
  targetRoot:'C:\\ProgramData\\Nexowire\\versions\\1.0.5-012345abcdef',
};

test('machine updater cutover uses exact versioned runtime root and build',()=>{
  const prev=process.env.ProgramData;
  try{
    process.env.ProgramData='C:\\ProgramData';
    assert.equal(trustedMachineUpdateCutoverTarget(good),good.targetRoot);
    assert.match(renderMachineCutoverScript(good),/Nexowire Privileged Broker/);
    assert.match(renderMachineCutoverScript(good),/C:\\ProgramData\\Nexowire\\versions\\1\.0\.5-012345abcdef/);
  }finally{
    if(prev===undefined)delete process.env.ProgramData;
    else process.env.ProgramData=prev;
  }
});
test('arbitrary runtime executable target and aliases cannot enter privileged machine cutover',()=>{
  const untrusted=[
    '', '.', good.targetRoot.toLowerCase(), good.targetRoot.toUpperCase(),
    good.targetRoot+'\\',good.targetRoot+'\\node_modules',
    good.targetRoot+'\\..',good.targetRoot+'\\..\\1.0.5-012345abcdef',
    good.targetRoot.replaceAll('\\','/'),
    'D:\\ProgramData\\Nexowire\\versions\\1.0.5-012345abcdef',
    'C:\\Users\\Public\\Writable\\1.0.5-012345abcdef',
    '\\\\server\\share\\Nexowire\\versions\\1.0.5-012345abcdef',
    '\\\\?\\C:\\ProgramData\\Nexowire\\versions\\1.0.5-012345abcdef',
    'C:\\ProgramData\\Nexowire\\versions\\1.0.5-ffffffffffff',
    'C:\\ProgramData\\Nexowire\\versions\\1.0.4-012345abcdef',
    'C:\\ProgramData\\Nexowire\\versions\\1.0.5-012345abcdef\\evil',
  ];
  for(const targetRoot of untrusted){
    assert.throws(()=>trustedMachineUpdateCutoverTarget({...good,targetRoot}),
      /MACHINE_UPDATE_UNTRUSTED_CUTOVER_TARGET/,targetRoot);
    assert.throws(()=>renderMachineCutoverScript({...good,targetRoot}),
      /MACHINE_UPDATE_UNTRUSTED_CUTOVER_TARGET/,targetRoot);
  }
});
test('mismatched or forged update version and build fail closed',()=>{
  for(const invalid of [
    {...good,version:'1.0.6'},
    {...good,version:'v1.0.5'},
    {...good,version:'1.0.5;Write-Output evil'},
    {...good,buildId:'1.0.6-012345abcdef'},
    {...good,buildId:'1.0.5-nothex'},
  ]){
    assert.throws(()=>renderMachineCutoverScript(invalid),
      /MACHINE_UPDATE_CUTOVER_ID_MISMATCH|Machine update/,
      JSON.stringify(invalid));
  }
});
test('ProgramData environment cannot redirect renderer to user-selected root',()=>{
  const previous=process.env.ProgramData;
  try{
    process.env.ProgramData='C:\\Users\\Public\\Writable';
    assert.throws(()=>trustedMachineUpdateCutoverTarget(good),
      /MACHINE_UPDATE_UNTRUSTED_PROGRAMDATA_ROOT/);
    assert.throws(()=>renderMachineCutoverScript(good),
      /MACHINE_UPDATE_UNTRUSTED_PROGRAMDATA_ROOT/);
  }finally{
    if(previous===undefined)delete process.env.ProgramData;
    else process.env.ProgramData=previous;
  }
});
