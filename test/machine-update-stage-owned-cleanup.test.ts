import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertMachineUpdateOwnedStage} from '../src/update/machine-update.js';

const root='C:\\ProgramData\\Nexowire';
const stage=root+'\\update\\stage-1.0.5-012345abcdef-01234567-89ab-4def-8123-456789abcdef';

test('accepts only exact canonical randomly named stage under protected root',()=>{
  assert.doesNotThrow(()=>assertMachineUpdateOwnedStage(root,stage));
  for(const [source,other] of [
    ['wrong root','C:\\Users\\Public'],
    ['ProgramData environment alias','C:\\ProgramData\\Nexowire\\..\\Nexowire'],
    ['lowercase root','c:\\ProgramData\\Nexowire'],
  ]as const){
    assert.throws(()=>assertMachineUpdateOwnedStage(other,stage),
      /MACHINE_UPDATE_UNTRUSTED_STAGING_PATH/,source);
  }
});

test('rejects arbitrary recursive cleanup targets before any filesystem mutation',()=>{
  for(const value of [
    '', '.', root,root+'\\update',root+'\\versions',
    root+'\\hub-boot\\launch.ps1',
    root+'\\update\\stage-1.0.5-012345abcdef',
    root+'\\update\\stage-1.0.5-012345abcdef-invalid-uuid',
    root+'\\update\\..\\versions\\stage-1.0.5-012345abcdef-01234567-89ab-4def-8123-456789abcdef',
    'C:\\Users\\Public\\stage-1.0.5-012345abcdef-01234567-89ab-4def-8123-456789abcdef',
    '\\\\attacker\\share\\stage-1.0.5-012345abcdef-01234567-89ab-4def-8123-456789abcdef',
    '\\\\?\\C:\\ProgramData\\Nexowire\\update\\stage-1.0.5-012345abcdef-01234567-89ab-4def-8123-456789abcdef',
    stage+'\\extra',
    stage+'\\',
    stage.toUpperCase(),
  ]){
    assert.throws(()=>assertMachineUpdateOwnedStage(root,value),
      /MACHINE_UPDATE_UNTRUSTED_STAGING_PATH/,value);
  }
});

test('staging extraction always cleans on success and thrown errors, with a safety recheck',()=>{
  const source=readFileSync(new URL('../src/update/machine-update.ts',import.meta.url),'utf8');
  const fn=source.indexOf('async function extractVerifiedRuntime(');
  const stage=source.indexOf("  const staging = path.join(",fn);
  const tryStart=source.indexOf('  try {',stage);
  const writeZip=source.indexOf('await fs.writeFile(zipFile, zipBuffer)',stage);
  const extraction=source.indexOf('renderBoundedWindowsArchiveExtraction(zipFile,extract)',stage);
  const promotion=source.search(/await fs\.rename\(source,\s*target\)/);
  const cleanupFinally=source.indexOf('  } finally {',promotion);
  const cleanupGuard=source.indexOf('assertMachineUpdateOwnedStage(root,staging)',cleanupFinally);
  const trustRecheck=source.indexOf('assertMachineUpdateTreeProtectedBeforeWrite()',cleanupFinally);
  const cleanup=source.indexOf('await fs.rm(staging,',cleanupFinally);
  const nextFunction=source.indexOf('export function trustedMachineUpdateCutoverTarget(',cleanupFinally);
  assert.ok(stage>fn && tryStart>stage && writeZip>tryStart);
  assert.ok(extraction>writeZip && promotion>extraction);
  assert.ok(cleanupFinally>promotion && cleanupGuard>cleanupFinally);
  assert.ok(trustRecheck>cleanupGuard && cleanup>trustRecheck && cleanup<nextFunction);
  assert.match(source.slice(cleanupFinally,nextFunction),/recursive:true,force:true/);
  assert.match(source.slice(tryStart,nextFunction),/catch\(error\) \{\s*stageError=error/);
  assert.match(source.slice(cleanupFinally,nextFunction),/AggregateError\(\[stageError,cleanupError\]/);
  assert.match(source.slice(cleanupFinally,nextFunction),/MACHINE_UPDATE_STAGE_AND_CLEANUP_FAILED/);
});
