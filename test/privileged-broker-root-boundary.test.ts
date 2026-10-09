import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
  assertProtectedBrokerTaskRoot,
  assertBrokerRootEntriesFlat,
  privilegedBrokerTaskStatus,
} from '../src/agent/privileged-broker-lifecycle.js';

test('elevated broker root must be fixed canonical ProgramData directory',()=>{
  for(const accepted of [
    'C:\\ProgramData\\Nexowire\\privileged-broker',
    'c:\\programdata\\NEXOWIRE\\PRIVILEGED-BROKER',
  ])assert.doesNotThrow(()=>assertProtectedBrokerTaskRoot(accepted));
  for(const value of [
    '', '.', 'privileged-broker', 'C:\\Users\\public\\nexowire',
    '\\\\attacker\\share\\privileged-broker',
    '\\\\?\\C:\\ProgramData\\Nexowire\\privileged-broker',
    'D:\\ProgramData\\Nexowire\\privileged-broker',
    'C:\\ProgramData\\Nexowire\\privileged-broker\\..',
    'C:\\ProgramData\\Nexowire\\privileged-broker-old',
    'C:\\ProgramData\\Nexowire',
  ])assert.throws(()=>assertProtectedBrokerTaskRoot(value),/PRIVILEGED_BROKER_UNTRUSTED_PROTECTED_ROOT/,value);
});
test('root deletion preflight accepts only flat known broker files',()=>{
  const flat=(name:string)=>({name,isFile:true,isSymbolicLink:false});
  assert.doesNotThrow(()=>assertBrokerRootEntriesFlat([]));
  assert.doesNotThrow(()=>assertBrokerRootEntriesFlat([
    flat('launch.ps1'),flat('task.json'),
  ]));
  for(const entry of [
    flat('unexpected.txt'),
    {name:'other-dir',isFile:false,isSymbolicLink:false},
    {name:'launch.ps1',isFile:false,isSymbolicLink:true},
    {name:'task.json',isFile:true,isSymbolicLink:true},
  ])assert.throws(()=>assertBrokerRootEntriesFlat([entry]),/PRIVILEGED_BROKER_UNSAFE_ROOT_CONTENTS/);
});
test('broker install and recursive uninstall check protected root BEFORE privileged mutation',()=>{
  const source=readFileSync(new URL('../src/agent/privileged-broker-lifecycle.ts',import.meta.url),'utf8');
  assert.ok(source.includes('const directory = rootDir(options);\n  await assertBrokerRootSafeToRemove(directory);'));
  assert.ok(source.includes('  const protectedRoot=rootDir(options);\n  await assertBrokerRootSafeToRemove(protectedRoot);'));
  assert.ok(source.includes('await assertBrokerRootSafeToRemove(protectedRoot);\n  await fs.rm(protectedRoot, {'));
  assert.ok(source.includes('if(!info.isDirectory()||info.isSymbolicLink())'));
  assert.ok(source.includes('assertBrokerRootEntriesFlat(entries.map('));
});
test('read-only broker status rejects user-provided root and ProgramData override',{
  skip:process.platform!=='win32',
},async()=>{
  await assert.rejects(()=>privilegedBrokerTaskStatus({
    taskName:'Nexowire Root Test',
    rootDir:'C:\\Users\\Public\\Writable\\broker',
  }),/PRIVILEGED_BROKER_UNTRUSTED_PROTECTED_ROOT/);
  await assert.rejects(()=>privilegedBrokerTaskStatus({
    taskName:'Nexowire Root Test',
    env:{ProgramData:'C:\\Users\\Public\\Writable'},
  }),/PRIVILEGED_BROKER_UNTRUSTED_PROTECTED_ROOT/);
});
